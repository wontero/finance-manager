import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { sql, type Kysely } from "kysely";

export type AuthDb = Kysely<unknown>;

export const authContext = new AsyncLocalStorage<{
  ip: string | null;
  agent: string | null;
}>();

export const newToken = () => randomBytes(32).toString("base64url");
export const digest = (secret: string) =>
  createHash("sha256").update(secret).digest();

export function readCookie(request: Request, name: string) {
  const cookies = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  const token = cookies?.length === 1 ? cookies[0].slice(name.length + 1) : "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function clientIp(address: string | undefined) {
  const ip = address?.replace(/^::ffff:(?=\d+\.)/i, "");
  if (!ip) return null;
  const version = isIP(ip);
  if (version === 4) return ip;
  return version === 6 && !ip.includes("%")
    ? new URL(`http://[${ip}]`).hostname.slice(1, -1)
    : null;
}

// Registration and OAuth mutations share a lock across Passenger processes.
export const authLock = sql`CONCAT('fm:auth:', LEFT(SHA2(DATABASE(), 256), 48))`;

export function authTransaction<T>(
  db: AuthDb,
  action: (db: AuthDb) => Promise<T>,
) {
  return db.connection().execute(async (connection) => {
    const {
      rows: [row],
    } = await sql<{ acquired: number | string | null }>`
      SELECT GET_LOCK(${authLock}, 5) AS acquired
    `.execute(connection);
    if (Number(row.acquired) !== 1)
      throw new Error("No se pudo obtener el bloqueo de autenticación.");
    try {
      return await connection.transaction().execute(action);
    } finally {
      await sql`SELECT RELEASE_LOCK(${authLock})`.execute(connection);
    }
  });
}

export function authEvent(
  db: AuthDb,
  type: "login" | "issue" | "refresh" | "revoke",
  outcome: "success" | "invalid" | "blocked" | "replay" | "error",
  clientId: string | null = null,
) {
  const context = authContext.getStore();
  return sql`INSERT INTO auth_events (event_type, outcome, ip, user_agent, client_id)
    VALUES (${type}, ${outcome}, ${context?.ip ?? null}, ${context?.agent ?? null}, ${clientId})
  `.execute(db);
}

export async function purgeAuth(db: AuthDb) {
  await sql`DELETE FROM web_sessions WHERE expires_at <= UTC_TIMESTAMP(3)`.execute(
    db,
  );
  const live = sql`t.revoked_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)
    AND t.family_expires_at > UTC_TIMESTAMP(3)`;
  await sql`DELETE FROM oauth_authorization_codes
    WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)
      AND (phase <> 'used' OR NOT EXISTS (
        SELECT 1 FROM oauth_tokens t WHERE t.family_id = oauth_authorization_codes.id AND ${live}
      ))`.execute(db);
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

export function revokeFamily(db: AuthDb, family: Buffer, userId: string) {
  return sql`UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP(3)
    WHERE user_id = CAST(${userId} AS UNSIGNED) AND family_id = ${family} AND revoked_at IS NULL`.execute(
    db,
  );
}

export async function revokeAll(db: AuthDb, userId: string) {
  await sql`UPDATE web_sessions SET revoked_at = UTC_TIMESTAMP(3)
    WHERE user_id = CAST(${userId} AS UNSIGNED) AND revoked_at IS NULL`.execute(
    db,
  );
  await sql`UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP(3)
    WHERE user_id = CAST(${userId} AS UNSIGNED) AND revoked_at IS NULL`.execute(
    db,
  );
  await sql`DELETE FROM oauth_authorization_codes
    WHERE user_id = CAST(${userId} AS UNSIGNED) AND phase <> 'used'`.execute(
    db,
  );
  await authEvent(db, "revoke", "success");
}
