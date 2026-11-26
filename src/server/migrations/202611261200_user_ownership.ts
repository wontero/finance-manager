import { sql, type Kysely } from "kysely";
import { cucuSourcePrefix } from "../ledger/schema.js";

export async function up(db: Kysely<unknown>) {
  await sql`CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    google_sub VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
    email VARCHAR(320),
    display_name VARCHAR(255),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(
    db,
  );
  await sql`INSERT IGNORE INTO users (id) VALUES (1)`.execute(db);

  const ownership = [
    [
      "accounts",
      sql`
      ADD UNIQUE INDEX IF NOT EXISTS accounts_user_id (user_id, id),
      ADD UNIQUE INDEX IF NOT EXISTS accounts_user_sibling (user_id, active_parent_id, name),
      ADD UNIQUE INDEX IF NOT EXISTS accounts_user_interest (user_id, loan_interest),
      DROP INDEX IF EXISTS accounts_active_sibling_name,
      DROP INDEX IF EXISTS loan_interest`,
    ],
    [
      "operations",
      sql`
      ADD UNIQUE INDEX IF NOT EXISTS operations_user_id (user_id, id),
      ADD UNIQUE INDEX IF NOT EXISTS operations_user_undo (user_id, undoes_operation_id),
      ADD INDEX IF NOT EXISTS operations_user_seq (user_id, seq)`,
    ],
    [
      "transactions",
      sql`
      ADD UNIQUE INDEX IF NOT EXISTS transactions_user_id (user_id, id),
      ADD INDEX IF NOT EXISTS transactions_user_created (user_id, created_at),
      ADD INDEX IF NOT EXISTS transactions_user_date (user_id, date)`,
    ],
    [
      "postings",
      sql`ADD INDEX IF NOT EXISTS postings_user_account (user_id, account_id)`,
    ],
    [
      "tags",
      sql`
      ADD UNIQUE INDEX IF NOT EXISTS tags_user_id (user_id, id),
      ADD UNIQUE INDEX IF NOT EXISTS tags_user_name (user_id, name),
      DROP INDEX IF EXISTS name`,
    ],
    [
      "transaction_tags",
      sql`ADD INDEX IF NOT EXISTS transaction_tags_user_tag (user_id, tag_id)`,
    ],
    [
      "custom_field_definitions",
      sql`
      ADD UNIQUE INDEX IF NOT EXISTS custom_fields_user_key (user_id, entity, \`key\`),
      DROP INDEX IF EXISTS entity`,
    ],
    [
      "loans",
      sql`ADD UNIQUE INDEX IF NOT EXISTS loans_user_account (user_id, account_id)`,
    ],
    [
      "audit_log",
      sql`ADD INDEX IF NOT EXISTS audit_user_row (user_id, table_name, row_id, id)`,
    ],
  ] as const;
  for (const [table, indexes] of ownership) {
    const fk = sql.id(table + "_user_fk");
    // Agregar con DEFAULT rellena la propiedad sin actualizar filas ni disparar la auditoría.
    await sql`ALTER TABLE ${sql.table(table)}
      ADD COLUMN IF NOT EXISTS user_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
      ADD CONSTRAINT ${fk} FOREIGN KEY IF NOT EXISTS ${fk} (user_id) REFERENCES users(id),
      ${indexes}`.execute(db);
  }
  const references = [
    ["accounts", "parent_id", "accounts", 1],
    ["operations", "undoes_operation_id", "operations", 1],
    ["transactions", "operation_id", "operations", 1],
    ["postings", "transaction_id", "transactions", 1],
    ["postings", "account_id", "accounts", 2],
    ["transaction_tags", "transaction_id", "transactions", 1],
    ["transaction_tags", "tag_id", "tags", 2],
    ["loans", "account_id", "accounts", 1],
    ["audit_log", "operation_id", "operations", 1],
  ] as const;
  for (const [table, column, target, previous] of references) {
    const fk = sql.id(table + "_user_" + column + "_fk");
    await sql`ALTER TABLE ${sql.table(table)}
      ADD CONSTRAINT ${fk} FOREIGN KEY IF NOT EXISTS ${fk}
        (user_id, ${sql.id(column)}) REFERENCES ${sql.table(target)}(user_id, id),
      DROP FOREIGN KEY IF EXISTS ${sql.id(table + "_ibfk_" + previous)}`.execute(
      db,
    );
  }
  await sql`ALTER TABLE operations DROP INDEX IF EXISTS undoes_operation_id`.execute(
    db,
  );
  await sql`ALTER TABLE loans DROP INDEX IF EXISTS account_id`.execute(db);

  const { rows } = await sql`SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchange_rates' AND COLUMN_NAME = 'id'`.execute(
    db,
  );
  if (!rows.length) {
    await sql`ALTER TABLE exchange_rates
      DROP PRIMARY KEY,
      ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ADD COLUMN user_id BIGINT UNSIGNED NULL DEFAULT 1,
      ADD COLUMN owner_key BIGINT UNSIGNED AS (COALESCE(user_id, 0)) VIRTUAL,
      ADD COLUMN owner_source VARCHAR(160) AS (IF(user_id IS NULL, '', source)) VIRTUAL,
      ADD UNIQUE INDEX exchange_rates_owner_quote (owner_key, from_currency, to_currency, date, owner_source),
      ADD INDEX exchange_rates_pair_date (from_currency, to_currency, date),
      ADD CONSTRAINT exchange_rates_user_fk FOREIGN KEY (user_id) REFERENCES users(id)`.execute(
      db,
    );
  }
  for (const [table] of ownership) {
    await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN user_id DROP DEFAULT`.execute(
      db,
    );
  }
  await sql`ALTER TABLE exchange_rates ALTER COLUMN user_id SET DEFAULT NULL`.execute(
    db,
  );
  const source = `${cucuSourcePrefix}%`;
  await db.transaction().execute(async (trx) => {
    await sql`DELETE legacy FROM exchange_rates AS legacy
      INNER JOIN exchange_rates AS preferred
        ON preferred.from_currency = legacy.from_currency
        AND preferred.to_currency = legacy.to_currency
        AND preferred.date = legacy.date
        AND (preferred.user_id IS NULL OR
          (preferred.id < legacy.id AND BINARY preferred.source LIKE ${source}))
      WHERE legacy.user_id IS NOT NULL AND BINARY legacy.source LIKE ${source}`.execute(
      trx,
    );
    await sql`UPDATE exchange_rates SET user_id = NULL
      WHERE user_id IS NOT NULL AND BINARY source LIKE ${source}`.execute(trx);
  });
}
