import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import {
  createConnection,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, expect, test } from "vitest";
import { accountSpecs } from "./account-specs.js";
import { dashboardSpecs } from "./dashboard-specs.js";
import { authSpecs } from "./auth-specs.js";
import { createDatabase } from "./database.js";
import { googleSpecs, seedPreviousAuth } from "./google-specs.js";
import { UndoConflict } from "./ledger/audit.js";
import { createLedger } from "./ledger/index.js";
import { ledgerSpecs } from "./ledger/ledger-specs.js";
import { getAccountTotal, getOperations } from "./ledger/queries.js";
import { getPeriodSummary } from "./ledger/reports.js";
import type { LedgerDatabase } from "./ledger/schema.js";
import { mcpSpecs } from "./mcp/mcp-specs.js";
import * as accountingMigration from "./migrations/202611242020_accounting_schema.js";
import * as authenticationMigration from "./migrations/202611242230_authentication.js";
import * as loanMigration from "./migrations/202611250900_loans.js";
import * as sessionMigration from "./migrations/202611251500_web_sessions.js";
import * as ownershipMigration from "./migrations/202611261200_user_ownership.js";
import { multiuserSpecs } from "./multiuser-specs.js";
import {
  checkLocalDataDir,
  localDatabase,
  setting,
} from "./scripts/local-database.js";

const schema = "finance_test";
const readOnlySchema = "finance_test_ro";
const tables = [
  "accounts",
  "audit_log",
  "auth_events",
  "currencies",
  "custom_field_definitions",
  "exchange_rates",
  "goal_accounts",
  "goals",
  "google_login_requests",
  "kysely_migration",
  "kysely_migration_lock",
  "loans",
  "oauth_authorization_codes",
  "oauth_clients",
  "oauth_tokens",
  "operations",
  "postings",
  "readonly_sql_schema",
  "readonly_sql_sessions",
  "request_metrics",
  "tags",
  "transaction_tags",
  "transactions",
  "user_request_limits",
  "users",
  "web_sessions",
];
const views = [
  "v_accounts",
  "v_custom_field_definitions",
  "v_exchange_rates",
  "v_goal_accounts",
  "v_goals",
  "v_loans",
  "v_postings",
  "v_tags",
  "v_transaction_tags",
  "v_transactions",
];
const permissionDenied = { code: "ER_TABLEACCESS_DENIED_ERROR" };
const uuid = randomUUID();
const pools: Pool[] = [];
let migration: PoolConnection;
let app: PoolConnection;
let reader: PoolConnection;
let reportingAccount: string;
let transaction: string;
let initialMigration: string;
let legacyIncomeInterest: string;
let legacyExpenseInterest: { id: string; operationId: string | null };
let archivedExpenseInterest: string;
const legacyDate = "1977-11-11";
const legacyPeriod = {
  from: legacyDate,
  to: legacyDate,
  limit: 100,
  includeArchived: true,
};
const legacyTables = {
  accounts: "id",
  transactions: "id",
  postings: "id",
  tags: "id",
  transaction_tags: "transaction_id, tag_id",
  custom_field_definitions: "id",
  loans: "id",
  operations: "seq",
  audit_log: "id",
  exchange_rates: "from_currency, to_currency, date, source",
} as const;
let legacyCash: string;
let legacyOperation: string;

async function domainRows(
  db: ReturnType<typeof createDatabase>["db"],
  migrated = false,
) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(legacyTables).map(async ([table, order]) => {
        const { rows } = await sql
          .raw<Record<string, unknown>>(
            `SELECT * FROM ${table} ORDER BY ${order}`,
          )
          .execute(db);
        return [
          table,
          rows.map((row) => {
            const { user_id, ...values } = row;
            if (migrated) expect(user_id).toBe("1");
            if (table === "exchange_rates") {
              delete values.id;
              delete values.owner_key;
              delete values.owner_source;
            }
            return values;
          }),
        ];
      }),
    ),
  );
}

async function legacyRead(db: ReturnType<typeof createDatabase>["db"]) {
  const typed = db.withTables<LedgerDatabase>();
  return {
    balance: await getAccountTotal(typed, legacyCash, legacyDate),
    summary: await getPeriodSummary(typed, legacyPeriod),
    operations: (await getOperations(typed, 100)).map(
      ({ id, actor, description, undone }) => ({
        id,
        actor,
        description,
        undone,
      }),
    ),
  };
}

