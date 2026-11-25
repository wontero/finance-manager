import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDatabase } from "./database.js";
import { localDatabase, setting } from "./scripts/local-database.js";

const schema = "finance_test";
const readOnlySchema = "finance_test_ro";
const tables = [
  "accounts",
  "audit_log",
  "currencies",
  "custom_field_definitions",
  "exchange_rates",
  "kysely_migration",
  "kysely_migration_lock",
  "operations",
  "postings",
  "tags",
  "transaction_tags",
  "transactions",
];
const views = [
  "v_accounts",
  "v_custom_field_definitions",
  "v_exchange_rates",
  "v_postings",
  "v_tags",
  "v_transactions",
];
const permissionDenied = { code: "ER_TABLEACCESS_DENIED_ERROR" };
const uuid = randomUUID();
let migration: Connection;
let app: Connection;
let reader: Connection;
let reportingAccount: string;
let transaction: string;

function migrate() {
  const url = new URL(setting("MIGRATION_DATABASE_URL"));
  url.pathname = schema;
  return execFileSync(
    process.execPath,
    [setting("npm_execpath"), "run", "migrate"],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: url.href,
        READONLY_DATABASE_NAME: readOnlySchema,
        DATABASE_SOCKET: undefined,
      },
      encoding: "utf8",
    },
  );
}

