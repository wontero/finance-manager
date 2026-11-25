import { sql, type Kysely } from "kysely";

export async function createReadonlyViews(
  db: Kysely<unknown>,
  main: string,
  readonly: string,
) {
  const table = (name: string) => sql.id(main, name);
  const views = {
    v_accounts: sql`SELECT id, parent_id, name, kind, subtype, currency, is_system,
      created_at, updated_at FROM ${table("accounts")} WHERE archived_at IS NULL`,
    v_transactions: sql`SELECT id, date, description, note, operation_id, created_at, updated_at
      FROM ${table("transactions")} WHERE deleted_at IS NULL`,
    v_postings: sql`SELECT p.id, p.transaction_id, p.account_id, a.name AS account_name,
      p.currency, p.amount, p.memo FROM ${table("postings")} AS p
      JOIN ${table("accounts")} AS a ON a.id = p.account_id
      JOIN ${table("transactions")} AS t ON t.id = p.transaction_id
      WHERE t.deleted_at IS NULL`,
    v_tags: sql`SELECT id, name FROM ${table("tags")}`,
    v_exchange_rates: sql`SELECT date, from_currency, to_currency, rate, source
      FROM ${table("exchange_rates")}`,
    v_custom_field_definitions: sql`SELECT id, entity, \`key\`, label, type, options
      FROM ${table("custom_field_definitions")} WHERE archived_at IS NULL`,
  };
  for (const [name, select] of Object.entries(views)) {
    await sql`CREATE OR REPLACE SQL SECURITY DEFINER VIEW ${sql.id(readonly, name)}
      AS ${select}`.execute(db);
  }
}
