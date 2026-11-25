import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { sql, type Kysely } from "kysely";

export type AuthDb = Kysely<unknown>;

export type AuthUser = {
  password_hash: Buffer | null;
  password_salt: Buffer | null;
  scrypt_n: number | null;
  scrypt_r: number | null;
  scrypt_p: number | null;
  totp_encrypted: Buffer | null;
  last_totp_step: string | null;
};

export const authContext = new AsyncLocalStorage<{
  ip: string | null;
  agent: string | null;
}>();

export const newToken = () => randomBytes(32).toString("base64url");
export const digest = (secret: string) =>
  createHash("sha256").update(secret).digest();

export function clientIp(address: string | undefined) {
  const ip = address?.replace(/^::ffff:(?=\d+\.)/i, "");
  if (!ip) return null;
  const version = isIP(ip);
  if (version === 4) return ip;
  return version === 6 && !ip.includes("%")
    ? new URL(`http://[${ip}]`).hostname.slice(1, -1)
    : null;
}

// Serialize changes to credentials, login attempts, codes and token families.
export function authTransaction<T>(
  db: AuthDb,
  action: (db: AuthDb, user: AuthUser) => Promise<T>,
) {
  return db.transaction().execute(async (trx) => {
    const {
      rows: [user],
    } = await sql<AuthUser>`
      SELECT * FROM auth_users WHERE id = 1 FOR UPDATE
    `.execute(trx);
    if (!user)
      throw new Error("La migración de autenticación no está aplicada");
    return action(trx, user);
  });
}

export function authEvent(
  db: AuthDb,
  type: "login" | "issue" | "refresh" | "revoke" | "setup" | "unlock",
  outcome: "success" | "invalid" | "blocked" | "replay" | "error",
  clientId: string | null = null,
) {
  const context = authContext.getStore();
  return sql`INSERT INTO auth_events (event_type, outcome, ip, user_agent, client_id)
    VALUES (${type}, ${outcome}, ${context?.ip ?? null}, ${context?.agent ?? null}, ${clientId})
  `.execute(db);
}

export async function loginBlocked(db: AuthDb, ip: string | null) {
  const {
    rows: [counts],
  } = await sql<{ global_count: string; ip_count: string | null }>`
    SELECT COUNT(*) AS global_count,
      SUM(ip = ${ip} AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)) AS ip_count
    FROM auth_attempts WHERE created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)
  `.execute(db);
  return Number(counts.ip_count) >= 5 || Number(counts.global_count) >= 20;
}

export function recordBlockedLogin(db: AuthDb, clientId: string) {
  const context = authContext.getStore();
  const ip = context?.ip ?? null;
  // Different Passenger processes share this audit guard without locking auth_users.
  const lock = sql`CONCAT('fm:login:', LEFT(SHA2(CONCAT(DATABASE(), '/', ${ip ?? ""}), 256), 48))`;
  return db.connection().execute(async (connection) => {
    const {
      rows: [row],
    } = await sql<{
      acquired: number | string | null;
    }>`SELECT GET_LOCK(${lock}, 0) AS acquired`.execute(connection);
    if (Number(row.acquired) !== 1) return;
    try {
      await sql`INSERT INTO auth_events (event_type, outcome, ip, user_agent, client_id)
        SELECT 'login', 'blocked', ${ip}, ${context?.agent ?? null}, ${clientId}
        FROM DUAL WHERE NOT EXISTS (
          SELECT 1 FROM auth_events WHERE event_type = 'login' AND outcome = 'blocked' AND ip <=> ${ip}
            AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)
        )`.execute(connection);
    } finally {
      await sql`SELECT RELEASE_LOCK(${lock})`.execute(connection);
    }
  });
}

export async function purgeAuth(db: AuthDb) {
  const live = sql`t.revoked_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)
    AND t.family_expires_at > UTC_TIMESTAMP(3)`;
  await sql`DELETE FROM oauth_authorization_codes
    WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)
      AND (phase <> 'used' OR NOT EXISTS (
        SELECT 1 FROM oauth_tokens t WHERE t.family_id = oauth_authorization_codes.id AND ${live}
      ))`.execute(db);
  await sql`DELETE FROM auth_attempts WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`.execute(
    db,
  );
  await sql`DELETE FROM auth_events WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 365 DAY)`.execute(
    db,
  );

  const idle = sql`c.created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)
    AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.id AND ${live})`;
  const { rows: clients } = await sql<{
    id: string;
  }>`SELECT c.id FROM oauth_clients c WHERE ${idle} FOR UPDATE`.execute(db);
  if (!clients.length) return;
  const ids = sql.join(clients.map(({ id }) => id));
  // Both child tables restrict deletion of their OAuth client.
  await sql`DELETE FROM oauth_authorization_codes WHERE client_id IN (${ids})`.execute(
    db,
  );
  await sql`DELETE FROM oauth_tokens WHERE client_id IN (${ids})`.execute(db);
  await sql`DELETE FROM oauth_clients WHERE id IN (${ids})`.execute(db);
}

export function revokeFamily(db: AuthDb, family: Buffer) {
  return sql`UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP(3)
    WHERE family_id = ${family} AND revoked_at IS NULL`.execute(db);
}

export async function revokeAll(db: AuthDb) {
  await sql`UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP(3)
    WHERE revoked_at IS NULL`.execute(db);
  await sql`DELETE FROM oauth_authorization_codes WHERE phase <> 'used'`.execute(
    db,
  );
  await authEvent(db, "revoke", "success");
}
