import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { sql, type Kysely } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { digest, type AuthDb } from "./auth-store.js";
import { readConfig } from "./config.js";
import { dashboardApi } from "./dashboard-http.js";
import { createDatabase } from "./database.js";
import { createLedger, provisionUser } from "./ledger/index.js";
import { ledgerLimits } from "./ledger/limits.js";
import { createMcp } from "./mcp/index.js";
import { localDatabase } from "./scripts/local-database.js";

const date = "1997-11-11";
const limits = { accounts: 20, tags: 1, dailyTransactions: 3 };
const accountInput = {
  kind: "asset",
  subtype: "efectivo",
  currency: "BOB",
} as const;
const field = {
  entity: "transaction",
  key: "proyecto",
  label: "Proyecto",
  type: "text",
} as const;

async function seed(
  db: Kysely<unknown>,
  userId: string,
  name: string,
  amount: string,
) {
  const ledger = createLedger(db, "web", userId);
  const tree = await ledger.getAccountTree(false);
  const parentId = tree.find(({ name }) => name === "Gastos")!.id;
  const category = (await ledger.createCategory({ parentId, name })).id;
  const cash = (await ledger.createAccount({ ...accountInput, name })).id;
  const definition = await ledger.defineCustomField({ ...field, key: name });
  const entry = await ledger.recordExpense({
    accountId: cash,
    categoryId: category,
    amount,
    date,
    description: name,
    tags: [name],
    custom: { [name]: name },
  });
  const loan = await ledger.registerLoan({
    direction: "given",
    counterparty: name,
    amount: "100",
    currency: "BOB",
    date,
    rate: "0",
    ratePeriod: "annual",
    withoutCash: true,
  });
  await ledger.recordExchangeRate({
    from: "USD",
    to: "BOB",
    date,
    rate: amount,
    source: name,
  });
  return { ledger, parentId, category, cash, entry, loan, definition };
}

