import type { Request, Response } from "express";
import { sql } from "kysely";
import { checkPassword } from "./auth-credentials.js";
import {
  authContext,
  authEvent,
  authTransaction,
  digest,
  loginBlocked,
  newToken,
  recordBlockedLogin,
  type AuthDb,
} from "./auth-store.js";

const seconds = 12 * 60 * 60;
const json = { authenticated: true };

export function webSession(secure: boolean) {
  const name = secure ? "__Host-fm-session" : "fm-session";
  const options = {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure,
  } as const;

  async function authenticate(db: AuthDb, password: unknown) {
    const ip = authContext.getStore()?.ip ?? null;
    if (await loginBlocked(db, ip)) return null;
    return authTransaction(db, async (trx, user) => {
      if (await loginBlocked(trx, ip)) return null;
      const validInput =
        typeof password === "string" && Buffer.byteLength(password) <= 1024;
      const matches = await checkPassword(user, validInput ? password : "");
      if (!validInput || !matches) {
        await sql`INSERT INTO auth_attempts (ip) VALUES (${ip ?? ""})`.execute(
          trx,
        );
        await authEvent(trx, "login", "invalid");
        return false;
      }
      const token = newToken();
      await sql`INSERT INTO web_sessions (token_hash, created_at, expires_at)
        VALUES (${digest(token)}, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND))`.execute(
        trx,
      );
      await authEvent(trx, "login", "success");
      return token;
    });
  }

  return {
    async login(db: AuthDb | undefined, request: Request, response: Response) {
      const token = db ? await authenticate(db, request.body?.password) : false;
      if (!token) {
        if (token === null && db) await recordBlockedLogin(db, null);
        response.status(token === null ? 429 : 401).json({
          error:
            "No se pudo iniciar sesión. Verifica la contraseña o vuelve a intentar más tarde.",
        });
        return;
      }
      response
        .cookie(name, token, { ...options, maxAge: seconds * 1000 })
        .json(json);
    },

    async find(db: AuthDb, request: Request) {
      const cookie = request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(name + "="));
      const token = cookie?.slice(name.length + 1);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const hash = digest(token);
      const { rows } =
        await sql`SELECT 1 FROM web_sessions WHERE token_hash = ${hash}
        AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`.execute(db);
      return rows.length ? hash : null;
    },

    async logout(db: AuthDb, hash: Buffer, response: Response) {
      await sql`UPDATE web_sessions SET revoked_at = UTC_TIMESTAMP(3)
        WHERE token_hash = ${hash} AND revoked_at IS NULL`.execute(db);
      response.clearCookie(name, options).status(204).end();
    },
  };
}
