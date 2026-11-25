import { sql, type Kysely } from "kysely";

const readonlyViews = {
  v_accounts: [
    "id",
    "parent_id",
    "name",
    "kind",
    "subtype",
    "currency",
    "is_system",
    "archived_at",
    "created_at",
    "updated_at",
  ],
  v_transactions: [
    "id",
    "date",
    "description",
    "note",
    "operation_id",
    "created_at",
    "updated_at",
  ],
  v_postings: [
    "p.id",
    "p.transaction_id",
    "p.account_id",
    ["account_name", "a.name"],
    ["account_kind", "a.kind"],
    ["transaction_date", "t.date"],
    "p.currency",
    "p.amount",
    "p.memo",
  ],
  v_tags: ["id", "name"],
  v_transaction_tags: ["tt.transaction_id", "tt.tag_id"],
  v_exchange_rates: ["date", "from_currency", "to_currency", "rate", "source"],
  v_custom_field_definitions: [
    "id",
    "entity",
    "key",
    "label",
    "type",
    "options",
  ],
  v_loans: [
    "id",
    "account_id",
    "direction",
    "counterparty",
    "currency",
    "principal",
    "start_date",
    "rate",
    "rate_period",
    "due_date",
    "notes",
    "last_payment_date",
    "principal_paid",
    "interest_paid",
    "closed_at",
    "created_at",
    "updated_at",
  ],
} satisfies Record<string, (string | [alias: string, source: string])[]>;

const columnName = (column: string | [string, string]) =>
  typeof column === "string" ? column.split(".").at(-1)! : column[0];

export const readonlyViewDescription = Object.entries(readonlyViews)
  .map(([name, columns]) => `${name}(${columns.map(columnName).join(", ")})`)
  .join("; ");

export async function createReadonlyViews(
  db: Kysely<unknown>,
  main: string,
  readonly: string,
) {
  const table = (name: string) => sql.id(main, name);
  const sources = {
    v_accounts: sql`FROM ${table("accounts")}`,
    v_transactions: sql`FROM ${table("transactions")} WHERE deleted_at IS NULL`,
    v_postings: sql`FROM ${table("postings")} AS p
      JOIN ${table("accounts")} AS a ON a.id = p.account_id
      JOIN ${table("transactions")} AS t ON t.id = p.transaction_id
      WHERE t.deleted_at IS NULL`,
    v_tags: sql`FROM ${table("tags")}`,
    v_transaction_tags: sql`FROM ${table("transaction_tags")} AS tt
      JOIN ${table("transactions")} AS t ON t.id = tt.transaction_id
      WHERE t.deleted_at IS NULL`,
    v_exchange_rates: sql`FROM ${table("exchange_rates")}`,
    v_custom_field_definitions: sql`FROM ${table("custom_field_definitions")} WHERE archived_at IS NULL`,
    v_loans: sql`FROM ${table("loans")}`,
  } satisfies Record<keyof typeof readonlyViews, unknown>;
  const { rows: existing } = await sql<{ name: string }>`
    SELECT TABLE_NAME AS name FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA = ${readonly} AND LEFT(TABLE_NAME, 2) = 'v_'
  `.execute(db);
  for (const { name } of existing) {
    if (!Object.hasOwn(readonlyViews, name))
      await sql`DROP VIEW IF EXISTS ${sql.id(readonly, name)}`.execute(db);
  }
  for (const name of Object.keys(
    readonlyViews,
  ) as (keyof typeof readonlyViews)[]) {
    const columns = readonlyViews[name].map((column) =>
      typeof column === "string"
        ? sql.id(...column.split("."))
        : sql`${sql.id(...column[1].split("."))} AS ${sql.id(column[0])}`,
    );
    await sql`CREATE OR REPLACE ALGORITHM=TEMPTABLE SQL SECURITY DEFINER VIEW ${sql.id(readonly, name)}
      AS SELECT ${sql.join(columns)} ${sources[name]}`.execute(db);
  }
}
