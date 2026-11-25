import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  const options = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
  const clientId = sql`CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`;
  const ip = sql`VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin`;
  const createdAt = sql`DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;
  const statements = [
    sql`CREATE TABLE IF NOT EXISTS auth_users (
      id TINYINT UNSIGNED PRIMARY KEY CHECK (id = 1),
      password_hash BINARY(64),
      password_salt BINARY(16),
      scrypt_n INT UNSIGNED,
      scrypt_r INT UNSIGNED,
      scrypt_p INT UNSIGNED,
      totp_encrypted VARBINARY(64),
      last_totp_step BIGINT UNSIGNED,
      updated_at ${createdAt}
    ) ${options}`,
    sql`INSERT IGNORE INTO auth_users (id) VALUES (1)`,
    sql`CREATE TABLE IF NOT EXISTS oauth_clients (
      id ${clientId} PRIMARY KEY,
      metadata JSON NOT NULL,
      created_at ${createdAt}
    ) ${options}`,
    sql`CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      id BINARY(32) PRIMARY KEY,
      csrf_hash BINARY(32),
      code_hash BINARY(32) UNIQUE,
      phase ENUM('login', 'consent', 'code', 'used') NOT NULL,
      client_id ${clientId} NOT NULL,
      redirect_uri VARCHAR(2048) NOT NULL,
      resource VARCHAR(2048) NOT NULL,
      oauth_state VARCHAR(2048),
      code_challenge BINARY(32) NOT NULL,
      created_at ${createdAt},
      expires_at DATETIME(3) NOT NULL,
      INDEX oauth_code_expiry (expires_at),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
    ) ${options}`,
    sql`CREATE TABLE IF NOT EXISTS oauth_tokens (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      token_hash BINARY(32) NOT NULL UNIQUE,
      token_type ENUM('access', 'refresh') NOT NULL,
      family_id BINARY(32) NOT NULL,
      client_id ${clientId} NOT NULL,
      resource VARCHAR(2048) NOT NULL,
      created_at ${createdAt},
      expires_at DATETIME(3) NOT NULL,
      family_expires_at DATETIME(3) NOT NULL,
      rotated_at DATETIME(3),
      revoked_at DATETIME(3),
      INDEX oauth_token_family (family_id),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
    ) ${options}`,
    sql`CREATE TABLE IF NOT EXISTS auth_attempts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ip ${ip} NOT NULL,
      created_at ${createdAt},
      INDEX auth_attempt_time (created_at)
    ) ${options}`,
    sql`CREATE TABLE IF NOT EXISTS auth_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_type ENUM('login', 'issue', 'refresh', 'revoke', 'setup') NOT NULL,
      outcome ENUM('success', 'invalid', 'blocked', 'replay', 'error') NOT NULL,
      ip ${ip},
      user_agent VARCHAR(200),
      client_id ${clientId},
      created_at ${createdAt}
    ) ${options}`,
  ];
  for (const statement of statements) await statement.execute(db);
}

export async function down(db: Kysely<unknown>) {
  for (const name of [
    "auth_events",
    "auth_attempts",
    "oauth_tokens",
    "oauth_authorization_codes",
    "oauth_clients",
    "auth_users",
  ]) {
    await db.schema.dropTable(name).ifExists().execute();
  }
}
