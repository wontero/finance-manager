import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  for (const name of [
    "oauth_tokens",
    "web_sessions",
    "oauth_authorization_codes",
  ]) {
    const table = sql.table(name);
    const foreignKey = sql.id(name + "_user_fk");
    await sql`ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS user_id BIGINT UNSIGNED NULL,
      ADD INDEX IF NOT EXISTS auth_owner (user_id),
      ADD CONSTRAINT ${foreignKey} FOREIGN KEY IF NOT EXISTS ${foreignKey}
        (user_id) REFERENCES users(id) ON DELETE CASCADE`.execute(db);
    const legacy =
      name === "oauth_authorization_codes"
        ? sql`user_id IS NULL AND phase <> 'login'`
        : sql`user_id IS NULL`;
    await sql`DELETE FROM ${table} WHERE ${legacy}`.execute(db);
    if (name !== "oauth_authorization_codes")
      await sql`ALTER TABLE ${table} MODIFY user_id BIGINT UNSIGNED NOT NULL`.execute(
        db,
      );
  }
  await sql`CREATE TABLE IF NOT EXISTS google_login_requests (
    state_hash BINARY(32) PRIMARY KEY,
    browser_hash BINARY(32) NOT NULL,
    verifier CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    for_oauth BOOLEAN NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX google_login_expiry (expires_at)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS user_request_limits (
    user_id BIGINT UNSIGNED PRIMARY KEY,
    minute_bucket BIGINT UNSIGNED NOT NULL,
    hits INT UNSIGNED NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`.execute(db);
  // Old login forms must not be able to continue into the new flow.
  const { rows } = await sql`SHOW TABLES LIKE 'auth_users'`.execute(db);
  if (rows.length)
    await sql`DELETE FROM oauth_authorization_codes WHERE user_id IS NULL`.execute(
      db,
    );
  await sql`DROP TABLE IF EXISTS auth_attempts, auth_users`.execute(db);
}

export async function down() {
  throw new Error(
    "Restaura un respaldo anterior para recuperar la autenticación previa.",
  );
}
