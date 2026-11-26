import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import { sql as query } from "kysely";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import request, { type Response } from "supertest";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import { authLock, type AuthDb } from "./auth-store.js";
import { fakeGoogle, responseCookie } from "./google-test-provider.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { localDatabase, setting } from "./scripts/local-database.js";

const publicUrl = "https://finanzas.example";
const resource = `${publicUrl}/mcp`;
const version = "m005-test";
const redirect = "https://claude.ai/api/mcp/auth_callback";
const tables = [
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_tokens",
  "google_login_requests",
  "user_request_limits",
  "auth_events",
];
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest();
const forwardedIp = "192.0.2.10";
const passengerHeader = "!~Passenger-Client-Address";

function withAuthLock(db: AuthDb, action: () => Promise<void>) {
  return db.connection().execute(async (connection) => {
    const {
      rows: [row],
    } = await query<{ acquired: unknown }>`
      SELECT GET_LOCK(${authLock}, 0) AS acquired
    `.execute(connection);
    expect(Number(row.acquired)).toBe(1);
    try {
      await action();
    } finally {
      await query`SELECT RELEASE_LOCK(${authLock})`.execute(connection);
    }
  });
}

function fields(response: Response) {
  const csrf = /name="csrf" value="([^"]+)"/.exec(response.text)?.[1];
  const cookie = responseCookie(response);
  if (!csrf || !cookie)
    throw new Error("Faltan los datos del formulario OAuth");
  return { csrf, cookie };
}

