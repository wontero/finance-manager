import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { sql, type Kysely } from "kysely";
import type { RowDataPacket } from "mysql2";
import { createConnection } from "mysql2/promise";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { digest, type AuthDb } from "./auth-store.js";
import { readConfig } from "./config.js";
import { dashboardApi } from "./dashboard-http.js";
import { createDatabase } from "./database.js";
import { createLedger, provisionUser } from "./ledger/index.js";
import { ledgerLimits } from "./ledger/limits.js";
import { createMcp } from "./mcp/index.js";
import { readonlyStatementPrefix } from "./mcp/readonly-sql.js";
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

export function multiuserSpecs(schema: string, readonlySchema: string) {
  describe("M-021: dos usuarios", () => {
    let db: Kysely<unknown>;
    let a: Awaited<ReturnType<typeof seed>>;
    let b: typeof a;
    let aId: string;
    let bId: string;

    describe("M-023B consulta_sql", () => {
      let reader: ReturnType<typeof createDatabase>;
      const clients = [
        new Client({ name: "m023b-a", version: "1" }),
        new Client({ name: "m023b-b", version: "1" }),
      ];
      const call = (user: number, statement: string) =>
        clients[user].callTool({
          name: "consulta_sql",
          arguments: { sql: statement },
        });
      async function rows(user: number, statement: string) {
        const result = await call(user, statement);
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        return (
          result.structuredContent as { filas: Record<string, unknown>[] }
        ).filas;
      }

      const sources = [
        ["accounts", "id", "TRUE"],
        ["transactions", "id", "deleted_at IS NULL"],
        ["postings", "id", "TRUE"],
        ["tags", "id", "TRUE"],
        ["transaction_tags", "tag_id", "TRUE"],
        ["exchange_rates", "source", "TRUE"],
        ["custom_field_definitions", "id", "archived_at IS NULL"],
        ["loans", "id", "TRUE"],
      ] as const;

      beforeAll(async () => {
        reader = createDatabase({
          ...localDatabase("READONLY_DATABASE_URL"),
          database: readonlySchema,
          connectionLimit: 2,
        });
        await Promise.all(
          [aId, bId].map(async (id, index) => {
            const [client, server] = InMemoryTransport.createLinkedPair();
            await Promise.all([
              createMcp(
                "m023b",
                db,
                {
                  pool: reader.pool,
                  mainSchema: schema,
                  schema: readonlySchema,
                },
                id,
              ).connect(server),
              clients[index].connect(client),
            ]);
          }),
        );
      });
      afterAll(async () => {
        await Promise.all(clients.map((client) => client.close()));
        await reader?.db.destroy();
      });

      test("S1: ambas identidades ven exactamente sus filas en las ocho vistas", async () => {
        for (const [table, key, filter] of sources) {
          const view = "v_" + table;
          for (const [user, id] of [aId, bId].entries()) {
            const shared =
              table === "exchange_rates" ? sql`OR user_id IS NULL` : sql``;
            const expected = await sql<Record<string, unknown>>`
              SELECT ${sql.ref(key)} FROM ${sql.table(table)}
              WHERE (user_id = ${id} ${shared}) AND ${sql.raw(filter)}
            `.execute(db);
            expect(expected.rows.length, view).toBeGreaterThan(0);
            const actual = await rows(user, "SELECT * FROM " + view);
            expect(actual.map((row) => row[key]).sort(), view).toEqual(
              expected.rows.map((row) => row[key]).sort(),
            );
            for (const row of actual) expect(row).not.toHaveProperty("user_id");
            expect(
              await rows(user, "SELECT COUNT(*) AS total FROM " + view),
            ).toEqual([{ total: String(expected.rows.length) }]);
          }
        }
      });

      test("S2: veinte consultas intercaladas aíslan filas y agregados", async () => {
        await Promise.all(
          Array.from({ length: 20 }, async (_, index) => {
            const user = index % 2;
            const result = await rows(
              user,
              "WITH movimientos AS (SELECT description FROM v_transactions) " +
                "SELECT MAX(description) AS descripcion, COUNT(*) AS total FROM movimientos",
            );
            expect(result).toEqual([
              {
                descripcion: user === 0 ? "privado_a" : "privado_b",
                total: "2",
              },
            ]);
          }),
        );
      });

      test("S3: las ocho vistas devuelven cero filas sin mapeo", async () => {
        for (const [table] of sources) {
          const [result] = await reader.pool
            .promise()
            .query<RowDataPacket[]>("SELECT * FROM v_" + table);
          expect(result).toEqual([]);
        }
      });

      test("S3: un mapeo vencido queda inactivo aunque la conexión siga abierta", async () => {
        const connection = await reader.pool.promise().getConnection();
        const lock = randomUUID();
        try {
          await connection.execute("SELECT GET_LOCK(?, 0)", [lock]);
          await sql`INSERT INTO readonly_sql_sessions (connection_id, user_id, lock_name, expires_at)
            VALUES (${connection.threadId}, ${aId}, ${lock}, UTC_TIMESTAMP(3) - INTERVAL 1 SECOND)`.execute(
            db,
          );
          const [result] = await connection.query("SELECT * FROM v_accounts");
          expect(result).toEqual([]);
        } finally {
          connection.destroy();
          await sql`DELETE FROM readonly_sql_sessions WHERE lock_name = ${lock}`.execute(
            db,
          );
        }
      });

      test("S3: una instalación de vistas incompleta deja la herramienta cerrada", async () => {
        await sql`DELETE FROM readonly_sql_schema WHERE name = ${readonlySchema}`.execute(
          db,
        );
        try {
          const result = await call(0, "SELECT name FROM v_accounts");
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toBeUndefined();
        } finally {
          await sql`INSERT INTO readonly_sql_schema (name) VALUES (${readonlySchema})`.execute(
            db,
          );
        }
      });

      test("S4: el validador rechaza entradas no permitidas y el lector carece de permisos sobre las tablas", async () => {
        for (const statement of [
          "SELECT @x := 1",
          "SELECT @@version",
          "SET @x = 1",
          "SELECT 1 INTO OUTFILE 'm023b.txt'",
          "SELECT 1 INTO @x",
          "SELECT * FROM readonly_sql_sessions",
          `SELECT * FROM \`${schema}\` . \`accounts\``,
          `SELECT * FROM ${readonlySchema}.v_accounts`,
          `SELECT * FROM v_accounts UNION SELECT * FROM ${schema}.accounts`,
          "SELECT * FROM information_schema.PROCESSLIST",
          "SELECT * FROM information_schema.TABLES",
          "SELECT * FROM \`INFORMATION_SCHEMA\` . \`PROCESSLIST\`",
          "SELECT * FROM \`Information_Schema\` . \`TABLES\`",
          "SELECT 1 AS \`MYSQL\`",
          "SELECT 1 AS \`performance_schema\`",
          "SELECT 1 AS \`sys\`",
          "WITH t AS (SELECT * FROM information_schema.TABLES) SELECT * FROM t",
          "SELECT * FROM v_accounts JOIN readonly_sql_sessions ON 1 = 1",
          "SELECT * FROM v_accounts, readonly_sql_sessions",
          "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 2) SELECT n FROM r",
          "SELECT 1 /*! + 2 */",
          "SELECT 1; SELECT 2",
        ]) {
          const result = await call(0, statement);
          const content = JSON.stringify(result.content);
          expect(result.isError, statement).toBe(true);
          expect(content).toMatch(
            /vistas autorizadas|solo lectura|comentarios ejecutables/i,
          );
          expect(content).not.toContain(schema);
          expect(content).not.toContain("privado_b");
        }
        expect(
          await rows(
            0,
            "WITH t AS (SELECT id FROM v_transactions) " +
              "SELECT COUNT(*) AS total FROM t JOIN (SELECT id FROM v_transactions) AS own USING (id)",
          ),
        ).toEqual([{ total: "2" }]);
        for (const table of ["accounts", "readonly_sql_sessions"])
          await expect(
            reader.pool.promise().query(`SELECT * FROM ${schema}.${table}`),
          ).rejects.toMatchObject({ code: "ER_TABLEACCESS_DENIED_ERROR" });
      });

      test("S5: un timeout borra el mapeo y la siguiente consulta pertenece a B", async () => {
        const pending = call(0, "SELECT SLEEP(10) FROM v_transactions");
        const active = async () =>
          (await sql`SELECT user_id FROM readonly_sql_sessions`.execute(db))
            .rows;
        await expect.poll(active).toEqual([{ user_id: aId }]);
        const metadata = await call(
          1,
          "SELECT * FROM information_schema.PROCESSLIST",
        );
        expect(metadata.isError).toBe(true);
        expect(JSON.stringify(metadata.content)).not.toContain("SLEEP");
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("5 segundos");
        expect(await active()).toEqual([]);
        expect(
          await rows(
            1,
            "SELECT description FROM v_transactions WHERE id = " + b.entry.id,
          ),
        ).toEqual([{ description: "privado_b" }]);
      }, 10_000);

      test("M-023C S2: EXPLAIN conserva la condición externa fuera de la vista", async () => {
        const connection = await createConnection({
          ...localDatabase("MIGRATION_DATABASE_URL"),
          database: readonlySchema,
        });
        const lock = randomUUID();
        try {
          await connection.execute("SELECT GET_LOCK(?, 0)", [lock]);
          await sql`INSERT INTO readonly_sql_sessions (connection_id, user_id, lock_name, expires_at)
            VALUES (${connection.threadId}, ${aId}, ${lock}, UTC_TIMESTAMP(3) + INTERVAL 10 SECOND)`.execute(
            db,
          );
          const [[plan]] = await connection.query<RowDataPacket[]>(
            readonlyStatementPrefix +
              "EXPLAIN FORMAT=JSON SELECT name FROM v_accounts WHERE name LIKE 'privado%'",
          );
          const outer = JSON.parse(plan.EXPLAIN).query_block.table;
          expect(outer.attached_condition).toContain("privado%");
          expect(outer.materialized).toBeDefined();
          expect(JSON.stringify(outer.materialized)).toContain("user_id");
          expect(JSON.stringify(outer.materialized)).not.toContain("privado%");
        } finally {
          await connection.end();
          await sql`DELETE FROM readonly_sql_sessions WHERE lock_name = ${lock}`.execute(
            db,
          );
        }
      });

      test("M-023C S3: un mapeo vigente sin bloqueo no autoriza y la siguiente consulta limpia los mapeos obsoletos", async () => {
        const [orphan, expired] = await Promise.all([
          createConnection({
            ...localDatabase("READONLY_DATABASE_URL"),
            database: readonlySchema,
          }),
          reader.pool.promise().getConnection(),
        ]);
        const orphanLock = randomUUID();
        const expiredLock = randomUUID();
        try {
          await orphan.execute("SELECT GET_LOCK(?, 0)", [orphanLock]);
          await expired.execute("SELECT GET_LOCK(?, 0)", [expiredLock]);
          await sql`INSERT INTO readonly_sql_sessions (connection_id, user_id, lock_name, expires_at)
            VALUES
              (${orphan.threadId}, ${aId}, ${orphanLock}, UTC_TIMESTAMP(3) + INTERVAL 30 SECOND),
              (${expired.threadId}, ${aId}, ${expiredLock}, UTC_TIMESTAMP(3) - INTERVAL 1 SECOND)`.execute(
            db,
          );
          const statement = "SELECT name FROM v_accounts WHERE id = " + a.cash;
          expect((await orphan.query(statement))[0]).toEqual([
            { name: "privado_a" },
          ]);
          await orphan.execute("SELECT RELEASE_LOCK(?)", [orphanLock]);
          expect((await orphan.query(statement))[0]).toEqual([]);
          expect(
            await rows(1, "SELECT name FROM v_accounts WHERE id = " + b.cash),
          ).toEqual([{ name: "privado_b" }]);
          expect(
            (await sql`SELECT lock_name FROM readonly_sql_sessions`.execute(db))
              .rows,
          ).toEqual([]);
        } finally {
          await orphan.end();
          expired.destroy();
          await sql`DELETE FROM readonly_sql_sessions WHERE lock_name IN (${orphanLock}, ${expiredLock})`.execute(
            db,
          );
        }
      });

      test("M-023C S3: un error de ejecución borra el mapeo y B sigue aislado", async () => {
        const pending = call(
          0,
          "SELECT IF(SLEEP(0.5) = 0, EXP(1000 + id), 0) FROM v_transactions WHERE id = " +
            a.entry.id,
        );
        const active = async () =>
          (await sql`SELECT user_id FROM readonly_sql_sessions`.execute(db))
            .rows;
        await expect.poll(active).toEqual([{ user_id: aId }]);
        const result = await pending;
        expect(result).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: "No se pudo ejecutar la consulta de solo lectura.",
            },
          ],
        });
        expect(result.structuredContent).toBeUndefined();
        expect(await active()).toEqual([]);
        expect(
          await rows(1, "SELECT name FROM v_accounts WHERE id = " + b.cash),
        ).toEqual([{ name: "privado_b" }]);
      });

      test("M-023C S4: conserva los literales y los identificadores entre comillas", async () => {
        expect(
          await rows(
            0,
            "SELECT\t/* comentario */ 'café -- # /* */' AS `etiquéta` FROM v_accounts WHERE id = " +
              a.cash +
              ";\n",
          ),
        ).toEqual([{ etiquéta: "café -- # /* */" }]);
      });
    });

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
