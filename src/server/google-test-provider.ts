import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import type { Response } from "supertest";

export const googleClientId = "finance-google-test";
export const googleClientSecret = "local-test-secret";
export const firstUserEmail = "owner@example.test";

export function responseCookie(response: Response) {
  const cookie = response.get("Set-Cookie")?.at(-1)?.split(";")[0];
  if (!cookie) throw new Error("Falta la cookie de autenticación.");
  return cookie;
}

export async function fakeGoogle() {
  const codes = new Map<string, { challenge: string; claims: object }>();
  const app = express();
  app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
    const pending = codes.get(req.body.code);
    codes.delete(req.body.code);
    const verifier = req.body.code_verifier;
    if (
      !pending ||
      typeof verifier !== "string" ||
      createHash("sha256").update(verifier).digest("base64url") !==
        pending.challenge ||
      req.body.client_id !== googleClientId ||
      req.body.client_secret !== googleClientSecret ||
      req.body.grant_type !== "authorization_code" ||
      !req.body.redirect_uri?.endsWith("/auth/google/callback")
    ) {
      res.sendStatus(400);
      return;
    }
    const payload = Buffer.from(JSON.stringify(pending.claims)).toString(
      "base64url",
    );
    res.json({ id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.fake` });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Falta el puerto.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    env: {
      GOOGLE_CLIENT_ID: googleClientId,
      GOOGLE_CLIENT_SECRET: googleClientSecret,
      FIRST_USER_EMAIL: firstUserEmail,
      GOOGLE_AUTHORIZATION_URL: origin + "/authorize",
      GOOGLE_TOKEN_URL: origin + "/token",
      GOOGLE_ISSUER: origin,
      NODE_ENV: "test",
    },
    callback(response: Response, sub: string, extra: object = {}) {
      const url = new URL(response.headers.location);
      if (
        url.href.split("?")[0] !== origin + "/authorize" ||
        url.searchParams.get("scope") !== "openid email profile" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("response_type") !== "code"
      )
        throw new Error("Solicitud Google OIDC inválida.");
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        claims: {
          iss: origin,
          aud: googleClientId,
          exp: Math.floor(Date.now() / 1000) + 120,
          nonce: url.searchParams.get("nonce"),
          email: sub === "owner" ? firstUserEmail : `${sub}@example.test`,
          email_verified: true,
          sub,
          name: sub,
          ...extra,
        },
      });
      return {
        code,
        state: url.searchParams.get("state")!,
        cookie: responseCookie(response),
      };
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