export function authSpecs(
  connections: () => { app: PoolConnection; reader: PoolConnection },
) {
  const run = (
    name: string,
    verify: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ) => {
    test(`M-005 ${name}`, async () => {
      const context = await fixture();
      try {
        await verify(context);
      } finally {
        await context.database.db.destroy();
        await context.google.close();
      }
    }, 25_000);
  };

  async function fixture() {
    const { app: sql } = connections();
    for (const table of [...tables].reverse())
      await sql.query(`DELETE FROM ${table}`);
    const database = createDatabase({
      ...localDatabase("DATABASE_URL"),
      database: "finance_test",
    });
    const google = await fakeGoogle();
    const http = (trustProxy = "loopback", localSocket = false) => {
      const app = createApp(
        readConfig({
          PUBLIC_URL: publicUrl,
          APP_VERSION: version,
          ...google.env,
          TRUST_PROXY: trustProxy,
        }),
        undefined,
        database,
      );
      if (!localSocket) return request(app);
      return request(
        express().use((req, _res, next) => {
          Object.defineProperties(req.socket, {
            remoteAddress: { value: undefined },
            remoteFamily: { value: undefined },
            localAddress: { value: undefined },
          });
          next();
        }, app),
      );
    };
    const client = http();
    const register = (redirects = [redirect]) =>
      client.post("/register").send({
        client_name: "Claude",
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    const clientId: string = (await register().expect(201)).body.client_id;
    const verifier = random();
    const begin = (method = "S256", browser = client) =>
      browser.get("/authorize").query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: hash(verifier).toString("base64url"),
        code_challenge_method: method,
        resource,
        state: "state-test",
      });
    const startLogin = (
      form: ReturnType<typeof fields>,
      values: object = {},
      browser = client,
      ip = forwardedIp,
    ) =>
      browser
        .post("/authorize/google")
        .set("Cookie", form.cookie)
        .set("X-Forwarded-For", ip)
        .type("form")
        .send({ csrf: form.csrf, ...values });
    const login = async (form: ReturnType<typeof fields>) => {
      const { cookie, ...query } = google.callback(
        await startLogin(form).expect(303),
        "owner",
      );
      return client
        .get("/auth/google/callback")
        .set("Cookie", cookie)
        .query(query)
        .expect(200);
    };
    const consent = (form: ReturnType<typeof fields>) =>
      client
        .post("/authorize/consent")
        .set("Cookie", form.cookie)
        .type("form")
        .send({ csrf: form.csrf, decision: "allow" });
    const authorize = async () => {
      const form = fields(await begin().expect(200));
      const approved = fields(await login(form));
      const response = await consent(approved).expect(303);
      const location = new URL(response.headers.location);
      expect(location.origin + location.pathname).toBe(redirect);
      expect(location.searchParams.get("state")).toBe("state-test");
      const code = location.searchParams.get("code");
      if (!code) throw new Error("Falta el código de autorización");
      return code;
    };
    const exchange = (
      code: string,
      codeVerifier: string | null = verifier,
      extras: object = {},
    ) =>
      client
        .post("/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirect,
          ...(codeVerifier === null ? {} : { code_verifier: codeVerifier }),
          ...extras,
        });
    const issue = async () =>
      (await exchange(await authorize()).expect(200)).body as {
        access_token: string;
        refresh_token: string;
      };
    const refresh = (token: string, browser = client) =>
      browser.post("/token").type("form").send({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
        resource,
      });
    const mcp = (
      token: string | undefined,
      method: string,
      params: object = {},
    ) => {
      const call = client
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method, params });
      if (token) call.set("Authorization", `Bearer ${token}`);
      return call;
    };
    const ping = (token?: string) =>
      mcp(token, "tools/call", { name: "ping", arguments: {} });
    const event = async (type: string, outcome: string) => {
      const [rows] = await sql.execute<RowDataPacket[]>(
        "SELECT ip, client_id FROM auth_events WHERE event_type = ? AND outcome = ? ORDER BY id DESC LIMIT 1",
        [type, outcome],
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    return {
      sql,
      database,
      google,
      client,
      clientId,
      http,
      register,
      begin,
      login,
      startLogin,
      consent,
      authorize,
      exchange,
      issue,
      refresh,
      mcp,
      ping,
      event,
    };
  }

  run(
    "S1: validates token expiry, revocation and resource binding",
    async ({ issue, ping, sql }) => {
      const { access_token: access } = await issue();
      const invalid = async (token?: string) => {
        await ping(token)
          .expect(401)
          .expect(
            "WWW-Authenticate",
            /resource_metadata="https:\/\/finanzas\.example\/\.well-known\/oauth-protected-resource\/mcp"/,
          );
      };
      await invalid();
      await invalid(random());
      await ping(access).expect(200);
      const predicate = "WHERE token_hash = ?";
      await sql.execute(
        `UPDATE oauth_tokens SET expires_at = UTC_TIMESTAMP(3) ${predicate}`,
        [hash(access)],
      );
      await invalid(access);
      await sql.execute(
        `UPDATE oauth_tokens SET expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR), revoked_at = UTC_TIMESTAMP(3) ${predicate}`,
        [hash(access)],
      );
      await invalid(access);
      await sql.execute(
        `UPDATE oauth_tokens SET revoked_at = NULL, resource = 'https://otro.example/mcp' ${predicate}`,
        [hash(access)],
      );
      await invalid(access);
    },
  );

  run(
    "S3: DCR admits only exact configured HTTPS callbacks",
    async ({ register }) => {
      await register().expect(201);
      for (const uris of [
        ["https://otro.example/callback"],
        [redirect.replace("https:", "http:")],
        ["https://*.claude.ai/api/mcp/auth_callback"],
        [redirect, "https://otro.example/callback"],
        [`${redirect}/`],
      ])
        await register(uris).expect(400);
    },
  );

  run(
    "S4/S13: login and consent issue a one-use code protected by S256",
    async ({ authorize, begin, exchange, mcp, ping, event }) => {
      const plain = await begin("plain").expect(302);
      expect(
        new URL(plain.headers.location).searchParams.get("error"),
      ).toBeTruthy();
      const code = await authorize();
      await exchange(code, null).expect(400);
      await exchange(code, random()).expect(400);
      const result = await exchange(code, undefined, {
        resource: "https://otro.example/mcp",
      }).expect(400);
      expect(result.body.error).toBe("invalid_target");
      const { body } = await exchange(code).expect(200);
      expect(body).toMatchObject({
        token_type: "Bearer",
        scope: "finance",
        expires_in: 3600,
      });
      const initialized = await mcp(body.access_token, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "integration-client", version: "1" },
      })
        .expect(200)
        .expect("Content-Type", /^application\/json/);
      expect(initialized.headers["mcp-session-id"]).toBeUndefined();
      expect(initialized.body.result.serverInfo).toEqual({
        name: "Finance Manager",
        version,
      });
      const tools = await mcp(body.access_token, "tools/list").expect(200);
      expect(
        tools.body.result.tools.find(
          (tool: { name: string }) => tool.name === "ping",
        ),
      ).toMatchObject({ annotations: { readOnlyHint: true } });
      const pong = await ping(body.access_token).expect(200);
      const [content] = pong.body.result.content;
      expect(content.type).toBe("text");
      const resultPing = JSON.parse(content.text);
      expect(resultPing).toMatchObject({ message: "pong", version });
      expect(new Date(resultPing.time).toISOString()).toBe(resultPing.time);
      await exchange(code).expect(400);
      await ping(body.access_token).expect(401);
      await event("issue", "success");
      await event("issue", "replay");
    },
  );

  run(
    "S5: refresh rotates and replay revokes its family",
    async ({ issue, refresh, ping, event }) => {
      const initial = await issue();
      const { body: fresh } = await refresh(initial.refresh_token).expect(200);
      expect(fresh.refresh_token === initial.refresh_token).toBe(false);
      await ping(fresh.access_token).expect(200);
      await refresh(initial.refresh_token).expect(400);
      await refresh(fresh.refresh_token).expect(400);
      await ping(fresh.access_token).expect(401);
      await ping(initial.access_token).expect(401);
      await event("refresh", "success");
      await event("refresh", "replay");
    },
  );

  run(
    "S5: refresh expiry and maximum family age are enforced",
    async ({ issue, refresh, sql }) => {
      const initial = await issue();
      await sql.execute(
        "UPDATE oauth_tokens SET expires_at = UTC_TIMESTAMP(3) WHERE token_hash = ?",
        [hash(initial.refresh_token)],
      );
      await refresh(initial.refresh_token).expect(400);
      await sql.execute(
        "UPDATE oauth_tokens SET expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY), family_expires_at = UTC_TIMESTAMP(3) WHERE token_hash = ?",
        [hash(initial.refresh_token)],
      );
      await refresh(initial.refresh_token).expect(400);
    },
  );

  run(
    "S5: concurrent refreshes cannot create two live descendants",
    async ({ issue, refresh, ping }) => {
      const initial = await issue();
      const replies = await Promise.all([
        refresh(initial.refresh_token),
        refresh(initial.refresh_token),
      ]);
      expect(replies.map(({ status }) => status).sort()).toEqual([200, 400]);
      const fresh = replies.find(({ status }) => status === 200)?.body;
      await ping(fresh.access_token).expect(401);
      await refresh(fresh.refresh_token).expect(400);
    },
  );

  run(
    "S12: la IP reenviada más cercana conserva el límite de login",
    async ({ begin, startLogin }) => {
      const form = fields(await begin().expect(200));
      for (let i = 1; i <= 20; i++) {
        await startLogin(
          form,
          { csrf: "" },
          undefined,
          `198.51.100.${i}, ${forwardedIp}`,
        ).expect(403);
      }
      await startLogin(
        form,
        {},
        undefined,
        `198.51.100.21, ${forwardedIp}`,
      ).expect(429);
      await startLogin(form, {}, undefined, "192.0.2.11").expect(303);
    },
  );

  run(
    "S20: token and revocation requests without IP leave valid requests available",
    async ({ http, issue, refresh, ping, clientId }) => {
      const { refresh_token: token } = await issue();
      const missing = http("off", true);
      for (let i = 0; i < 60; i++)
        await missing.post("/token").type("form").expect(400);
      const renewed = await refresh(token, missing).expect(200);
      for (let i = 0; i < 60; i++)
        await missing.post("/revoke").type("form").expect(400);
      await missing
        .post("/revoke")
        .type("form")
        .send({ client_id: clientId, token: renewed.body.refresh_token })
        .expect(200);
      await ping(renewed.body.access_token).expect(401);
    },
  );

  run(
    "M-007 S11: malformed revocation returns without the auth lock or an event",
    async ({ http, sql, clientId, database }) => {
      const events = async () =>
        (
          await sql.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS total FROM auth_events",
          )
        )[0][0].total;
      const before = await events();
      await withAuthLock(database.db, async () => {
        await http("off", true)
          .post("/revoke")
          .type("form")
          .send({ client_id: clientId, token: "malformed" })
          .timeout(2000)
          .expect(200);
        expect(await events()).toBe(before);
      });
      expect(await events()).toBe(before);
    },
  );

  run(
    "S20: Passenger IPs have separate token quotas",
    async ({ http, issue, refresh }) => {
      const { refresh_token: token } = await issue();
      const client = http("passenger");
      const firstIp = "203.0.113.20";
      for (let i = 0; i < 50; i++)
        await client
          .post("/token")
          .type("form")
          .set(passengerHeader, firstIp)
          .expect(400);
      await client
        .post("/token")
        .type("form")
        .set(passengerHeader, firstIp)
        .expect(429);
      await refresh(token, client)
        .set(passengerHeader, "203.0.113.21")
        .expect(200);
    },
  );

  run(
    "S22: both forms apply the no-IP limit before waiting for the auth lock",
    async ({ begin, http, login, startLogin, database }) => {
      const approval = fields(await login(fields(await begin().expect(200))));
      const form = fields(await begin().expect(200));
      const missing = http("off", true);
      await withAuthLock(database.db, async () => {
        for (const path of ["/authorize/google", "/authorize/consent"]) {
          for (let i = 0; i < 60; i++)
            await missing.post(path).type("form").expect(403);
        }
        await startLogin(form, {}, missing)
          .timeout(2000)
          .expect(429)
          .expect("Retry-After", /\d+/);
        await missing
          .post("/authorize/consent")
          .set("Cookie", approval.cookie)
          .type("form")
          .send({ csrf: approval.csrf, decision: "allow" })
          .timeout(2000)
          .expect(429)
          .expect("Retry-After", /\d+/);
      });
    },
  );

  run(
    "S17: consent shows the warning and the registration time in La Paz, with escaped client metadata",
    async ({ begin, login, sql, clientId }) => {
      await sql.execute(
        `UPDATE oauth_clients SET created_at = '2026-11-03 02:15:00.000',
        metadata = JSON_SET(metadata, '$.client_name', '<em>Claude</em>') WHERE id = ?`,
        [clientId],
      );
      const form = fields(await begin().expect(200));
      const { text } = await login(form);
      expect(
        text.includes(
          "Autoriza solo si acabas de iniciar la conexión desde tu Claude",
        ),
      ).toBe(true);
      expect(/02\/11\/2026.{0,12}22:15/s.test(text)).toBe(true);
      expect(text.includes("&lt;em&gt;Claude&lt;/em&gt;")).toBe(true);
    },
  );

  run(
    "S18: issuing and refreshing purge stale auth data while preserving live families and replay checks",
    async ({
      begin,
      register,
      exchange,
      authorize,
      refresh,
      ping,
      sql,
      clientId,
    }) => {
      const old = (await register().expect(201)).body.client_id;
      await sql.execute(
        "UPDATE oauth_clients SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 31 DAY) WHERE id IN (?, ?)",
        [old, clientId],
      );
      const stale = fields(await begin().expect(200));
      await sql.execute(
        `UPDATE oauth_authorization_codes SET client_id = ?, expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 25 HOUR) WHERE id = ?`,
        [old, hash(stale.cookie.split("=")[1])],
      );
      const recent = fields(await begin().expect(200));
      await sql.execute(
        `UPDATE oauth_authorization_codes SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 23 HOUR) WHERE id = ?`,
        [hash(recent.cookie.split("=")[1])],
      );
      await sql.query(
        `INSERT INTO auth_events (event_type, outcome, ip, created_at)
          VALUES ('revoke', 'invalid', '192.0.2.31', DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 366 DAY)),
                 ('revoke', 'success', '192.0.2.32', DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 364 DAY))`,
      );
      const code = await authorize();
      const first = (await exchange(code).expect(200)).body;
      const [events] = await sql.query(
        "SELECT outcome FROM auth_events WHERE ip IN ('192.0.2.31', '192.0.2.32')",
      );
      expect(events).toEqual([{ outcome: "success" }]);
      const [[counts]] = await sql.execute<RowDataPacket[]>(
        `SELECT
        (SELECT COUNT(*) FROM oauth_authorization_codes WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)) AS codes,
        (SELECT COUNT(*) FROM oauth_clients WHERE id = ?) AS old_client,
        (SELECT COUNT(*) FROM oauth_clients WHERE id = ?) AS live_client,
        (SELECT COUNT(*) FROM auth_events WHERE event_type = 'setup') AS events`,
        [old, clientId],
      );
      expect(Object.values(counts).map(Number)).toEqual([0, 0, 1, 0]);

      await sql.execute(
        `UPDATE oauth_authorization_codes SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 25 HOUR) WHERE code_hash = ?`,
        [hash(code)],
      );
      const inactive = (await register().expect(201)).body.client_id;
      await sql.execute(
        `UPDATE oauth_clients SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 31 DAY) WHERE id = ?`,
        [inactive],
      );
      await sql.execute(
        `INSERT INTO oauth_tokens (token_hash, token_type, family_id, client_id, user_id, resource, expires_at, family_expires_at, revoked_at)
        SELECT ?, token_type, ?, ?, user_id, resource, expires_at, family_expires_at, UTC_TIMESTAMP(3)
        FROM oauth_tokens WHERE token_hash = ?`,
        [randomBytes(32), randomBytes(32), inactive, hash(first.refresh_token)],
      );
      const rotated = (await refresh(first.refresh_token).expect(200)).body;
      const [[purged]] = await sql.execute<RowDataPacket[]>(
        `SELECT
        (SELECT COUNT(*) FROM oauth_clients WHERE id = ?) AS clients,
        (SELECT COUNT(*) FROM oauth_tokens WHERE client_id = ?) AS tokens`,
        [inactive, inactive],
      );
      expect(Object.values(purged).map(Number)).toEqual([0, 0]);
      await ping(rotated.access_token).expect(200);
      await exchange(code, null).expect(400);
      await ping(rotated.access_token).expect(200);
      await exchange(code).expect(400);
      await ping(rotated.access_token).expect(401);
    },
  );

  run(
    "S7: CSRF uses two request-specific values and secure headers",
    async ({ begin, login, startLogin, client }) => {
      const page = await begin()
        .expect(200)
        .expect("Content-Security-Policy", /default-src 'none'/)
        .expect("X-Frame-Options", "DENY")
        .expect("Referrer-Policy", "no-referrer");
      expect(page.get("Set-Cookie")?.[0]).toMatch(
        /(?=.*HttpOnly)(?=.*SameSite=Strict)(?=.*Secure)/,
      );
      const first = fields(await begin().expect(200));
      const second = fields(await begin().expect(200));
      await startLogin(first, { csrf: "" }).expect(403);
      await startLogin(first, { csrf: second.csrf }).expect(403);
      await client
        .post("/authorize/google")
        .type("form")
        .send({ csrf: first.csrf })
        .expect(403);
      const authenticated = fields(await login(first));
      await client
        .post("/authorize/consent")
        .type("form")
        .set("Cookie", authenticated.cookie)
        .send({ csrf: first.csrf, decision: "allow" })
        .expect(403);
    },
  );

  run(
    "S8/S19: auth storage has no plaintext credentials, CSRF or cookie during Google login",
    async ({ exchange, begin, login, consent, sql }) => {
      const assertNoPlaintext = async (...needles: Buffer[]) => {
        for (const table of tables) {
          const [rows] = await sql.query<RowDataPacket[]>(
            `SELECT * FROM ${table}`,
          );
          for (const row of rows)
            for (const value of Object.values(row)) {
              const bytes = Buffer.isBuffer(value)
                ? value
                : Buffer.from(String(value));
              expect(
                needles.some((needle) => bytes.includes(needle)),
                table,
              ).toBe(false);
            }
        }
      };
      const form = fields(await begin().expect(200));
      const cookieValue = Buffer.from(form.cookie.split("=")[1]);
      await assertNoPlaintext(Buffer.from(form.csrf), cookieValue);
      const approval = fields(await login(form));
      await assertNoPlaintext(Buffer.from(approval.csrf), cookieValue);
      const redirect = await consent(approval).expect(303);
      const code = new URL(redirect.headers.location).searchParams.get("code");
      if (!code) throw new Error("Falta el código de autorización");
      const { body } = await exchange(code).expect(200);
      await assertNoPlaintext(
        ...[
          code,
          body.access_token,
          body.refresh_token,
          form.csrf,
          approval.csrf,
        ].map((value) => Buffer.from(value)),
        cookieValue,
      );
    },
  );

  run(
    "S9: CLI can list, revoke one family, and invalidate all tokens for one user",
    async ({ issue, ping, refresh, sql, google, event, clientId }) => {
      const first = await issue();
      const url = new URL(setting("DATABASE_URL"));
      url.pathname = "/finance_test";
      const env = {
        ...process.env,
        DATABASE_URL: url.href,
        DATABASE_SOCKET: undefined,
        ...google.env,
      };
      const tokens = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          [setting("npm_execpath"), "run", "auth:tokens", "--", ...args],
          { env },
        );
      const [[token]] = await sql.execute<RowDataPacket[]>(
        "SELECT id FROM oauth_tokens WHERE token_hash = ?",
        [hash(first.access_token)],
      );
      const listed = (await tokens("list", "1")).stdout;
      expect(listed.includes(clientId)).toBe(true);
      expect(
        listed.includes(first.access_token) ||
          listed.includes(first.refresh_token),
      ).toBe(false);
      await tokens("revoke", "1", token.id);
      await ping(first.access_token).expect(401);
      await refresh(first.refresh_token).expect(400);
      const second = await issue();
      await tokens("revoke-all", "1");
      await ping(second.access_token).expect(401);
      await refresh(second.refresh_token).expect(400);
      await event("revoke", "success");
    },
  );

  run(
    "S9: OAuth revocation invalidates its own token family",
    async ({ issue, client, clientId, ping, refresh, register }) => {
      const tokens = await issue();
      const other = (await register().expect(201)).body.client_id;
      await client
        .post("/revoke")
        .type("form")
        .send({ client_id: other, token: tokens.refresh_token })
        .expect(200);
      await ping(tokens.access_token).expect(200);
      await client
        .post("/revoke")
        .type("form")
        .send({ client_id: clientId, token: tokens.refresh_token })
        .expect(200);
      await ping(tokens.access_token).expect(401);
      await refresh(tokens.refresh_token).expect(400);
    },
  );

  test("M-005 S10: the reporting user cannot access authentication tables", async () => {
    const { app, reader } = connections();
    for (const name of tables) {
      await app.query(`SELECT 1 FROM ${name} LIMIT 1`);
      await expect(
        reader.query(`SELECT 1 FROM finance_test.${name}`),
      ).rejects.toMatchObject({ code: "ER_TABLEACCESS_DENIED_ERROR" });
    }
    const [views] = await reader.query<RowDataPacket[]>("SHOW FULL TABLES");
    expect(
      views.some((view) =>
        Object.values(view).some((value) =>
          /auth|oauth|token/.test(String(value)),
        ),
      ),
    ).toBe(false);
  });
}