async function seedLegacyData(db: ReturnType<typeof createDatabase>["db"]) {
  const insertId = async (query: ReturnType<typeof sql>) =>
    (await query.execute(db)).insertId!.toString();
  const opening = (
    await sql<{
      id: string;
    }>`SELECT id FROM accounts WHERE name = 'Saldos iniciales'`.execute(db)
  ).rows[0].id;
  const root = (
    await sql<{
      id: string;
    }>`SELECT id FROM accounts WHERE name = 'Gastos'`.execute(db)
  ).rows[0].id;
  legacyCash = await insertId(
    sql`INSERT INTO accounts (name, kind, subtype, currency) VALUES ('Caja previa', 'asset', 'efectivo', 'BOB')`,
  );
  const usd = await insertId(
    sql`INSERT INTO accounts (name, kind, subtype, currency) VALUES ('Dólares previos', 'asset', 'efectivo', 'USD')`,
  );
  const receivable = await insertId(
    sql`INSERT INTO accounts (name, kind, subtype, currency) VALUES ('Préstamo previo', 'asset', 'por_cobrar', 'BOB')`,
  );
  const parent = await insertId(
    sql`INSERT INTO accounts (name, kind, parent_id) VALUES ('Categoría previa', 'expense', ${root})`,
  );
  const category = await insertId(
    sql`INSERT INTO accounts (name, kind, parent_id) VALUES ('Subcategoría previa', 'expense', ${parent})`,
  );
  await sql`INSERT INTO loans (account_id, direction, counterparty, currency, principal, start_date, rate, rate_period)
    VALUES (${receivable}, 'given', 'Persona de prueba', 'BOB', 4321, ${legacyDate}, 0, 'annual')`.execute(
    db,
  );
  const tag = await insertId(
    sql`INSERT INTO tags (name) VALUES ('Etiqueta previa')`,
  );
  await sql`INSERT INTO custom_field_definitions (entity, \`key\`, label, type) VALUES ('transaction', 'prueba', 'Campo previo', 'text')`.execute(
    db,
  );
  legacyOperation = randomUUID();
  const undone = randomUUID();
  const reversal = randomUUID();
  await sql`INSERT INTO operations (id, actor, description, undoes_operation_id) VALUES
    (${undone}, 'claude', 'Operación previa deshecha', NULL),
    (${reversal}, 'web', 'Deshacer operación previa', ${undone}),
    (${legacyOperation}, 'web', 'Registrar tipo de cambio', NULL)`.execute(db);
  const entry =
    await insertId(sql`INSERT INTO transactions (date, description, custom, operation_id)
    VALUES (${legacyDate}, 'Movimiento previo', '{"prueba":"valor"}', ${legacyOperation})`);
  await sql`INSERT INTO postings (transaction_id, account_id, currency, amount) VALUES
    (${entry}, ${legacyCash}, 'BOB', -543), (${entry}, ${category}, 'BOB', 543),
    (${entry}, ${usd}, 'USD', 1223), (${entry}, ${opening}, 'USD', -1223)`.execute(
    db,
  );
  await sql`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (${entry}, ${tag})`.execute(
    db,
  );
  const source = "Tipo previo";
  const quote = {
    from_currency: "USD",
    to_currency: "BOB",
    date: legacyDate,
    source,
    rate: "7.0000000000",
  };
  await sql`INSERT INTO exchange_rates (from_currency, to_currency, date, source, rate) VALUES ('USD', 'BOB', ${legacyDate}, ${source}, 7)`.execute(
    db,
  );
  await sql`INSERT INTO audit_log (operation_id, table_name, row_id, action, \`after\`) VALUES
    (${legacyOperation}, 'exchange_rates', ${"USD/BOB/" + legacyDate + "/" + source}, 'insert', ${JSON.stringify(quote)})`.execute(
    db,
  );
}

function connect(settingName: string, database: string) {
  const { pool } = createDatabase({ ...localDatabase(settingName), database });
  const client = pool.promise();
  pools.push(client);
  return client.getConnection();
}

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
  const provision = await createConnection({
    ...migrationOptions,
    database: undefined,
  });
  try {
    await checkLocalDataDir(provision, migrationOptions.port);
    for (const database of [readOnlySchema, schema]) {
      await provision.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await provision.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    }
  } finally {
    await provision.end();
  }
  const { db } = createDatabase({ ...migrationOptions, database: schema });
  try {
    const prior = new Migrator({
      db,
      provider: {
        async getMigrations() {
          return {
            "202611242020_accounting_schema": accountingMigration,
            "202611242230_authentication": authenticationMigration,
          };
        },
      },
    });
    const { error } = await prior.migrateToLatest();
    if (error) throw error;
    await sessionMigration.up(db);
    await seedPreviousAuth(db);
    const accounts = db.withTables<LedgerDatabase>();
    const income = await accounts
      .selectFrom("accounts")
      .select("id")
      .where("kind", "=", "income")
      .executeTakeFirstOrThrow();
    const archivedCategory = async (parent: string, kind: string) =>
      (
        await sql`INSERT INTO accounts (name, parent_id, kind, archived_at)
        VALUES ('Intereses', ${parent}, ${kind}, UTC_TIMESTAMP(3))`.execute(db)
      ).insertId!.toString();
    legacyIncomeInterest = await archivedCategory(income.id, "income");
    const expense = await accounts
      .selectFrom("accounts")
      .select("id")
      .where("kind", "=", "expense")
      .executeTakeFirstOrThrow();
    archivedExpenseInterest = await archivedCategory(expense.id, "expense");
    const active = await sql`INSERT INTO accounts (name, parent_id, kind)
      VALUES ('intereses', ${expense.id}, 'expense')`.execute(db);
    const id = active.insertId!.toString();
    const operationId = randomUUID();
    await sql`INSERT INTO operations (id, actor, description) VALUES (${operationId}, 'web', 'Crear categoría')`.execute(
      db,
    );
    const [row] = (
      await sql`SELECT * FROM accounts WHERE id = ${id}`.execute(db)
    ).rows;
    await sql`INSERT INTO audit_log (operation_id, table_name, row_id, action, \`after\`)
      VALUES (${operationId}, 'accounts', ${id}, 'insert', ${JSON.stringify(row)})`.execute(
      db,
    );
    legacyExpenseInterest = { id, operationId };
  } finally {
    await db.destroy();
  }
  initialMigration = migrate();
  migration = await connect("MIGRATION_DATABASE_URL", schema);
  app = await connect("DATABASE_URL", schema);
  reader = await connect("READONLY_DATABASE_URL", readOnlySchema);
  const [accounts] = await migration.query<RowDataPacket[]>(
    "SELECT id FROM accounts WHERE name = 'Saldos iniciales'",
  );
  reportingAccount = accounts[0].id;
  await migration.execute(
    "INSERT INTO operations (user_id, id, actor, description) VALUES (1, ?, 'system', 'Prueba M-003')",
    [uuid],
  );
  await migration.execute(
    "INSERT INTO transactions (user_id, date, description, operation_id) VALUES (1, '2026-11-24', 'Prueba M-003', ?)",
    [uuid],
  );
  const [rows] = await migration.execute<RowDataPacket[]>(
    "SELECT id FROM transactions WHERE operation_id = ?",
    [uuid],
  );
  transaction = rows[0].id;
}, 20_000);

