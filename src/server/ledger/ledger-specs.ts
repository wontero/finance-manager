import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../database.js";
import { localDatabase } from "../scripts/local-database.js";
import { createLedger } from "./index.js";

const date = "2028-01-10";
const name = (prefix: string) => `${prefix} ${randomUUID()}`;

export function ledgerSpecs(
  connections: () => { migration: PoolConnection; reader: PoolConnection },
) {
  describe("M-004: accounting services", () => {
    let db: ReturnType<typeof createDatabase>["db"];
    let ledger: ReturnType<typeof createLedger>;
    let cash: string;
    let dollars: string;
    let food: string;
    let expenses: string;
    let income: string;
    let clearing: string;
    let opening: string;
    let adjustment: string;

    const rows = async (query: string, values: string[] = []) =>
      (
        await connections().migration.execute<RowDataPacket[]>(query, values)
      )[0];
    const transactions = (id: string) =>
      rows("SELECT * FROM transactions WHERE id = ?", [id]);
    const postings = (id: string) =>
      rows("SELECT * FROM postings WHERE transaction_id = ? ORDER BY id", [id]);
    const audit = (id: string) =>
      rows("SELECT * FROM audit_log WHERE operation_id = ? ORDER BY id", [id]);
    const category = async (parentId = expenses) =>
      (await ledger.createCategory({ name: name("Categoría"), parentId })).id;
    const account = async (currency = "BOB") =>
      (
        await ledger.createAccount({
          name: name("Efectivo"),
          kind: "asset",
          subtype: "efectivo",
          currency,
        })
      ).id;
    const draft = (amount = "45,00", when = date) => ({
      date: when,
      description: "Almuerzo",
      lines: [
        { accountId: cash, currency: "BOB", side: "credit" as const, amount },
        { accountId: food, currency: "BOB", side: "debit" as const, amount },
      ],
    });
    const expense = (amount = "45,00") =>
      ledger.recordExpense({
        accountId: cash,
        categoryId: food,
        amount,
        date,
        description: "Almuerzo",
      });
    const counts = async () =>
      Promise.all(
        [
          "accounts",
          "operations",
          "transactions",
          "postings",
          "audit_log",
          "tags",
          "transaction_tags",
          "custom_field_definitions",
          "exchange_rates",
        ].map(
          async (table) =>
            (await rows(`SELECT COUNT(*) AS count FROM ${table}`))[0].count,
        ),
      );
    const withoutUpdatedAt = (items: RowDataPacket[]) =>
      items.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== "updated_at"),
        ),
      );

    beforeAll(async () => {
      db = createDatabase({
        ...localDatabase("DATABASE_URL"),
        database: "finance_test",
      }).db;
      ledger = createLedger(db, "web");
      const system = Object.fromEntries(
        (await rows("SELECT id, name FROM accounts WHERE is_system")).map(
          (row) => [row.name, row.id as string],
        ),
      );
      expenses = system.Gastos;
      income = system.Ingresos;
      clearing = system["Cambio de moneda"];
      opening = system["Saldos iniciales"];
      adjustment = system["Ajustes de conciliación"];
      cash = await account();
      dollars = await account("USD");
      food = await category();
    });

    afterAll(async () => db?.destroy());

    test("S3: invalid journal entries leave no rows", async () => {
      const valid = draft();
      const [credit, debit] = valid.lines;
      const invalid = [
        [credit, { ...debit, amount: "3" }],
        [credit],
        [credit, debit, { ...debit, amount: "0" }],
        [...valid.lines, { ...debit, currency: "USD" }],
      ];
      const before = await counts();
      for (const lines of invalid)
        await expect(
          ledger.createTransaction({ ...valid, lines }),
        ).rejects.toThrow();
      expect(await counts()).toEqual(before);
    });

    test("S4: reject currency mismatches, archived accounts and category roots", async () => {
      const archived = await account();
      await ledger.archiveAccount({ id: archived });
      const valid = draft();
      const [credit, debit] = valid.lines;
      for (const [lines, error] of [
        [
          [
            { ...credit, currency: "USD" },
            { ...debit, currency: "USD" },
          ],
          /moneda/i,
        ],
        [[{ ...credit, accountId: archived }, debit], /archivada/i],
        [[credit, { ...debit, accountId: expenses }], /raíz/i],
        [[credit, { ...debit, accountId: income }], /raíz/i],
      ] as const)
        await expect(
          ledger.createTransaction({ ...valid, lines: [...lines] }),
        ).rejects.toThrow(error);
    });

    test("S5: record an expense with complete audit rows", async () => {
      const result = await expense();
      const lines = await postings(result.id);
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account_id: cash,
            amount: "-4500",
            currency: "BOB",
          }),
          expect.objectContaining({
            account_id: food,
            amount: "4500",
            currency: "BOB",
          }),
        ]),
      );
      expect(
        await rows("SELECT * FROM operations WHERE id = ?", [
          result.operationId,
        ]),
      ).toEqual([
        expect.objectContaining({ actor: "web", undoes_operation_id: null }),
      ]);
      const log = await audit(result.operationId);
      expect(
        log.map((row) => [row.action, row.before, JSON.parse(row.after)]),
      ).toEqual([
        ["insert", null, (await transactions(result.id))[0]],
        ...lines.map((line) => ["insert", null, line]),
      ]);
    });

    test("S6: transfer the actual amounts through the clearing account", async () => {
      const from = await account("USD");
      const to = await account();
      const result = await ledger.transfer({
        fromAccountId: from,
        toAccountId: to,
        amount: "100,00",
        receivedAmount: "696,00",
        date,
        description: "Cambio",
      });
      expect(
        (await postings(result.id)).map((row) => [
          row.account_id,
          row.currency,
          row.amount,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [from, "USD", "-10000"],
          [clearing, "USD", "10000"],
          [clearing, "BOB", "-69600"],
          [to, "BOB", "69600"],
        ]),
      );
      expect(await postings(result.id)).toHaveLength(4);
      expect(await ledger.getBalance({ id: from, date })).toMatchObject({
        amount: -10000n,
        currency: "USD",
      });
      expect(await ledger.getBalance({ id: to, date })).toMatchObject({
        amount: 69600n,
        currency: "BOB",
      });
    });

    test("S7: open assets and liabilities with the correct natural balance", async () => {
      for (const [classification, amount, balance, offset] of [
        [{ kind: "asset", subtype: "banco" }, "500,00", 50000n, "-50000"],
        [
          { kind: "liability", subtype: "tarjeta_credito" },
          "300,00",
          30000n,
          "30000",
        ],
      ] as const) {
        const result = await ledger.createAccount({
          name: name("Apertura"),
          ...classification,
          currency: "BOB",
          opening: { amount, date },
        });
        expect(await ledger.getBalance({ id: result.id, date })).toMatchObject({
          amount: balance,
        });
        const entries = await rows(
          "SELECT * FROM transactions WHERE operation_id = ?",
          [result.operationId],
        );
        expect(entries).toEqual([expect.objectContaining({ date })]);
        expect(await postings(entries[0].id)).toContainEqual(
          expect.objectContaining({ account_id: opening, amount: offset }),
        );
      }
    });

    test("S8: reconcile the exact difference and skip a matched balance", async () => {
      const id = await account();
      await ledger.reconcile(id, "10,00", date);
      const second = await ledger.reconcile(id, "8,99", date);
      expect(await postings(second!.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account_id: id, amount: "-101" }),
          expect.objectContaining({ account_id: adjustment, amount: "101" }),
        ]),
      );
      const before = await counts();
      expect(await ledger.reconcile(id, "8,99", date)).toBeNull();
      expect(await counts()).toEqual(before);
    });

    test("S9: enforce account tree, system account and archive constraints", async () => {
      const parent = await category();
      const child = await category(parent);
      await expect(
        ledger.moveAccount({ id: parent, parentId: child }),
      ).rejects.toThrow(/ciclo/i);
      await expect(
        ledger.moveAccount({ id: parent, parentId: income }),
      ).rejects.toThrow(/tipo/i);
      await expect(
        ledger.moveAccount({ id: expenses, parentId: income }),
      ).rejects.toThrow(/sistema/i);
      await expect(
        ledger.renameAccount({ id: opening, name: "Otro nombre" }),
      ).rejects.toThrow(/sistema/i);
      await expect(ledger.archiveAccount({ id: expenses })).rejects.toThrow(
        /sistema/i,
      );
      await expect(ledger.archiveAccount({ id: parent })).rejects.toThrow(
        /hijas/i,
      );
      const id = await account();
      await ledger.reconcile(id, "1", date);
      await expect(ledger.archiveAccount({ id })).rejects.toThrow(/saldo/i);
    });

    test("S10: merge reassigns postings and children, and undo restores both", async () => {
      const source = await category();
      const target = await category();
      const child = await category(source);
      const { id } = await ledger.recordExpense({
        accountId: cash,
        categoryId: source,
        amount: "11",
        date,
        description: "Fusión",
      });
      const accountsBefore = await rows(
        "SELECT * FROM accounts WHERE id IN (?, ?, ?) ORDER BY id",
        [source, target, child],
      );
      const linesBefore = await postings(id);
      const merge = await ledger.mergeCategories({
        sourceId: source,
        targetId: target,
      });
      expect(
        (await rows("SELECT * FROM accounts WHERE id = ?", [source]))[0]
          .archived_at,
      ).not.toBeNull();
      expect(
        (await rows("SELECT parent_id FROM accounts WHERE id = ?", [child]))[0]
          .parent_id,
      ).toBe(target);
      expect(await postings(id)).toContainEqual(
        expect.objectContaining({ account_id: target }),
      );
      expect(
        await ledger.getCategoryTotals({ id: target, from: date, to: date }),
      ).toEqual([{ currency: "BOB", amount: 1100n }]);
      await ledger.undoOperation(merge.operationId);
      expect(
        withoutUpdatedAt(
          await rows(
            "SELECT * FROM accounts WHERE id IN (?, ?, ?) ORDER BY id",
            [source, target, child],
          ),
        ),
      ).toEqual(withoutUpdatedAt(accountsBefore));
      expect(await postings(id)).toEqual(linesBefore);
    });

    test("S11: replace lines atomically and hide deleted entries from balances and views", async () => {
      const before = (await ledger.getBalance({ id: cash, date })).amount;
      const result = await expense();
      const original = await postings(result.id);
      const edit = await ledger.editTransaction({
        id: result.id,
        description: "Cena",
        lines: draft("25").lines,
      });
      const lines = await postings(result.id);
      expect(lines.map((line) => line.amount)).toEqual(["-2500", "2500"]);
      const log = await audit(edit.operationId!);
      expect(log).toContainEqual(
        expect.objectContaining({
          table_name: "transactions",
          before: expect.stringContaining("Almuerzo"),
          after: expect.stringContaining("Cena"),
        }),
      );
      expect(
        log
          .filter((row) => row.action === "delete")
          .map((row) => JSON.parse(row.before)),
      ).toEqual(original);
      expect(
        log
          .filter((row) => row.action === "insert")
          .map((row) => JSON.parse(row.after)),
      ).toEqual(lines);
      const invalid = draft("4").lines;
      invalid[0].amount = "3";
      const countsBefore = await counts();
      await expect(
        ledger.editTransaction({ id: result.id, lines: invalid }),
      ).rejects.toThrow();
      expect(await postings(result.id)).toEqual(lines);
      expect(await counts()).toEqual(countsBefore);
      expect((await ledger.getBalance({ id: cash, date })).amount).toBe(
        before - 2500n,
      );
      await ledger.deleteTransaction({ id: result.id });
      expect((await ledger.getBalance({ id: cash, date })).amount).toBe(before);
      expect(
        (
          await connections().reader.execute(
            "SELECT id FROM v_transactions WHERE id = ?",
            [result.id],
          )
        )[0],
      ).toEqual([]);
    });

    test("S12: undo restores complete row contents, including original IDs", async () => {
      const created = await ledger.createTransaction({
        ...draft(),
        note: "Nota original",
        tags: [name("Original")],
      });
      const original = await transactions(created.id);
      const originalLines = await postings(created.id);
      const originalTags = await rows(
        "SELECT * FROM transaction_tags WHERE transaction_id = ?",
        [created.id],
      );
      const edit = await ledger.editTransaction({
        id: created.id,
        note: "Otra nota",
        lines: draft("14").lines,
        tags: [name("Nueva")],
      });
      const deletion = await ledger.deleteTransaction({ id: created.id });
      const restored = await ledger.undoOperation(deletion.operationId);
      expect(
        await rows("SELECT undoes_operation_id FROM operations WHERE id = ?", [
          restored.operationId,
        ]),
      ).toEqual([{ undoes_operation_id: deletion.operationId }]);
      expect(await audit(restored.operationId)).toEqual([
        expect.objectContaining({
          table_name: "transactions",
          action: "update",
        }),
      ]);
      await ledger.undoOperation(edit.operationId!);
      expect(withoutUpdatedAt(await transactions(created.id))).toEqual(
        withoutUpdatedAt(original),
      );
      expect(await postings(created.id)).toEqual(originalLines);
      expect(
        await rows("SELECT * FROM transaction_tags WHERE transaction_id = ?", [
          created.id,
        ]),
      ).toEqual(originalTags);
      await ledger.undoOperation(created.operationId);
      expect(await transactions(created.id)).toEqual([]);
      expect(await postings(created.id)).toEqual([]);
      expect(
        await rows("SELECT * FROM transaction_tags WHERE transaction_id = ?", [
          created.id,
        ]),
      ).toEqual([]);
      expect(
        await rows("SELECT * FROM tags WHERE id = ?", [originalTags[0].tag_id]),
      ).toEqual([]);
    });

    test("S13: redo, identify later changes and reject a concurrent second undo", async () => {
      const created = await expense();
      const original = await transactions(created.id);
      const edit = await ledger.editTransaction({
        id: created.id,
        note: "Cambio posterior",
      });
      await expect(ledger.undoOperation(created.operationId)).rejects.toThrow(
        edit.operationId,
      );
      const { operationId } = await ledger.undoOperation(edit.operationId!);
      expect(withoutUpdatedAt(await transactions(created.id))).toEqual(
        withoutUpdatedAt(original),
      );
      await expect(ledger.undoOperation(edit.operationId!)).rejects.toThrow(
        /deshecha/i,
      );
      await ledger.undoOperation(operationId);
      expect((await transactions(created.id))[0].note).toBe("Cambio posterior");
      const next = await expense();
      const results = await Promise.allSettled([
        ledger.undoOperation(next.operationId),
        ledger.undoOperation(next.operationId),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(
        await rows("SELECT id FROM operations WHERE undoes_operation_id = ?", [
          next.operationId,
        ]),
      ).toHaveLength(1);
      expect(await ledger.listOperations({ limit: 1 })).toEqual([
        expect.objectContaining({
          seq: expect.any(String),
          actor: "web",
          description: expect.any(String),
          undone: false,
        }),
      ]);
    });

    test("S13: a later independent edit still blocks undo if it put the old value back", async () => {
      const created = await expense();
      await ledger.editTransaction({ id: created.id, note: "Corrección" });
      const later = await ledger.editTransaction({
        id: created.id,
        note: null,
      });
      const before = await counts();
      await expect(ledger.undoOperation(created.operationId)).rejects.toThrow(
        later.operationId!,
      );
      expect(await counts()).toEqual(before);
    });

    test("S9/S13: undo cannot create an account cycle through a later move", async () => {
      const initialParent = await category();
      const child = await category(initialParent);
      const move = await ledger.moveAccount({ id: child, parentId: expenses });
      const later = await ledger.moveAccount({
        id: initialParent,
        parentId: child,
      });
      const before = await counts();
      await expect(ledger.undoOperation(move.operationId)).rejects.toThrow(
        later.operationId,
      );
      expect(await counts()).toEqual(before);
      expect(
        await rows("SELECT parent_id FROM accounts WHERE id = ?", [child]),
      ).toEqual([{ parent_id: expenses }]);
    });

    test("S14: import one atomic batch with optional duplicate skipping and undo", async () => {
      const duplicate = draft("37");
      const existing = await ledger.createTransaction(duplicate);
      const batch = [
        draft("38"),
        { ...duplicate, lines: [...duplicate.lines].reverse() },
        draft("39"),
      ];
      const skip = await ledger.importBatch(batch, { duplicates: "skip" });
      expect(skip.created).toHaveLength(2);
      expect(skip.skipped).toEqual([{ index: 1, existingId: existing.id }]);
      expect(
        await rows("SELECT id FROM transactions WHERE operation_id = ?", [
          skip.operationId!,
        ]),
      ).toHaveLength(2);
      await ledger.undoOperation(skip.operationId!);
      for (const id of skip.created)
        expect(await transactions(id)).toHaveLength(0);
      const include = await ledger.importBatch(batch, {
        duplicates: "include",
      });
      expect(include.created).toHaveLength(3);
      expect(include.skipped).toHaveLength(0);
      const before = await counts();
      const invalid = {
        ...duplicate,
        lines: [{ ...duplicate.lines[0], amount: "0" }, duplicate.lines[1]],
      };
      await expect(
        ledger.importBatch([draft("40"), invalid], { duplicates: "include" }),
      ).rejects.toThrow();
      expect(await counts()).toEqual(before);
    });

    test("S15: select a direct rate by date and source, with exact scale", async () => {
      const pair = { from: "USD", to: "BOB" };
      const first = { ...pair, date: "2026-11-01" };
      await ledger.recordExchangeRate({
        ...first,
        rate: "6.93",
        source: "Zeta",
      });
      await ledger.recordExchangeRate({
        ...first,
        rate: "6.94",
        source: "Alfa",
      });
      expect(
        await ledger.getExchangeRate({ ...pair, date: "2026-11-05" }),
      ).toMatchObject({ rate: "6.9400000000", source: "Alfa" });
      await ledger.recordExchangeRate({
        ...first,
        rate: "6.96",
        source: "BCB referencial venta",
      });
      await ledger.recordExchangeRate({
        ...first,
        date: "2026-11-10",
        rate: "7",
        source: "Otra",
      });
      expect(
        await ledger.getExchangeRate({ ...pair, date: "2026-11-05" }),
      ).toMatchObject({
        rate: "6.9600000000",
        source: "BCB referencial venta",
      });
      await expect(
        ledger.getExchangeRate({ ...pair, date: "2026-10-31" }),
      ).rejects.toThrow(/sin tipo de cambio/i);
      await expect(
        ledger.getExchangeRate({ from: "BOB", to: "USD", date: "2026-11-05" }),
      ).rejects.toThrow(/sin tipo de cambio/i);
      await expect(
        ledger.recordExchangeRate({
          ...first,
          rate: "6.12345678901",
          source: "Otra",
        }),
      ).rejects.toThrow();
    });

    test("S16: net worth reports unavailable rates and rounds valued assets and liabilities", async () => {
      const when = "2000-01-01";
      const usd = await ledger.createAccount({
        name: name("USD"),
        kind: "asset",
        subtype: "banco",
        currency: "USD",
        opening: { amount: "0,01", date: when },
      });
      await ledger.createAccount({
        name: name("BOB"),
        kind: "asset",
        subtype: "banco",
        currency: "BOB",
        opening: { amount: "1,00", date: when },
      });
      await ledger.createAccount({
        name: name("Deuda"),
        kind: "liability",
        subtype: "tarjeta_credito",
        currency: "BOB",
        opening: { amount: "0,10", date: when },
      });
      expect(await ledger.getNetWorth({ date: when })).toMatchObject({
        amount: 90n,
        unvalued: expect.arrayContaining([
          expect.objectContaining({ id: usd.id, currency: "USD", amount: 1n }),
        ]),
      });
      await ledger.recordExchangeRate({
        from: "USD",
        to: "BOB",
        date: when,
        rate: "0.5",
        source: "Prueba",
      });
      expect(await ledger.getNetWorth({ date: when })).toEqual({
        amount: 91n,
        currency: "BOB",
        unvalued: [],
      });
    });

    test("S17: category totals include descendants, separated by currency and date", async () => {
      const parent = await category();
      const child = await category(parent);
      const grandchild = await category(child);
      for (const [accountId, categoryId, amount, when] of [
        [cash, parent, "1", date],
        [cash, child, "2", date],
        [dollars, grandchild, "3", date],
        [cash, child, "100", "2028-01-11"],
      ])
        await ledger.recordExpense({
          accountId,
          categoryId,
          amount,
          date: when,
          description: "Totales",
        });
      const entry = await ledger.recordExpense({
        accountId: cash,
        categoryId: parent,
        amount: "99",
        date,
        description: "Borrado",
      });
      await ledger.deleteTransaction({ id: entry.id });
      expect(
        await ledger.getCategoryTotals({ id: parent, from: date, to: date }),
      ).toEqual([
        { currency: "BOB", amount: 300n },
        { currency: "USD", amount: 300n },
      ]);
    });

    test("S18: custom values follow active definitions and tags reuse names case-insensitively", async () => {
      const entity = "transaction";
      const options = await ledger.defineCustomField({
        entity,
        key: "medio",
        label: "Medio",
        type: "option",
        options: ["tarjeta"],
      });
      await ledger.defineCustomField({
        entity,
        key: "puntos",
        label: "Puntos",
        type: "number",
      });
      await ledger.defineCustomField({
        entity,
        key: "fecha",
        label: "Fecha",
        type: "date",
      });
      const archived = await ledger.defineCustomField({
        entity,
        key: "anterior",
        label: "Anterior",
        type: "text",
      });
      await ledger.archiveCustomField({ id: archived.id });
      const invalidValues: Record<string, string | number>[] = [
        { medio: "otro" },
        { puntos: "3" },
        { fecha: "2026-02-30" },
        { desconocida: "x" },
        { anterior: "x" },
      ];
      for (const custom of invalidValues)
        await expect(
          ledger.createTransaction({ ...draft(), custom }),
        ).rejects.toThrow();
      const custom = { medio: "tarjeta", puntos: 3, fecha: date };
      const first = await ledger.createTransaction({
        ...draft(),
        custom,
        tags: ["Viaje", "viaje"],
      });
      const second = await ledger.createTransaction({
        ...draft(),
        tags: ["viaje"],
      });
      expect(JSON.parse((await transactions(first.id))[0].custom)).toEqual(
        custom,
      );
      expect(
        JSON.parse(
          JSON.parse((await audit(first.operationId))[0].after).custom,
        ),
      ).toEqual(custom);
      const links = await rows(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id IN (?, ?) ORDER BY transaction_id",
        [first.id, second.id],
      );
      expect(links).toHaveLength(2);
      expect(links[0]).toEqual(links[1]);
      expect(
        await rows("SELECT * FROM tags WHERE id = ?", [links[0].tag_id]),
      ).toEqual([{ id: links[0].tag_id, name: "Viaje" }]);
      await ledger.archiveCustomField({ id: options.id });
      await expect(
        ledger.editTransaction({ id: first.id, custom }),
      ).rejects.toThrow();
      await ledger.defineCustomField({
        entity: "account",
        key: "alias",
        label: "Alias",
        type: "text",
      });
      await expect(
        ledger.setAccountCustom({ id: cash, custom: { alias: 1 } }),
      ).rejects.toThrow();
      const change = await ledger.setAccountCustom({
        id: cash,
        custom: { alias: "Billetera" },
      });
      expect(
        JSON.parse(
          JSON.parse((await audit(change.operationId))[0].after).custom,
        ),
      ).toEqual({ alias: "Billetera" });
    });

    test("S19: a real mid-write audit failure rolls back domain rows and the operation", async () => {
      const migration = connections().migration;
      await migration.query(`CREATE TRIGGER ledger_s19 BEFORE INSERT ON audit_log FOR EACH ROW
        BEGIN IF NEW.table_name = 'postings' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fallo forzado M-004 S19';
        END IF; END`);
      try {
        const before = await counts();
        await expect(expense()).rejects.toThrow("Fallo forzado M-004 S19");
        expect(await counts()).toEqual(before);
      } finally {
        await migration.query("DROP TRIGGER ledger_s19");
      }
    });
  });
}
