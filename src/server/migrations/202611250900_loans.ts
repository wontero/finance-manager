import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  await sql`ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS loan_interest ENUM('income', 'expense') UNIQUE,
    ADD CONSTRAINT IF NOT EXISTS accounts_loan_interest CHECK (
      loan_interest IS NULL OR (
        is_system = TRUE AND kind = loan_interest
        AND parent_id IS NOT NULL AND archived_at IS NULL
      )
    )`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS loans (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL UNIQUE,
    direction ENUM('given', 'received') NOT NULL,
    counterparty VARCHAR(160) NOT NULL,
    currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal BIGINT NOT NULL,
    start_date DATE NOT NULL,
    rate DECIMAL(9,6) NOT NULL,
    rate_period ENUM('monthly', 'annual') NOT NULL,
    due_date DATE,
    notes TEXT,
    last_payment_date DATE,
    principal_paid BIGINT NOT NULL DEFAULT 0,
    interest_paid DECIMAL(38,0) NOT NULL DEFAULT 0,
    interest_carry DECIMAL(38,0) NOT NULL DEFAULT 0,
    closed_at DATETIME(3),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT loans_amounts CHECK (
      principal > 0 AND rate >= 0 AND principal_paid BETWEEN 0 AND principal
      AND interest_paid >= 0
    ),
    CONSTRAINT loans_dates CHECK (due_date >= start_date AND last_payment_date >= start_date),
    INDEX loans_counterparty_idx (counterparty),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (currency) REFERENCES currencies(code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(
    db,
  );

  await sql`INSERT INTO accounts (id, parent_id, name, kind, is_system, loan_interest)
    SELECT (
      SELECT existing.id
      FROM accounts AS existing
      WHERE existing.parent_id = root.id AND existing.kind = root.kind
        AND existing.name = 'Intereses'
      ORDER BY (existing.archived_at IS NULL) DESC, existing.id DESC
      LIMIT 1
    ), root.id, 'Intereses', root.kind, TRUE, root.kind
    FROM accounts AS root
    WHERE root.is_system = TRUE AND root.parent_id IS NULL
      AND root.kind IN ('income', 'expense')
    ON DUPLICATE KEY UPDATE
      name = VALUES(name), is_system = TRUE, archived_at = NULL,
      loan_interest = VALUES(loan_interest)`.execute(db);
}
