import { sql, type Kysely } from "kysely";

export async function createReadonlyViews(
  db: Kysely<unknown>,
  main: string,
  readonly: string,
) {
  const table = (name: string) => sql.id(main, name);
  const views = {
    v_accounts: sql`SELECT id, parent_id, name, kind, subtype, currency, is_system,
      archived_at, created_at, updated_at FROM ${table("accounts")}`,
    v_transactions: sql`SELECT id, date, description, note, operation_id, created_at, updated_at
      FROM ${table("transactions")} WHERE deleted_at IS NULL`,
    v_postings: sql`SELECT p.id, p.transaction_id, p.account_id, a.name AS account_name,
      a.kind AS account_kind, t.date AS transaction_date, p.currency, p.amount, p.memo
      FROM ${table("postings")} AS p
      JOIN ${table("accounts")} AS a ON a.id = p.account_id
      JOIN ${table("transactions")} AS t ON t.id = p.transaction_id
      WHERE t.deleted_at IS NULL`,
    v_tags: sql`SELECT id, name FROM ${table("tags")}`,
    v_transaction_tags: sql`SELECT tt.transaction_id, tt.tag_id
      FROM ${table("transaction_tags")} AS tt
      JOIN ${table("transactions")} AS t ON t.id = tt.transaction_id
      WHERE t.deleted_at IS NULL`,
    v_exchange_rates: sql`SELECT date, from_currency, to_currency, rate, source
      FROM ${table("exchange_rates")}`,
    v_custom_field_definitions: sql`SELECT id, entity, \`key\`, label, type, options
      FROM ${table("custom_field_definitions")} WHERE archived_at IS NULL`,
  };
  const { rows: existing } = await sql<{ name: string }>`
    SELECT TABLE_NAME AS name FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA = ${readonly} AND LEFT(TABLE_NAME, 2) = 'v_'
  `.execute(db);
  for (const { name } of existing) {
    if (!Object.hasOwn(views, name))
      await sql`DROP VIEW IF EXISTS ${sql.id(readonly, name)}`.execute(db);
  }
  for (const [name, select] of Object.entries(views)) {
    await sql`CREATE OR REPLACE ALGORITHM=TEMPTABLE SQL SECURITY DEFINER VIEW ${sql.id(readonly, name)}
      AS ${select}`.execute(db);
  }
}