async function withLegacyData(
  run: (db: ReturnType<typeof createDatabase>["db"]) => Promise<void>,
) {
  // Las tablas de esta prueba viven junto a las vistas, separadas de los otros fixtures.
  const { db } = createDatabase({
    ...localDatabase("MIGRATION_DATABASE_URL"),
    database: readOnlySchema,
  });
  try {
    await accountingMigration.up(db);
    await loanMigration.up(db);
    await seedLegacyData(db);
    await run(db);
  } finally {
    try {
      await db.connection().execute(async (connection) => {
        await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(connection);
        try {
          const tables = [...Object.keys(legacyTables), "currencies", "users"];
          await sql`DROP TABLE IF EXISTS ${sql.join(tables.map((table) => sql.table(table)))}`.execute(
            connection,
          );
        } finally {
          await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(connection);
        }
      });
    } finally {
      await db.destroy();
    }
  }
}

test("M-021 S1: migración reintentable conserva filas, saldos, informes y auditoría reversible", () =>
  withLegacyData(async (db) => {
    const before = await domainRows(db);
    const results = await legacyRead(db);
    await ownershipMigration.up(db);
    expect(await domainRows(db, true)).toEqual(before);
    await ownershipMigration.up(db);
    expect(await domainRows(db, true)).toEqual(before);

    const ledger = createLedger(db, "web", "1");
    expect(
      await ledger.getBalance({ id: legacyCash, date: legacyDate }),
    ).toEqual({ amount: results.balance, currency: "BOB" });
    expect(await ledger.getPeriodSummary(legacyPeriod)).toEqual(
      results.summary,
    );
    expect(
      (await ledger.listOperations({ limit: 100 })).map(
        ({ id, actor, description, undone }) => ({
          id,
          actor,
          description,
          undone,
        }),
      ),
    ).toEqual(results.operations);
    expect(
      (await ledger.getAccountTree(true)).some(({ name }) => name === "Comida"),
    ).toBe(false);
    const { operationId } = await ledger.undoOperation(legacyOperation);
    expect(
      (await ledger.listOperations()).find(({ id }) => id === legacyOperation)
        ?.undone,
    ).toBe(true);
    await ledger.undoOperation(operationId);
    expect(
      await ledger.getExchangeRate({
        from: "USD",
        to: "BOB",
        date: legacyDate,
      }),
    ).toMatchObject({ rate: "7.0000000000" });
  }));

test("M-021B S2: comparte y deduplica tipos de CUCU anteriores y actualiza el patrimonio", () =>
  withLegacyData(async (db) => {
    const date = "1977-11-12";
    const next = "1977-11-13";
    const pair = { from: "USD", to: "BOB" };
    const prefix = "Tipo de cambio oficial BCB vía apibcb.cucu.bo";
    const legacyIds = [randomUUID(), randomUUID()];
    for (const [index, id] of legacyIds.entries()) {
      const source = `${prefix} (variante ${index})`;
      const quote = {
        from_currency: "USD",
        to_currency: "BOB",
        date,
        source,
        rate: "8.0000000000",
      };
      await sql`INSERT INTO operations (id, actor, description) VALUES (${id}, 'claude', 'Registrar tipo de cambio')`.execute(
        db,
      );
      await sql`INSERT INTO exchange_rates (from_currency, to_currency, date, source, rate) VALUES ('USD', 'BOB', ${date}, ${source}, 8)`.execute(
        db,
      );
      await sql`INSERT INTO audit_log (operation_id, table_name, row_id, action, \`after\`) VALUES
        (${id}, 'exchange_rates', ${`USD/BOB/${date}/${source}`}, 'insert', ${JSON.stringify(quote)})`.execute(
        db,
      );
    }
    const audit = () =>
      sql`SELECT operation_id, row_id, \`after\` FROM audit_log ORDER BY id`.execute(
        db,
      );
    const before = (await audit()).rows;
    await ownershipMigration.up(db);
    const rates = () =>
      sql`SELECT user_id, date, source FROM exchange_rates ORDER BY date`.execute(
        db,
      );
    const migrated = (await rates()).rows;
    expect(migrated).toEqual([
      { user_id: "1", date: legacyDate, source: "Tipo previo" },
      { user_id: null, date, source: expect.stringContaining(prefix) },
    ]);
    await ownershipMigration.up(db);
    expect((await rates()).rows).toEqual(migrated);
    expect((await audit()).rows).toEqual(before);

    const ledger = createLedger(db, "web", "1");
    const other = createLedger(db, "web", "2");
    expect(await other.getExchangeRate({ ...pair, date })).toMatchObject({
      rate: "8.0000000000",
    });
    expect((await ledger.getNetWorth({ date: next })).amount).toBe(9241n);
    const official = await ledger.recordOfficialRate({
      ...pair,
      date: next,
      rate: "9",
      source: `${prefix} (nuevo)`,
    });
    expect((await ledger.getNetWorth({ date: next })).amount).toBe(10464n);

    for (const id of [...legacyIds, official.operationId!]) {
      await expect(ledger.undoOperation(id)).rejects.toThrow(UndoConflict);
      await expect(ledger.undoOperation(id)).rejects.toThrow(
        "El tipo de cambio oficial compartido no se puede deshacer.",
      );
    }
    const manual = await ledger.recordExchangeRate({
      ...pair,
      date,
      rate: "10",
      source: `${prefix} (variante 0)`,
    });
    expect(await ledger.getExchangeRate({ ...pair, date })).toMatchObject({
      rate: "10.0000000000",
    });
    await ledger.undoOperation(manual.operationId);
    expect(await ledger.getExchangeRate({ ...pair, date })).toMatchObject({
      rate: "8.0000000000",
    });
  }));

