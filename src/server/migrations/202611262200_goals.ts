import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  await sql`CREATE TABLE IF NOT EXISTS goals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    type ENUM('savings', 'spending') NOT NULL,
    target_amount BIGINT NOT NULL,
    currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    start_date DATE,
    end_date DATE,
    category_id BIGINT UNSIGNED,
    archived_at DATETIME(3),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY goals_user_id (user_id, id),
    UNIQUE KEY goals_user_name (user_id, name),
    CONSTRAINT goals_target CHECK (target_amount > 0),
    CONSTRAINT goals_dates CHECK (end_date >= start_date),
    CONSTRAINT goals_type CHECK (
      (type = 'savings' AND category_id IS NULL) OR
      (type = 'spending' AND category_id IS NOT NULL AND
        ((start_date IS NULL AND end_date IS NULL) OR
         (start_date IS NOT NULL AND end_date IS NOT NULL)))
    ),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (user_id, category_id) REFERENCES accounts(user_id, id),
    FOREIGN KEY (currency) REFERENCES currencies(code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(
    db,
  );

  await sql`CREATE TABLE IF NOT EXISTS goal_accounts (
    user_id BIGINT UNSIGNED NOT NULL,
    goal_id BIGINT UNSIGNED NOT NULL,
    account_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (user_id, goal_id, account_id),
    FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
  ) ENGINE=InnoDB`.execute(db);
}
