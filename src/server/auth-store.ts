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
  return ip && isIP(ip) ? ip.toLowerCase() : null;
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
  type: "login" | "issue" | "refresh" | "revoke" | "setup",
  outcome: "success" | "invalid" | "blocked" | "replay" | "error",
  clientId: string | null = null,
) {
  const context = authContext.getStore();
  return sql`INSERT INTO auth_events (event_type, outcome, ip, user_agent, client_id)
    VALUES (${type}, ${outcome}, ${context?.ip ?? null}, ${context?.agent ?? null}, ${clientId})
  `.execute(db);
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
