import type { Request, Response } from "express";
import { sql } from "kysely";
import { digest, newToken, readCookie, type AuthDb } from "./auth-store.js";

const seconds = 12 * 60 * 60;

export function webSession(secure: boolean) {
  const name = secure ? "__Host-fm-session" : "fm-session";
  const options = {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure,
  } as const;

  return {
    async create(db: AuthDb, userId: string, verifiedEmail: string) {
      const token = newToken();
      await sql`INSERT INTO web_sessions (token_hash, user_id, verified_email, created_at, expires_at)
        VALUES (${digest(token)}, ${userId}, ${verifiedEmail.toLowerCase()}, UTC_TIMESTAMP(3),
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND))`.execute(db);
      return token;
    },

    attach(response: Response, token: string) {
      response.cookie(name, token, { ...options, maxAge: seconds * 1000 });
    },

    async find(db: AuthDb, request: Request) {
      const token = readCookie(request, name);
      if (!token) return;
      const hash = digest(token);
      const {
        rows: [row],
      } = await sql<{ user_id: string; verified_email: string | null }>`
        SELECT s.user_id, s.verified_email FROM web_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3)
      `.execute(db);
      if (row)
        return { hash, userId: row.user_id, verifiedEmail: row.verified_email };
    },

    async logout(
      db: AuthDb,
      { hash, userId }: { hash: Buffer; userId: string },
      response: Response,
    ) {
      await sql`UPDATE web_sessions SET revoked_at = UTC_TIMESTAMP(3)
        WHERE token_hash = ${hash} AND user_id = ${userId} AND revoked_at IS NULL`.execute(
        db,
      );
      response.clearCookie(name, options).status(204).end();
    },

    clear(response: Response) {
      response.clearCookie(name, options).status(204).end();
    },
  };
}
