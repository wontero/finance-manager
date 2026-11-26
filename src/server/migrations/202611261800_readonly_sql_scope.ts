import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  await sql`CREATE TABLE IF NOT EXISTS readonly_sql_sessions (
    connection_id BIGINT UNSIGNED PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    lock_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS readonly_sql_schema (
    name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY
  ) ENGINE=InnoDB`.execute(db);
}
