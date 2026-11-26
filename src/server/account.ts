import { decimalMoney } from "@finance-manager/core";
import { sql } from "kysely";
import { authTransaction, type AuthDb } from "./auth-store.js";

const tables = [
  "goal_accounts",
  "goals",
  "transaction_tags",
  "postings",
  "transactions",
  "loans",
  "tags",
  "custom_field_definitions",
  "exchange_rates",
] as const;
const exportTables = [
  ...tables,
  "accounts",
  "operations",
  "audit_log",
] as const;
type ExportTable = (typeof exportTables)[number];
type Row = Record<string, unknown>;

function exportRow(
  table: ExportTable,
  row: Row,
  scales: ReadonlyMap<string, number>,
) {
  const columns =
    table === "postings"
      ? ["amount"]
      : table === "loans"
        ? ["principal", "principal_paid", "interest_paid", "interest_carry"]
        : table === "goals"
          ? ["target_amount"]
          : [];
  for (const column of columns) {
    const value = row[column];
    if (typeof value === "string" && typeof row.currency === "string")
      row[column] = decimalMoney(BigInt(value), row.currency, scales).monto;
  }
  for (const column of ["custom", "options", "before", "after"]) {
    if (typeof row[column] !== "string") continue;
    const value: unknown = JSON.parse(row[column]);
    row[column] =
      table === "audit_log" && value && typeof value === "object"
        ? exportRow(row.table_name as ExportTable, value as Row, scales)
        : value;
  }
  return row;
}

export function exportAccount(db: AuthDb, userId: string) {
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const { rows: currencies } = await sql<{
        code: string;
        minor_unit: number;
      }>`
      SELECT code, minor_unit FROM currencies
    `.execute(trx);
      const scales = new Map(
        currencies.map(({ code, minor_unit }) => [code, minor_unit]),
      );
      const {
        rows: [profile],
      } = await sql`
      SELECT id, email, display_name, created_at, last_seen_at FROM users
      WHERE id = CAST(${userId} AS UNSIGNED)
    `.execute(trx);
      const records: Record<string, Row[]> = {};
      for (const table of exportTables) {
        const { rows } = await sql<Row>`
        SELECT * FROM ${sql.table(table)} WHERE user_id = CAST(${userId} AS UNSIGNED)
      `.execute(trx);
        records[table] = rows.map((row) => exportRow(table, row, scales));
      }
      return { profile, ...records };
    });
}

export function deleteAccount(
  db: AuthDb,
  active: { userId: string; hash: Buffer },
) {
  return authTransaction(db, async (trx) => {
    const user = sql`CAST(${active.userId} AS UNSIGNED)`;
    const { rows } =
      await sql`SELECT id FROM users WHERE id = ${user} FOR UPDATE`.execute(
        trx,
      );
    if (!rows.length) return "inactive";
    const {
      rows: [session],
    } = await sql<{ recent: number }>`
      SELECT created_at >= UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE AS recent
      FROM web_sessions WHERE token_hash = ${active.hash} AND user_id = ${user}
        AND expires_at > UTC_TIMESTAMP(3) AND revoked_at IS NULL FOR UPDATE
    `.execute(trx);
    if (!session) return "inactive";
    if (!session.recent) return "stale";

    for (const table of tables)
      await sql`DELETE FROM ${sql.table(table)} WHERE user_id = ${user}`.execute(
        trx,
      );
    // Desvincula jerarquías y deshacer sin depender de la profundidad de la cascada.
    await sql`UPDATE accounts SET parent_id = NULL, loan_interest = NULL,
        archived_at = COALESCE(archived_at, UTC_TIMESTAMP(3))
      WHERE user_id = ${user} AND parent_id IS NOT NULL`.execute(trx);
    await sql`DELETE FROM accounts WHERE user_id = ${user}`.execute(trx);
    await sql`UPDATE operations SET undoes_operation_id = NULL
      WHERE user_id = ${user} AND undoes_operation_id IS NOT NULL`.execute(trx);
    await sql`DELETE FROM users WHERE id = ${user}`.execute(trx);
    return "deleted";
  });
}