afterAll(async () => {
  reader?.release();
  app?.release();
  migration?.release();
  await Promise.all(pools.map((pool) => pool.end()));
});

test("S1: migrate creates the schema and is idempotent", async () => {
  expect(initialMigration).toMatch(/Migración aplicada:/);
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
    "SELECT table_name AS name, security_type AS security FROM information_schema.views WHERE table_schema = ? ORDER BY BINARY table_name",
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
    "SELECT name, kind, parent_id, currency, is_system FROM accounts WHERE is_system AND parent_id IS NULL ORDER BY name",
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

test("M-008B S13: la migración conserva el ID de la categoría activa o recupera la archivada", async () => {
  const [interest] = await migration.query<RowDataPacket[]>(
    "SELECT id, name, is_system, archived_at FROM accounts WHERE name = 'Intereses' ORDER BY id",
  );
  expect(interest).toEqual([
    {
      id: legacyIncomeInterest,
      name: "Intereses",
      is_system: 1,
      archived_at: null,
    },
    {
      id: archivedExpenseInterest,
      name: "Intereses",
      is_system: 0,
      archived_at: expect.any(String),
    },
    {
      id: legacyExpenseInterest.id,
      name: "Intereses",
      is_system: 1,
      archived_at: null,
    },
  ]);
  const { db } = createDatabase({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  try {
    const ledger = createLedger(db, "web", "1");
    await expect(
      ledger.undoOperation(legacyExpenseInterest.operationId!),
    ).rejects.toThrow(/No se puede deshacer.*accounts\//i);
  } finally {
    await db.destroy();
  }
});

test("S3: audit_log permits inserts and rejects updates and deletes", async () => {
  await migration.beginTransaction();
  try {
    await migration.execute(
      "INSERT INTO audit_log (user_id, operation_id, table_name, row_id, action, `after`) VALUES (1, ?, 'transactions', ?, 'insert', '{}')",
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
    "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, ?, ?)";
  await expect(
    app.execute(insert, [transaction, reportingAccount, "BOB", "0"]),
  ).rejects.toMatchObject({ errno: 4025 });
  await expect(
    app.execute(insert, [transaction, reportingAccount, "BAD", "1"]),
  ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  await expect(
    app.execute(
      "INSERT INTO accounts (user_id, name, kind) VALUES (1, ?, 'bad')",
      [uuid],
    ),
  ).rejects.toMatchObject({ errno: 1265 });
});

test("S4: only active siblings must have distinct names, including roots", async () => {
  await app.beginTransaction();
  try {
    await expect(
      app.execute(
        "INSERT INTO accounts (user_id, name, kind) VALUES (1, 'Ingresos', 'income')",
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await app.execute(
      "INSERT INTO accounts (user_id, name, kind, parent_id) VALUES (1, ?, 'equity', ?)",
      [uuid, reportingAccount],
    );
    await expect(
      app.execute(
        "INSERT INTO accounts (user_id, name, kind, parent_id) VALUES (1, ?, 'equity', ?)",
        [uuid, reportingAccount],
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await app.execute(
      "UPDATE accounts SET archived_at = CURRENT_TIMESTAMP WHERE name = ?",
      [uuid],
    );
    await app.execute(
      "INSERT INTO accounts (user_id, name, kind, parent_id) VALUES (1, ?, 'equity', ?), (1, ?, 'equity', NULL)",
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
      await sql`INSERT INTO postings (user_id, transaction_id, account_id, currency, amount)
        VALUES (1, ${transaction}, ${reportingAccount}, 'BOB', ${"9007199254740993"})`.execute(
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
      await sql`INSERT INTO exchange_rates (user_id, date, from_currency, to_currency, rate, source)
        VALUES (1, '2026-11-24', 'USD', 'BOB', ${"6.9612345678"}, ${uuid})`.execute(
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

async function withReaderScope<T>(run: () => Promise<T>) {
  const lock = randomUUID();
  await reader.execute("SELECT GET_LOCK(?, 0)", [lock]);
  try {
    await app.execute(
      "INSERT INTO readonly_sql_sessions (connection_id, user_id, lock_name, expires_at) VALUES (?, 1, ?, UTC_TIMESTAMP(3) + INTERVAL 10 SECOND)",
      [reader.threadId, lock],
    );
    return await run();
  } finally {
    try {
      await app.execute(
        "DELETE FROM readonly_sql_sessions WHERE connection_id = ? AND lock_name = ?",
        [reader.threadId, lock],
      );
    } finally {
      await reader.execute("SELECT RELEASE_LOCK(?)", [lock]);
    }
  }
}

test("S8: soft-deleted transactions and their postings disappear from the views", () =>
  withReaderScope(async () => {
    await app.execute(
      "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, 'BOB', 1)",
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
  }));

test("S9: only active custom definitions are visible and raw JSON and audit are private", () =>
  withReaderScope(async () => {
    const archived = `archived_${uuid}`;
    await app.execute(
      "INSERT INTO custom_field_definitions (user_id, entity, `key`, label, type, archived_at) VALUES (1, 'transaction', ?, 'Activa', 'text', NULL), (1, 'transaction', ?, 'Archivada', 'text', CURRENT_TIMESTAMP)",
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
        await expect(
          reader.query(`SELECT * FROM ${name}`),
        ).rejects.toMatchObject({ code: "ER_NO_SUCH_TABLE" });
    } finally {
      await app.execute(
        "DELETE FROM custom_field_definitions WHERE `key` IN (?, ?)",
        [uuid, archived],
      );
    }
  }));

test("S10: the app cannot create or drop tables or access the reader schema", async () => {
  for (const statement of [
    "CREATE TABLE denied_ddl (id INT)",
    "DROP TABLE denied_ddl",
    "SELECT * FROM finance_test_ro.v_accounts",
  ])
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
});

test("the migration user can create and drop in finance_test but cannot read mysql", async () => {
  const table = `m001_${uuid.replaceAll("-", "")}`;
  await migration.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
  try {
    await expect(migration.query("USE mysql")).rejects.toMatchObject({
      code: "ER_DBACCESS_DENIED_ERROR",
    });
  } finally {
    await migration.query(`DROP TABLE ${table}`);
  }
});

test("S13: each pooled connection applies strict SQL mode and UTC", async () => {
  const overflow = "9223372036854775808";
  const posting =
    "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, 'BOB', ?)";
  const raw = await createConnection({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  try {
    await raw.query("SET SESSION sql_mode = ''");
    await raw.beginTransaction();
    await raw.execute(posting, [transaction, reportingAccount, overflow]);
    expect((await raw.query("SHOW WARNINGS"))[0]).toEqual([
      expect.objectContaining({ Code: 1264 }),
    ]);
    await raw.execute(
      "INSERT INTO operations (user_id, id, actor, description) VALUES (1, ?, 'invalid', 'Prueba S13')",
      [randomUUID()],
    );
    expect((await raw.query("SHOW WARNINGS"))[0]).toEqual([
      expect.objectContaining({ Code: 1265 }),
    ]);
    await raw.rollback();
  } finally {
    await raw.end();
  }

  const { pool, db } = createDatabase({
    ...localDatabase("DATABASE_URL"),
    database: schema,
  });
  try {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        db.connection().execute(async (connection) => {
          const { rows } = await sql<{
            tz: string;
            mode: string;
          }>`SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode`.execute(
            connection,
          );
          expect(rows[0].tz).toBe("+00:00");
          expect(rows[0].mode.split(",").sort()).toEqual([
            "ERROR_FOR_DIVISION_BY_ZERO",
            "NO_ENGINE_SUBSTITUTION",
            "STRICT_ALL_TABLES",
          ]);
        }),
      ),
    );
    await expect(
      pool
        .promise()
        .execute(posting, [transaction, reportingAccount, overflow]),
    ).rejects.toMatchObject({ errno: 1264 });
    await expect(
      sql`INSERT INTO operations (user_id, id, actor, description)
        VALUES (1, ${randomUUID()}, 'invalid', 'Prueba S13')`.execute(db),
    ).rejects.toMatchObject({ errno: 1265 });
    for (const client of [reader, migration]) {
      const [rows] = await client.query("SELECT @@session.time_zone AS tz");
      expect(rows).toEqual([{ tz: "+00:00" }]);
    }
  } finally {
    await db.destroy();
  }
});

test("S21: MariaDB returns binlog settings as strings and privilege flags as numbers", async () => {
  const preflight = await readFile(
    new URL("../deploy/trigger-preflight.sql", import.meta.url),
    "utf8",
  );
  const [rows] = await migration.query<RowDataPacket[]>(preflight);
  expect(rows).toEqual([
    {
      log_bin: expect.stringMatching(/^[01]$/),
      trust: expect.stringMatching(/^[01]$/),
      can_trigger: 1,
      has_super: 0,
      foreign_definers: 0,
    },
  ]);
});

test("S22: releasing and reacquiring the same connection preserves the session", async () => {
  const { pool, db } = createDatabase({
    ...localDatabase("DATABASE_URL"),
    database: schema,
    connectionLimit: 1,
  });
  const acquire = () => pool.promise().getConnection();
  const session =
    "SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode, @s22_marker AS marker";
  try {
    const first = await acquire();
    const threadId = first.threadId;
    let before;
    try {
      // Detect a reset even if server defaults match the pool settings.
      await first.query("SET @s22_marker = 'retained'");
      [before] = await first.query<RowDataPacket[]>(session);
      expect(before[0].tz).toBe("+00:00");
      expect(before[0].mode.split(",").sort()).toEqual([
        "ERROR_FOR_DIVISION_BY_ZERO",
        "NO_ENGINE_SUBSTITUTION",
        "STRICT_ALL_TABLES",
      ]);
      expect(before[0].marker).toBe("retained");
    } finally {
      first.release();
    }
    const reused = await acquire();
    try {
      expect(reused.threadId).toBe(threadId);
      const [after] = await reused.query(session);
      expect(after).toEqual(before);
    } finally {
      reused.release();
    }
  } finally {
    await db.destroy();
  }
});

test("S15: each subtype is accepted only for its account kind", async () => {
  const insert =
    "INSERT INTO accounts (user_id, name, kind, subtype, currency) VALUES (1, ?, ?, ?, 'BOB')";
  await app.beginTransaction();
  try {
    for (const [kind, subtype] of [
      ["asset", "banco"],
      ["asset", "efectivo"],
      ["asset", "ahorro"],
      ["asset", "inversion"],
      ["asset", "por_cobrar"],
      ["liability", "tarjeta_credito"],
      ["liability", "prestamo_recibido"],
    ]) {
      await app.execute(insert, [subtype, kind, subtype]);
    }
    for (const [kind, subtype] of [
      ["asset", "tarjeta_credito"],
      ["liability", "banco"],
      ["asset", null],
    ]) {
      await expect(
        app.execute(insert, [randomUUID(), kind, subtype]),
      ).rejects.toMatchObject({ errno: 4025 });
    }
  } finally {
    await app.rollback();
  }
});

test("S16: operations in the same millisecond have insertion order and a single undo", async () => {
  const first = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const second = "00000000-0000-0000-0000-000000000001";
  const insert =
    "INSERT INTO operations (user_id, id, actor, description, undoes_operation_id, created_at) VALUES (1, ?, 'web', 'Prueba S16', ?, '2026-11-24 12:34:56.123')";
  await app.beginTransaction();
  try {
    await app.execute(insert, [first, null]);
    await app.execute(insert, [second, first]);
    const [rows] = await app.execute(
      "SELECT id FROM operations WHERE id IN (?, ?) ORDER BY seq",
      [first, second],
    );
    expect(rows).toEqual([{ id: first }, { id: second }]);
    await expect(
      app.execute(insert, [randomUUID(), first]),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  } finally {
    await app.rollback();
  }
});

test("S17: same-currency rates are rejected and timestamps accept 2040 with milliseconds", async () => {
  await expect(
    app.execute(
      "INSERT INTO exchange_rates (user_id, date, from_currency, to_currency, rate, source) VALUES (1, '2040-01-01', 'BOB', 'BOB', 1, 'Prueba S17')",
    ),
  ).rejects.toMatchObject({ errno: 4025 });
  await app.beginTransaction();
  try {
    await app.execute(
      "UPDATE transactions SET created_at = '2040-01-01 00:00:00.123' WHERE id = ?",
      [transaction],
    );
    const [rows] = await app.execute(
      "SELECT CAST(created_at AS CHAR) AS created_at FROM transactions WHERE id = ?",
      [transaction],
    );
    expect(rows).toEqual([{ created_at: "2040-01-01 00:00:00.123" }]);
    const [timestamps] = await app.query<RowDataPacket[]>(
      "SELECT data_type, datetime_precision FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name IN ('created_at', 'updated_at', 'archived_at', 'deleted_at')",
    );
    expect(timestamps.length).toBeGreaterThan(0);
    expect(
      timestamps.every(
        (row) =>
          row.data_type === "datetime" && Number(row.datetime_precision) === 3,
      ),
    ).toBe(true);
    const [index] = await app.query<RowDataPacket[]>(
      "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_in_index FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'audit_log' GROUP BY index_name",
    );
    expect(index).toContainEqual({ columns_in_index: "table_name,row_id" });
  } finally {
    await app.rollback();
  }
});

test("S18: reporting shows archived accounts, posting details and active transaction tags", async () => {
  await migration.query("CREATE VIEW finance_test_ro.v_obsoleta AS SELECT 1");
  expect(migrate()).toMatch(/Sin migraciones pendientes/);
  await expect(reader.query("SELECT * FROM v_obsoleta")).rejects.toMatchObject({
    code: "ER_NO_SUCH_TABLE",
  });
  await expect(
    migration.query("UPDATE finance_test_ro.v_tags SET name = 'Prueba S18'"),
  ).rejects.toMatchObject({ code: "ER_NON_UPDATABLE_TABLE" });
  await migration.execute(
    "UPDATE accounts SET archived_at = '2026-11-24 00:00:00.123' WHERE id = ?",
    [reportingAccount],
  );
  await app.execute(
    "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, 'BOB', 1)",
    [transaction, reportingAccount],
  );
  await app.execute(
    "INSERT INTO tags (user_id, name) VALUES (1, 'Prueba S18')",
  );
  await app.execute(
    "INSERT INTO transaction_tags (user_id, transaction_id, tag_id) SELECT 1, ?, id FROM tags WHERE name = 'Prueba S18'",
    [transaction],
  );
  try {
    await withReaderScope(async () => {
      const [accounts] = await reader.execute(
        "SELECT CAST(archived_at AS CHAR) AS archived_at FROM v_accounts WHERE id = ?",
        [reportingAccount],
      );
      expect(accounts).toEqual([{ archived_at: "2026-11-24 00:00:00.123" }]);
      const [postings] = await reader.execute(
        "SELECT account_kind, CAST(transaction_date AS CHAR) AS transaction_date FROM v_postings WHERE transaction_id = ?",
        [transaction],
      );
      expect(postings).toEqual([
        { account_kind: "equity", transaction_date: "2026-11-24" },
      ]);
      const tags = () =>
        reader.execute(
          "SELECT * FROM v_transaction_tags WHERE transaction_id = ?",
          [transaction],
        );
      expect((await tags())[0]).toHaveLength(1);
      await app.execute(
        "UPDATE transactions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
        [transaction],
      );
      expect((await tags())[0]).toEqual([]);
    });
  } finally {
    await migration.execute(
      "UPDATE accounts SET archived_at = NULL WHERE id = ?",
      [reportingAccount],
    );
    await app.execute(
      "UPDATE transactions SET deleted_at = NULL WHERE id = ?",
      [transaction],
    );
    await app.execute("DELETE FROM postings WHERE transaction_id = ?", [
      transaction,
    ]);
    await app.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [
      transaction,
    ]);
    await app.execute("DELETE FROM tags WHERE name = 'Prueba S18'");
  }
}, 15_000);

async function checkRestore(encrypted: boolean) {
  const fixture = await mkdtemp(join(tmpdir(), "finance-restore-"));
  const { host, port, user, password } = localDatabase(
    "MIGRATION_DATABASE_URL",
  );
  const windows = process.platform === "win32";
  const clientDir = windows ? join(setting("MARIADB_HOME"), "bin") : undefined;
  const client = (name: string) =>
    clientDir ? join(clientDir, `${name}.exe`) : name;
  const shellPath = (path: string) => path.replaceAll("\\", "/");
  const options = shellPath(join(fixture, "mysql.cnf"));
  const dump = () =>
    execFileSync(client("mysqldump"), [
      `--defaults-file=${options}`,
      "--single-transaction",
      "--skip-dump-date",
      "--order-by-primary",
      schema,
    ]);
  const invoke = (action: string) =>
    execFileSync(
      windows
        ? resolve(
            execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
            "../../../bin/bash.exe",
          )
        : "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; options=$2; backup=$3; database=$4; client_dir=$5; PATH="${client_dir:+$client_dir:}$PATH"; run_logged() { "$@"; }; "$6"',
        "s20",
        shellPath(resolve("src/deploy/database.sh")),
        options,
        shellPath(join(fixture, "backup.sql")),
        schema,
        clientDir ? shellPath(clientDir).replace(/^([A-Za-z]):/, "/$1") : "",
        action,
      ],
    );
  try {
    await writeFile(
      options,
      `[client]\nhost=${host}\nport=${port}\nuser=${JSON.stringify(user)}\npassword=${JSON.stringify(password)}\n`,
      { mode: 0o600 },
    );
    // Windows runs Bash, flock and GPG in WSL and uses the host database clients.
    const bash = (command: string, ...args: string[]) =>
      execFileSync(
        windows ? "wsl.exe" : "bash",
        [
          ...(windows ? ["--exec", "bash"] : []),
          "-c",
          command,
          "m007",
          ...args,
        ],
        { encoding: "utf8" },
      ).trim();
    let backupRoot: string | undefined;
    const daily = (command: string) =>
      bash(
        `set -euo pipefail
        export DEPLOY_ROOT=$1 DEPLOY_DB_NAME=finance_test BACKUP_RCLONE_REMOTE=
        export GNUPGHOME="$1/gnupg" TMPDIR="$1/tmp"
        script=$2
        export DEPLOY_DB_OPTIONS=$3
        if [[ -n $4 ]]; then
          script=$(wslpath -u "$2")
          export DEPLOY_DB_OPTIONS=$(wslpath -u "$3")
          export TEST_MARIA_BIN=$(wslpath -u "$4") TEST_NODE=$(wslpath -u "$5")
          export PATH="$1/bin:$PATH"
        fi
        ${command}`,
        backupRoot!,
        shellPath(resolve("src/deploy/backup.sh")),
        options,
        clientDir ? shellPath(clientDir) : "",
        shellPath(process.execPath),
      );
    if (encrypted) {
      backupRoot = bash("mktemp -d");
      try {
        daily(`umask 077
          mkdir "$1"/{shared,gnupg,tmp,bin}
          touch "$1/shared/.env"
          gpg --gen-random --armor 2 32 > "$1/shared/backup.passphrase"
          if [[ -n $4 ]]; then
            cat > "$1/bin/mysql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
name=\${0##*/}
options=$(wslpath -w "\${1#--defaults-file=}")
shift
if [[ $name == mysql && $* == *--skip-column-names* ]]; then
  "$TEST_MARIA_BIN/$name.exe" "--defaults-file=$options" "$@" | sed 's/\\r$//'
  exit
fi
exec "$TEST_MARIA_BIN/$name.exe" "--defaults-file=$options" "$@"
SH
            cat > "$1/bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
options=
if [[ -n $4 ]]; then options=$(wslpath -w "$4"); fi
exec "$TEST_NODE" "$1" "$2" "$(wslpath -w "$3")" "$options" "$(wslpath -w "$5")"
SH
            chmod +x "$1/bin/"*
            ln -s mysql "$1/bin/mysqldump"
          fi`);
      } catch (error) {
        bash('rm -r -- "$1"', backupRoot);
        throw error;
      }
    }
    try {
      await migration.query(
        "CREATE VIEW restore_fixture AS SELECT id, active_parent_id FROM accounts",
      );
      await migration.query(
        "CREATE TRIGGER restore_fixture_trigger BEFORE INSERT ON tags FOR EACH ROW SET NEW.name = CONCAT(NEW.name, '!')",
      );
      await migration.query(
        "INSERT INTO tags (user_id, name) VALUES (1, 'Ida y vuelta')",
      );
      await migration.execute(
        "INSERT INTO transaction_tags (user_id, transaction_id, tag_id) SELECT 1, ?, id FROM tags WHERE name = 'Ida y vuelta!'",
        [transaction],
      );
      await migration.execute(
        "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, 'BOB', ?)",
        [transaction, reportingAccount, "9007199254740993"],
      );
      await migration.execute(
        "INSERT INTO audit_log (user_id, operation_id, table_name, row_id, action, `after`) VALUES (1, ?, 'transactions', ?, 'insert', '{}')",
        [uuid, transaction],
      );
      await migration.execute(
        "UPDATE transactions SET custom = ? WHERE id = ?",
        [
          JSON.stringify({
            label: "prueba ñ",
            lines: ["a\nb", "DELIMITER ;;"],
          }),
          transaction,
        ],
      );
      const before = dump();
      const readonlyDefinitions = () =>
        Promise.all(
          views.map(
            async (view) =>
              (
                await migration.query(
                  `SHOW CREATE VIEW ${readOnlySchema}.${view}`,
                )
              )[0],
          ),
        );
      const beforeViews = await readonlyDefinitions();
      if (encrypted) {
        daily(
          'bash "$script" run; files=("$1"/shared/backups/daily/*.sql.gz.gpg); [[ ${#files[@]} == 1 ]]; bash "$script" verify "${files[0]}"',
        );
      } else {
        invoke("backup_database");
      }
      await migration.query("DROP VIEW restore_fixture");
      await migration.query("CREATE TABLE orphan (id INT)");
      await migration.query("DELETE FROM transaction_tags");
      await migration.query("DELETE FROM tags");
      if (encrypted) {
        daily(
          'files=("$1"/shared/backups/daily/*.sql.gz.gpg); bash "$script" restore "${files[0]}" --yes',
        );
        await migration.query("DROP VIEW finance_test_ro.v_tags");
        expect(migrate()).toMatch(/Sin migraciones pendientes/);
      } else {
        invoke("restore_database");
      }
      expect(dump().equals(before)).toBe(true);
      expect(await readonlyDefinitions()).toEqual(beforeViews);
      expect(
        (
          await withReaderScope(() =>
            reader.execute("SELECT id FROM v_transactions WHERE id = ?", [
              transaction,
            ]),
          )
        )[0],
      ).toHaveLength(1);
      expect(
        (
          await migration.query(
            "SELECT name FROM tags WHERE name = 'Ida y vuelta!'",
          )
        )[0],
      ).toEqual([{ name: "Ida y vuelta!" }]);
      await expect(
        migration.query("DELETE FROM audit_log"),
      ).rejects.toMatchObject({
        sqlState: "45000",
      });
      await expect(
        migration.execute(
          "INSERT INTO postings (user_id, transaction_id, account_id, currency, amount) VALUES (1, ?, ?, 'BAD', 1)",
          [transaction, reportingAccount],
        ),
      ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    } finally {
      if (backupRoot) bash('rm -r -- "$1"', backupRoot);
      await migration.query("DROP VIEW IF EXISTS restore_fixture");
      await migration.query(
        "DELETE tt FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id WHERE t.name = 'Ida y vuelta!'",
      );
      await migration.query("DELETE FROM tags WHERE name = 'Ida y vuelta!'");
    }
  } finally {
    try {
      await migration.query("DROP TRIGGER IF EXISTS restore_fixture_trigger");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}

test(
  "S20: the deploy backup restores data, views, foreign keys, virtual columns and triggers",
  () => checkRestore(false),
  30_000,
);
test.skipIf(
  process.platform === "win32" && process.env.FINANCE_TEST_WSL_BACKUP !== "1",
)(
  "M-007 S6: GPG backup, verify and restore round trip with MariaDB",
  () => checkRestore(true),
  60_000,
);

ledgerSpecs(() => ({ migration, reader }));
googleSpecs(schema, readOnlySchema);
authSpecs(() => ({ app, reader }));
mcpSpecs(() => migration, schema, readOnlySchema);
multiuserSpecs(schema, readOnlySchema);
dashboardSpecs(schema);
accountSpecs(schema, readOnlySchema);
