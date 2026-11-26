import type { Request, Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import type { AuthConfig } from "./auth-provider.js";
import { digest, newToken, readCookie, type AuthDb } from "./auth-store.js";
import { provisionUser } from "./ledger/provision.js";

const claims = z.object({
  sub: z.string().regex(/^[\x21-\x7e]{1,255}$/),
  email: z.email().max(320),
  email_verified: z.literal(true),
  name: z.string().max(255).optional().catch(undefined),
  iss: z.string(),
  aud: z.union([z.string(), z.tuple([z.string()])]),
  azp: z.string().optional(),
  exp: z.number().finite(),
  nonce: z.string(),
});
type Identity = z.infer<typeof claims>;
type Challenge = {
  nonce: string;
  verifier: string;
  for_oauth: number;
  reauth_session_hash: Buffer | null;
};

export function googleLogin(config: AuthConfig, db: AuthDb) {
  const google = config.google!;
  const cookie = config.secureCookies ? "__Host-fm-google" : "fm-google";
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: "/",
  } as const;

  return {
    async start(
      response: Response,
      {
        oauthBrowser,
        sessionHash,
      }: { oauthBrowser?: string; sessionHash?: Buffer } = {},
    ) {
      const browser = oauthBrowser ?? newToken();
      const state = newToken();
      const verifier = newToken();
      const nonce = newToken();
      await sql`DELETE FROM google_login_requests WHERE expires_at <= UTC_TIMESTAMP(3)`.execute(
        db,
      );
      await sql`INSERT INTO google_login_requests (state_hash, browser_hash, verifier, nonce, for_oauth, reauth_session_hash, expires_at)
        VALUES (${digest(state)}, ${digest(browser)}, ${verifier}, ${nonce}, ${Boolean(oauthBrowser)}, ${sessionHash ?? null},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))`.execute(db);
      const authorization = new URL(google.authorizationUrl);
      authorization.search = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: google.callback.href,
        response_type: "code",
        scope: "openid email profile",
        code_challenge: digest(verifier).toString("base64url"),
        code_challenge_method: "S256",
        state,
        nonce,
      }).toString();
      if (sessionHash)
        authorization.searchParams.set("prompt", "select_account");
      response
        .cookie(cookie, browser, { ...cookieOptions, maxAge: 600_000 })
        .redirect(303, authorization.href);
    },

    async finish(request: Request, response: Response) {
      const browser = readCookie(request, cookie);
      const { code, state } = request.query;
      if (
        !browser ||
        typeof state !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(state)
      )
        return;
      const challenge = await db.transaction().execute(async (trx) => {
        const key = digest(state);
        const {
          rows: [challenge],
        } = await sql<Challenge>`
          SELECT verifier, nonce, for_oauth, reauth_session_hash FROM google_login_requests
          WHERE state_hash = ${key} AND browser_hash = ${digest(browser)}
            AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE
        `.execute(trx);
        if (!challenge) return;
        await sql`DELETE FROM google_login_requests WHERE state_hash = ${key}`.execute(
          trx,
        );
        return challenge;
      });
      if (!challenge) return;
      response.clearCookie(cookie, cookieOptions);
      if (
        typeof code !== "string" ||
        !code.length ||
        code.length > 2048 ||
        request.query.error !== undefined
      )
        return;

      // OIDC Core §3.1.3.7 permits TLS authentication for this direct token response.
      try {
        const tokens = await fetch(google.tokenUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            client_id: google.clientId,
            client_secret: google.clientSecret,
            code,
            code_verifier: challenge.verifier,
            redirect_uri: google.callback.href,
            grant_type: "authorization_code",
          }),
        });
        if (!tokens.ok) return;
        const { id_token: jwt } = await tokens.json();
        if (
          typeof jwt !== "string" ||
          jwt.length > 32_768 ||
          !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)
        )
          return;
        const { data: identity } = claims.safeParse(
          JSON.parse(
            Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
          ),
        );
        if (
          !identity ||
          !google.issuers.includes(identity.iss) ||
          (Array.isArray(identity.aud) ? identity.aud[0] : identity.aud) !==
            google.clientId ||
          (identity.azp !== undefined && identity.azp !== google.clientId) ||
          identity.exp <= Date.now() / 1000 ||
          identity.nonce !== challenge.nonce
        )
          return;
        return {
          identity,
          oauthBrowser: challenge.for_oauth ? browser : undefined,
          sessionHash: challenge.reauth_session_hash,
        };
      } catch {
        return;
      }
    },
  };
}

export async function resolveGoogleUser(
  trx: AuthDb,
  config: NonNullable<AuthConfig["google"]>,
  identity: Identity,
) {
  const email = identity.email.toLowerCase();
  const {
    rows: [existing],
  } = await sql<{ id: string }>`
      SELECT id FROM users WHERE google_sub = ${identity.sub}
    `.execute(trx);
  if (existing) {
    await sql`UPDATE users SET email = ${email}, display_name = ${identity.name ?? null},
      last_seen_at = UTC_TIMESTAMP(3) WHERE id = ${existing.id}`.execute(trx);
    return existing.id;
  }
  if (email === config.firstUserEmail) {
    const result = await sql`UPDATE users SET google_sub = ${identity.sub},
        email = ${email}, display_name = ${identity.name ?? null}, last_seen_at = UTC_TIMESTAMP(3)
        WHERE id = 1 AND google_sub IS NULL`.execute(trx);
    if (result.numAffectedRows === 1n) return "1";
  }
  const {
    rows: [total],
  } = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM users`.execute(
    trx,
  );
  if (Number(total.count) >= config.maxUsers) return null;
  const { insertId } =
    await sql`INSERT INTO users (google_sub, email, display_name, last_seen_at)
      VALUES (${identity.sub}, ${email}, ${identity.name ?? null}, UTC_TIMESTAMP(3))`.execute(
      trx,
    );
  const userId = insertId!.toString();
  await provisionUser(trx, userId);
  return userId;
}

export async function warnUnlinkedOwner(db: AuthDb) {
  const { rows } = await sql`
    SELECT id FROM users WHERE id = 1 AND google_sub IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE id <> 1)
  `.execute(db);
  if (rows.length)
    console.warn(
      "El usuario #1 todavía no está vinculado y ya hay otros usuarios. Revisa que FIRST_USER_EMAIL sea el correo principal de su cuenta Google.",
    );
}