beforeAll(async () => {
  const migrationOptions = localDatabase("MIGRATION_DATABASE_URL");
  migration = await createConnection({
    ...migrationOptions,
    database: schema,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const [existing] = await migration.query<RowDataPacket[]>("SHOW FULL TABLES");
  const output = migrate();
  expect(output).toMatch(
    existing.length ? /Sin migraciones pendientes/ : /Migración aplicada:/,
  );
  app = await createConnection({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  reader = await createConnection({
    ...localDatabase("READONLY_DATABASE_URL"),
    database: readOnlySchema,
  });
  const [accounts] = await migration.query<RowDataPacket[]>(
    "SELECT id FROM accounts WHERE name = 'Saldos iniciales'",
  );
  reportingAccount = accounts[0].id;
  await migration.execute(
    "INSERT INTO operations (id, actor, description) VALUES (?, 'system', 'Prueba M-003')",
    [uuid],
  );
  await migration.execute(
    "INSERT INTO transactions (date, description, operation_id) VALUES ('2026-11-24', 'Prueba M-003', ?)",
    [uuid],
  );
  const [rows] = await migration.execute<RowDataPacket[]>(
    "SELECT id FROM transactions WHERE operation_id = ?",
    [uuid],
  );
  transaction = rows[0].id;
}, 20_000);

afterAll(async () => {
  await reader?.end();
  await app?.end();
  if (!migration) return;
  try {
    if (transaction) {
      await migration.execute("DELETE FROM postings WHERE transaction_id = ?", [
        transaction,
      ]);
      await migration.execute("DELETE FROM transactions WHERE id = ?", [
        transaction,
      ]);
    }
    await migration.execute("DELETE FROM operations WHERE id = ?", [uuid]);
  } finally {
    await migration.end();
  }
});

test("S1: migrate creates the schema and is idempotent", async () => {
  expect(migrate()).toMatch(/Sin migraciones pendientes/);
  const [objects] = await migration.execute<RowDataPacket[]>(
    "SELECT table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema IN (?, ?)",
    [schema, readOnlySchema],
  );
  expect(
    objects
      .filter((row) => row.kind === "BASE TABLE")
      .map((row) => row.name)
      .sort(),
  ).toEqual(tables);
  const [definitions] = await migration.execute<RowDataPacket[]>(
    "SELECT table_name AS name, security_type AS security FROM information_schema.views WHERE table_schema = ? ORDER BY table_name",
    [readOnlySchema],
  );
  expect(definitions).toEqual(
    views.map((name) => ({ name, security: "DEFINER" })),
  );
}, 15_000);

test("S2: seeds exactly the currencies and system accounts", async () => {
  const [currencies] = await migration.query<RowDataPacket[]>(
    "SELECT code, minor_unit FROM currencies ORDER BY code",
  );
  expect(currencies).toEqual([
    { code: "BOB", minor_unit: 2 },
    { code: "USD", minor_unit: 2 },
  ]);
  const [accounts] = await migration.query<RowDataPacket[]>(
    "SELECT name, kind, parent_id, currency, is_system FROM accounts WHERE is_system ORDER BY name",
  );
  expect(accounts).toEqual(
    [
      ["Ajustes de conciliación", "equity"],
      ["Cambio de moneda", "equity"],
      ["Gastos", "expense"],
      ["Ingresos", "income"],
      ["Saldos iniciales", "equity"],
    ].map(([name, kind]) => ({
      name,
      kind,
      parent_id: null,
      currency: null,
      is_system: 1,
    })),
  );
});

test("S3: audit_log permits inserts and rejects updates and deletes", async () => {
  await migration.beginTransaction();
  try {
    await migration.execute(
      "INSERT INTO audit_log (operation_id, table_name, row_id, action, `after`) VALUES (?, 'transactions', ?, 'insert', '{}')",
      [uuid, transaction],
    );
    await expect(
      migration.execute(
        "UPDATE audit_log SET row_id = '0' WHERE operation_id = ?",
        [uuid],
      ),
    ).rejects.toMatchObject({ sqlState: "45000" });
    await expect(
      migration.execute("DELETE FROM audit_log WHERE operation_id = ?", [uuid]),
    ).rejects.toMatchObject({ sqlState: "45000" });
  } finally {
    await migration.rollback();
  }
});

test("S4: rejects zero, unknown currencies and invalid account kinds", async () => {
  const insert =
    "INSERT INTO postings (transaction_id, account_id, currency, amount) VALUES (?, ?, ?, ?)";
  await expect(
    app.execute(insert, [transaction, reportingAccount, "BOB", "0"]),
  ).rejects.toMatchObject({ errno: 4025 });
  await expect(
    app.execute(insert, [transaction, reportingAccount, "BAD", "1"]),
  ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  await expect(
    app.execute("INSERT INTO accounts (name, kind) VALUES (?, 'bad')", [uuid]),
  ).rejects.toMatchObject({ errno: 1265 });
});

test("S4: only active siblings must have distinct names, including roots", async () => {
  await app.beginTransaction();
  try {
    await expect(
      app.execute(
        "INSERT INTO accounts (name, kind) VALUES ('Ingresos', 'income')",
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await app.execute(
      "INSERT INTO accounts (name, kind, parent_id) VALUES (?, 'equity', ?)",
      [uuid, reportingAccount],
    );
    await expect(
      app.execute(
        "INSERT INTO accounts (name, kind, parent_id) VALUES (?, 'equity', ?)",
        [uuid, reportingAccount],
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await app.execute(
      "UPDATE accounts SET archived_at = CURRENT_TIMESTAMP WHERE name = ?",
      [uuid],
    );
    await app.execute(
      "INSERT INTO accounts (name, kind, parent_id) VALUES (?, 'equity', ?), (?, 'equity', NULL)",
      [uuid, reportingAccount, uuid],
    );
  } finally {
    await app.rollback();
  }
});

test("S5: the Kysely connection round-trips BIGINT without rounding", async () => {
  const { db } = createDatabase({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  try {
    await db.transaction().execute(async (trx) => {
      await sql`INSERT INTO postings (transaction_id, account_id, currency, amount)
        VALUES (${transaction}, ${reportingAccount}, 'BOB', ${"9007199254740993"})`.execute(
        trx,
      );
      const result = await sql<{
        amount: string;
      }>`SELECT amount FROM postings WHERE transaction_id = ${transaction}`.execute(
        trx,
      );
      expect(result.rows).toEqual([{ amount: "9007199254740993" }]);
      await sql`DELETE FROM postings WHERE transaction_id = ${transaction}`.execute(
        trx,
      );
    });
  } finally {
    await db.destroy();
  }
});

test("S6: DECIMAL retains the exact exchange rate", async () => {
  const { db } = createDatabase({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  try {
    await db.transaction().execute(async (trx) => {
      await sql`INSERT INTO exchange_rates (date, from_currency, to_currency, rate, source)
        VALUES ('2026-11-24', 'USD', 'BOB', ${"6.9612345678"}, ${uuid})`.execute(
        trx,
      );
      const result = await sql<{
        rate: string;
      }>`SELECT rate FROM exchange_rates WHERE source = ${uuid}`.execute(trx);
      expect(result.rows).toEqual([{ rate: "6.9612345678" }]);
      await sql`DELETE FROM exchange_rates WHERE source = ${uuid}`.execute(trx);
    });
  } finally {
    await db.destroy();
  }
});

test("S7: the reader can select only from the views and cannot write or create", async () => {
  for (const view of views)
    await expect(
      reader.query(`SELECT * FROM ${view} LIMIT 1`),
    ).resolves.toBeDefined();
  for (const table of tables)
    await expect(
      reader.query(`SELECT * FROM finance_test.${table}`),
    ).rejects.toMatchObject(permissionDenied);
  // Use valid DML on an updatable view to isolate the privilege check.
  for (const statement of [
    "INSERT INTO v_tags (name) VALUES ('M-003')",
    "UPDATE v_tags SET name = 'M-003'",
    "DELETE FROM v_tags",
    "CREATE TABLE denied_ddl (id INT)",
  ])
    await expect(reader.query(statement)).rejects.toMatchObject(
      permissionDenied,
    );
});

test("S8: soft-deleted transactions and their postings disappear from the views", async () => {
  await app.execute(
    "INSERT INTO postings (transaction_id, account_id, currency, amount) VALUES (?, ?, 'BOB', 1)",
    [transaction, reportingAccount],
  );
  try {
    const transactions = () =>
      reader.execute("SELECT id FROM v_transactions WHERE id = ?", [
        transaction,
      ]);
    const postings = () =>
      reader.execute(
        "SELECT account_name, currency FROM v_postings WHERE transaction_id = ?",
        [transaction],
      );
    expect((await transactions())[0]).toHaveLength(1);
    expect((await postings())[0]).toEqual([
      { account_name: "Saldos iniciales", currency: "BOB" },
    ]);
    await app.execute(
      "UPDATE transactions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
      [transaction],
    );
    expect((await transactions())[0]).toEqual([]);
    expect((await postings())[0]).toEqual([]);
  } finally {
    await app.execute(
      "UPDATE transactions SET deleted_at = NULL WHERE id = ?",
      [transaction],
    );
    await app.execute("DELETE FROM postings WHERE transaction_id = ?", [
      transaction,
    ]);
  }
});

test("S9: only active custom definitions are visible and raw JSON and audit are private", async () => {
  const archived = `archived_${uuid}`;
  await app.execute(
    "INSERT INTO custom_field_definitions (entity, `key`, label, type, archived_at) VALUES ('transaction', ?, 'Activa', 'text', NULL), ('transaction', ?, 'Archivada', 'text', CURRENT_TIMESTAMP)",
    [uuid, archived],
  );
  try {
    const [definitions] = await reader.execute(
      "SELECT `key` FROM v_custom_field_definitions WHERE `key` IN (?, ?)",
      [uuid, archived],
    );
    expect(definitions).toEqual([{ key: uuid }]);
    for (const view of ["v_transactions", "v_accounts"]) {
      const [, columns] = await reader.query(`SELECT * FROM ${view} LIMIT 0`);
      expect(columns.map((column) => column.name)).not.toContain("custom");
    }
    for (const name of ["audit_log", "v_audit_log"])
      await expect(reader.query(`SELECT * FROM ${name}`)).rejects.toMatchObject(
        { code: "ER_NO_SUCH_TABLE" },
      );
  } finally {
    await app.execute(
      "DELETE FROM custom_field_definitions WHERE `key` IN (?, ?)",
      [uuid, archived],
    );
  }
});

test("S10: the app cannot create or drop tables or access the reader schema", async () => {
  for (const statement of [
    "CREATE TABLE denied_ddl (id INT)",
    "DROP TABLE denied_ddl",
    "SELECT * FROM finance_test_ro.v_accounts",
  ])
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
});
