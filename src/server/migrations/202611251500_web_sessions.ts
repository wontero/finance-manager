import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  await sql`CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash BINARY(32) PRIMARY KEY,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    INDEX web_sessions_expiry (expires_at)
  ) ENGINE=InnoDB`.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable("web_sessions").ifExists().execute();
}