export function multiuserSpecs(schema: string) {
  describe("M-021: dos usuarios", () => {
    let db: Kysely<unknown>;
    let a: Awaited<ReturnType<typeof seed>>;
    let b: typeof a;
    let aId: string;
    let bId: string;

    async function newUser() {
      const { insertId } = await sql`INSERT INTO users () VALUES ()`.execute(
        db,
      );
      const id = insertId!.toString();
      await provisionUser(db, id);
      return id;
    }

    beforeAll(async () => {
      db = createDatabase({
        ...localDatabase("DATABASE_URL"),
        database: schema,
      }).db;
      aId = await newUser();
      bId = await newUser();
      a = await seed(db, aId, "privado_a", "81");
      b = await seed(db, bId, "privado_b", "12");
    });
    afterAll(async () => db?.destroy());

    test("S2: MCP y dashboard conservan filas, totales y conteos del usuario B al crear más datos de A", async () => {
      const server = createMcp("m021", db, undefined, bId);
      const sdk = new Client({ name: "m021", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const token = randomBytes(32).toString("base64url");
      await sql`INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at)
        VALUES (${digest(token)}, ${bId}, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`.execute(
        db,
      );
      const app = express().use(
        "/api",
        dashboardApi(
          readConfig({ PUBLIC_URL: "https://finance.example" }).auth,
          db as AuthDb,
        ),
      );
      const tools: [string, Record<string, unknown>][] = [
        [
          "listar_cuentas",
          { fecha: date, limite: 100, incluir_archivadas: true },
        ],
        ["ver_saldo", { cuenta: b.cash, fecha: date }],
        ["patrimonio_neto", { fecha: date }],
        ["resumen_periodo", { desde: date, hasta: date }],
        ["buscar_movimientos", { desde: date, hasta: date }],
        ["buscar_movimientos", { etiqueta: "privado_b" }],
        ["ver_tipo_de_cambio", { origen: "USD", destino: "BOB", fecha: date }],
        ["listar_etiquetas_y_campos", {}],
        ["listar_etiquetas_y_campos", { clase: "campo" }],
        ["listar_operaciones", { limite: 100 }],
        ["consultar_prestamos", { fecha: date }],
        ["consultar_prestamos", { id: b.loan.id, fecha: date }],
      ];
      const paths = [
        "/session",
        "/accounts",
        "/summary?month=1997-11",
        "/transactions?from=" + date + "&to=" + date,
        "/reports?from=" + date + "&to=" + date,
        "/operations?limit=100",
      ];
      const read = async () => ({
        mcp: await Promise.all(
          tools.map(async ([name, args]) => {
            const result = await sdk.callTool({ name, arguments: args });
            expect(result.isError, name).not.toBe(true);
            return result.structuredContent;
          }),
        ),
        api: await Promise.all(
          paths.map(
            async (path) =>
              (
                await request(app)
                  .get("/api" + path)
                  .set("Cookie", "__Host-fm-session=" + token)
                  .expect(200)
              ).body,
          ),
        ),
      });
      try {
        await Promise.all([
          server.connect(serverTransport),
          sdk.connect(clientTransport),
        ]);
        const ping = await sdk.callTool({ name: "ping", arguments: {} });
        expect(ping.structuredContent).toMatchObject({ message: "pong" });
        const registered = (await sdk.listTools()).tools
          .filter(({ annotations }) => annotations?.readOnlyHint)
          .map(({ name }) => name)
          .sort();
        expect(registered).toEqual(
          [
            ...new Set([
              "ping",
              "consulta_sql",
              ...tools.map(([name]) => name),
            ]),
          ].sort(),
        );
        const before = await read();
        expect(JSON.stringify(before)).not.toContain("privado_a");
        expect(JSON.stringify(before)).toContain("privado_b");
        expect(before.mcp[1]).toMatchObject({ saldo: { monto: "-12.00" } });
        expect(before.mcp[2]).toMatchObject({ total: { monto: "88.00" } });
        expect(before.mcp[3]).toMatchObject({
          totales: [{ gastos: { monto: "12.00" } }],
        });
        expect(before.mcp[4]).toMatchObject({
          movimientos: [expect.anything(), expect.anything()],
        });
        expect(before.mcp[6]).toMatchObject({ tipo: "12.0000000000" });
        expect(before.mcp[7]).toMatchObject({
          elementos: [{ nombre: "privado_b" }],
        });
        expect(before.mcp[10]).toMatchObject({
          personas: [{ persona: "privado_b" }],
        });
        expect(before.api[0]).toEqual({ authenticated: true });
        expect(before.api[1]).toMatchObject({
          accounts: expect.arrayContaining([
            expect.objectContaining({
              id: b.cash,
              balances: [
                { monto: "-12.00", moneda: "BOB", texto: "-12,00 BOB" },
              ],
            }),
          ]),
        });
        expect(before.api[3]).toMatchObject({
          rows: [expect.anything(), expect.anything()],
        });
        await a.ledger.recordExpense({
          accountId: a.cash,
          categoryId: a.category,
          amount: "45",
          date,
          description: "solo_a",
        });
        expect(await read()).toEqual(before);
        for (const [name, args] of [
          ["ver_saldo", { cuenta: a.cash }],
          ["consultar_prestamos", { id: a.loan.id, fecha: date }],
        ] as const) {
          expect((await sdk.callTool({ name, arguments: args })).isError).toBe(
            true,
          );
        }
        expect(
          (
            await sdk.callTool({
              name: "buscar_movimientos",
              arguments: { id: a.entry.id },
            })
          ).structuredContent,
        ).toMatchObject({ movimientos: [] });
      } finally {
        await sdk.close();
        await server.close();
      }
    });

    test("S3: rechaza IDs ajenos como inexistentes y MariaDB impide relaciones entre usuarios", async () => {
      const missing = /no existe|no se encontr/i;
      const operations = [
        () => b.ledger.renameAccount({ id: a.cash, name: "intruso" }),
        () => b.ledger.archiveAccount({ id: a.cash }),
        () => b.ledger.moveAccount({ id: b.cash, parentId: a.cash }),
        () =>
          b.ledger.editTransaction({ id: a.entry.id, description: "intruso" }),
        () => b.ledger.deleteTransaction({ id: a.entry.id }),
        () => b.ledger.undoOperation(a.entry.operationId),
        () => b.ledger.reconcile(a.cash, "1", date),
        () =>
          b.ledger.payLoan({
            id: a.loan.id,
            accountId: b.cash,
            amount: "1",
            date,
          }),
        () =>
          b.ledger.mergeCategories({
            sourceId: a.category,
            targetId: b.category,
          }),
        () =>
          b.ledger.mergeCategories({
            sourceId: b.category,
            targetId: a.category,
          }),
        () =>
          b.ledger.editTransaction({
            id: b.entry.id,
            lines: [
              {
                accountId: a.cash,
                side: "credit",
                currency: "BOB",
                amount: "12",
              },
              {
                accountId: b.category,
                side: "debit",
                currency: "BOB",
                amount: "12",
              },
            ],
          }),
        () =>
          b.ledger.transfer({
            fromAccountId: b.cash,
            toAccountId: a.cash,
            amount: "1",
            description: "intruso",
            date,
          }),
        () =>
          b.ledger.registerLoan({
            direction: "given",
            counterparty: "intruso",
            amount: "1",
            currency: "BOB",
            date,
            rate: "0",
            ratePeriod: "annual",
            accountId: a.cash,
          }),
        () =>
          b.ledger.payLoan({
            id: b.loan.id,
            accountId: a.cash,
            amount: "1",
            date,
          }),
        () => b.ledger.archiveCustomField({ id: a.definition.id }),
        () =>
          b.ledger.recordExpense({
            accountId: a.cash,
            categoryId: b.category,
            amount: "1",
            description: "intruso",
            date,
          }),
        () =>
          b.ledger.importBatch(
            [
              {
                date,
                description: "intruso",
                lines: [
                  {
                    accountId: a.cash,
                    side: "credit",
                    currency: "BOB",
                    amount: "1",
                  },
                  {
                    accountId: b.category,
                    side: "debit",
                    currency: "BOB",
                    amount: "1",
                  },
                ],
              },
            ],
            { duplicates: "skip" },
          ),
      ];
      const before = await Promise.all([
        a.ledger.listOperations(),
        b.ledger.listOperations(),
      ]);
      for (const operation of operations)
        await expect(operation()).rejects.toThrow(missing);
      expect(
        await Promise.all([
          a.ledger.listOperations(),
          b.ledger.listOperations(),
        ]),
      ).toEqual(before);
      const [tag] = await a.ledger.listMetadata({
        entity: "etiqueta",
        includeArchived: false,
        limit: 10,
      });
      for (const statement of [
        sql`INSERT INTO postings (user_id, transaction_id, account_id, currency, amount)
          VALUES (${bId}, ${b.entry.id}, ${a.cash}, 'BOB', 100)`,
        sql`INSERT INTO postings (user_id, transaction_id, account_id, currency, amount)
          VALUES (${bId}, ${a.entry.id}, ${b.cash}, 'BOB', 100)`,
        sql`UPDATE accounts SET parent_id = ${a.cash} WHERE id = ${b.cash}`,
        sql`UPDATE loans SET account_id = ${a.cash} WHERE id = ${b.loan.id}`,
        sql`INSERT INTO transaction_tags (user_id, transaction_id, tag_id)
          VALUES (${bId}, ${b.entry.id}, ${tag.id})`,
        sql`UPDATE transactions SET operation_id = ${a.entry.operationId} WHERE id = ${b.entry.id}`,
        sql`UPDATE operations SET undoes_operation_id = ${a.entry.operationId} WHERE id = ${b.entry.operationId}`,
        sql`INSERT INTO audit_log (user_id, operation_id, table_name, row_id, action)
          VALUES (${bId}, ${a.entry.operationId}, 'transactions', ${a.entry.id}, 'insert')`,
      ])
        await expect(statement.execute(db)).rejects.toMatchObject({
          code: "ER_NO_REFERENCED_ROW_2",
        });
    });

    test("M-021B S3: MCP rechaza IDs ajenos igual que los inexistentes", async () => {
      const server = createMcp("m021b", db, undefined, bId);
      const sdk = new Client({ name: "m021b", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const before = await b.ledger.listOperations();
      try {
        await Promise.all([
          server.connect(serverTransport),
          sdk.connect(clientTransport),
        ]);
        const absentId = "999999999";
        for (const [name, args, key, foreignId] of [
          [
            "modificar_cuenta",
            { cuenta: b.cash, accion: "mover" },
            "padre",
            a.cash,
          ],
          [
            "abonar_prestamo",
            { cuenta: b.cash, monto: "1", fecha: date },
            "id",
            a.loan.id,
          ],
        ] as const) {
          const call = (id: string) =>
            sdk.callTool({ name, arguments: { ...args, [key]: id } });
          const result = await call(foreignId);
          const absent = await call(absentId);
          expect(result.isError, name).toBe(true);
          expect(result.structuredContent, name).toBeUndefined();
          expect(JSON.stringify(result.content)).toMatch(
            /no existe|no se encontr/i,
          );
          expect(JSON.stringify(result.content)).not.toContain("privado_a");
          expect(JSON.stringify(result.content)).toBe(
            JSON.stringify(absent.content).replaceAll(absentId, foreignId),
          );
        }
        expect(await b.ledger.listOperations()).toEqual(before);
      } finally {
        await sdk.close();
        await server.close();
      }
    });

    test("S4: cada usuario tiene su propia etiqueta, categoría y definición con el mismo nombre", async () => {
      const results = [];
      for (const { ledger, cash, parentId } of [a, b]) {
        const group = (
          await ledger.createCategory({ parentId, name: "Alimentación" })
        ).id;
        const categoryId = (
          await ledger.createCategory({ parentId: group, name: "Comida" })
        ).id;
        const definition = await ledger.defineCustomField(field);
        await ledger.recordExpense({
          accountId: cash,
          categoryId,
          amount: "1",
          description: "Comida",
          tags: ["Comida"],
          custom: { proyecto: "común" },
        });
        const tags = await ledger.listMetadata({
          entity: "etiqueta",
          includeArchived: false,
          limit: 10,
        });
        const tag = tags.find(
          (tag) => "nombre" in tag && tag.nombre === "Comida",
        )!;
        results.push([categoryId, definition.id, tag.id]);
      }
      for (const [index, id] of results[0].entries())
        expect(id).not.toBe(results[1][index]);
    });

    test("S5: provisiona raíces, intereses y categorías básicas una sola vez", async () => {
      const id = await newUser();
      const ledger = createLedger(db, "web", id);
      const before = await ledger.getAccountTree(true);
      expect(
        before
          .filter(
            ({ path }) => !/ > /.test(path) || path.endsWith(" > Intereses"),
          )
          .map(({ path }) => path)
          .sort(),
      ).toEqual(
        [
          "Ingresos",
          "Gastos",
          "Saldos iniciales",
          "Ajustes de conciliación",
          "Cambio de moneda",
          "Ingresos > Intereses",
          "Gastos > Intereses",
        ].sort(),
      );
      expect(
        before
          .filter(
            ({ path }) =>
              path.includes(" > ") && !path.endsWith(" > Intereses"),
          )
          .map(({ name }) => name)
          .sort(),
      ).toEqual(
        [
          "Comida",
          "Transporte",
          "Vivienda",
          "Servicios",
          "Salud",
          "Ocio",
          "Sueldo",
          "Otros ingresos",
        ].sort(),
      );
      await Promise.all([provisionUser(db, id), provisionUser(db, id)]);
      expect(await ledger.getAccountTree(true)).toEqual(before);
    });

    test("M-021 S6 / M-021B S1: usa el tipo más reciente y el propio gana el empate", async () => {
      const when = "1997-10-01";
      const pair = { from: "USD", to: "BOB", date: when };
      const official = await a.ledger.recordOfficialRate({
        ...pair,
        rate: "7",
        source: "Oficial de prueba",
      });
      for (const { ledger } of [a, b])
        expect(await ledger.getExchangeRate(pair)).toMatchObject({
          rate: "7.0000000000",
        });
      const manual = await b.ledger.recordExchangeRate({
        ...pair,
        rate: "8",
        source: "Oficial de prueba",
      });
      expect(await b.ledger.getExchangeRate(pair)).toMatchObject({
        rate: "8.0000000000",
      });
      expect(await a.ledger.getExchangeRate(pair)).toMatchObject({
        rate: "7.0000000000",
      });
      expect(
        (
          await b.ledger.recordOfficialRate({
            ...pair,
            rate: "9",
            source: "Otro oficial",
          })
        ).operationId,
      ).toBeNull();
      await expect(
        b.ledger.undoOperation(official.operationId!),
      ).rejects.toThrow(/no existe/i);
      await b.ledger.undoOperation(manual.operationId);
      expect(await b.ledger.getExchangeRate(pair)).toMatchObject({
        rate: "7.0000000000",
      });
      const next = { ...pair, date: "1997-10-02" };
      await b.ledger.recordExchangeRate({
        ...pair,
        rate: "8",
        source: "Manual anterior",
      });
      const refresh = () => ({ ...next, rate: "9", source: "Oficial nuevo" });
      const results = await Promise.all([
        a.ledger.recordOfficialRate(refresh()),
        b.ledger.recordOfficialRate(refresh()),
      ]);
      expect(results.filter(({ operationId }) => operationId)).toHaveLength(1);
      expect(await a.ledger.getExchangeRate(next)).toMatchObject({
        rate: "9.0000000000",
      });
      const later = { ...pair, date: "1997-10-03" };
      expect(await b.ledger.getExchangeRate(later)).toMatchObject({
        rate: "9.0000000000",
      });
      expect(await b.ledger.getExchangeRate(pair)).toMatchObject({
        rate: "8.0000000000",
      });
      await b.ledger.recordExchangeRate({
        ...next,
        rate: "10",
        source: "A manual",
      });
      await b.ledger.recordExchangeRate({
        ...next,
        rate: "11",
        source: "BCB referencial venta",
      });
      expect(await b.ledger.getExchangeRate(next)).toMatchObject({
        rate: "11.0000000000",
      });
      expect(await a.ledger.getExchangeRate(next)).toMatchObject({
        rate: "9.0000000000",
      });
    });

    test("S7: los topes cuentan por usuario y día de alta", async () => {
      expect(
        ledgerLimits({
          MAX_ACCOUNTS_PER_USER: "20",
          MAX_TAGS_PER_USER: "1",
          MAX_TRANSACTIONS_PER_USER_PER_DAY: "3",
        }),
      ).toEqual(limits);
      const x = await newUser();
      const y = await newUser();
      const first = createLedger(db, "web", x, limits);
      const second = createLedger(db, "web", y, limits);
      const prepare = async (ledger: typeof first) => {
        const tree = await ledger.getAccountTree(false);
        const categoryId = tree.find(({ name }) => name === "Comida")!.id;
        const accountId = (
          await ledger.createAccount({ ...accountInput, name: "Caja" })
        ).id;
        return {
          categoryId,
          accountId,
          description: "Prueba de tope",
          amount: "1",
        };
      };
      const input = await prepare(first);
      const other = await prepare(second);
      for (let i = 1; i <= 4; i++)
        await first.createAccount({ ...accountInput, name: "Caja " + i });
      await expect(
        first.createAccount({ ...accountInput, name: "Caja excedente" }),
      ).rejects.toThrow(/límite.*cuentas/i);
      await second.createAccount({ ...accountInput, name: "Caja adicional" });
      await first.recordExpense({ ...input, tags: ["uno"] });
      await expect(
        first.recordExpense({ ...input, tags: ["dos"] }),
      ).rejects.toThrow(/límite.*etiquetas/i);
      await second.recordExpense({ ...other, tags: ["dos"] });
      await first.recordExpense({ ...input, date: "1999-01-01" });
      const attempts = await Promise.allSettled([
        first.recordExpense({ ...input, date: "1999-01-02" }),
        first.recordExpense({ ...input, date: "1999-01-03" }),
      ]);
      expect(
        attempts.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.find(({ status }) => status === "rejected"),
      ).toMatchObject({
        reason: { message: expect.stringMatching(/límite.*movimientos/i) },
      });
      await second.recordExpense({ ...other, date: "1999-01-02" });
    });
  });
}
