import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { Secret, TOTP } from "otpauth";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import request, { type Response } from "supertest";
import { expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { replaceUser } from "./auth-credentials.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { localDatabase, setting } from "./scripts/local-database.js";

const publicUrl = "https://finanzas.example";
const resource = `${publicUrl}/mcp`;
const version = "m005-test";
const redirect = "https://claude.ai/api/mcp/auth_callback";
const tables = [
  "auth_users",
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_tokens",
  "auth_attempts",
  "auth_events",
];
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest();
const forwardedIp = "192.0.2.10";

function fields(response: Response) {
  const csrf = /name="csrf" value="([^"]+)"/.exec(response.text)?.[1];
  const cookie = response.get("Set-Cookie")?.[0]?.split(";")[0];
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
      }
    }, 25_000);
  };

  async function fixture() {
    const { app: sql } = connections();
    for (const table of [...tables]
      .reverse()
      .filter((name) => name !== "auth_users"))
      await sql.query(`DELETE FROM ${table}`);
    const database = createDatabase({
      ...localDatabase("DATABASE_URL"),
      database: "finance_test",
    });
    const key = randomBytes(32);
    const password = random();
    const secret = new Secret({ size: 20 });
    try {
      await replaceUser(database.db, key, password, secret);
    } catch (error) {
      await database.db.destroy();
      throw error;
    }
    const http = (encryptionKey = key, production = false) =>
      request(
        createApp(
          readConfig({
            PUBLIC_URL: publicUrl,
            APP_VERSION: version,
            TOTP_ENCRYPTION_KEY: encryptionKey.toString("base64"),
            NODE_ENV: production ? "production" : "development",
            TRUST_PROXY: "loopback",
          }),
          undefined,
          database,
        ),
      );
    const client = http();
    const timestamp = Date.now();
    const totp = (offset = 0) =>
      new TOTP({ secret }).generate({ timestamp: timestamp + offset * 30_000 });
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
    const login = (
      form: ReturnType<typeof fields>,
      values: object = {},
      browser = client,
      ip = forwardedIp,
    ) =>
      browser
        .post("/authorize/login")
        .set("Cookie", form.cookie)
        .set("X-Forwarded-For", ip)
        .type("form")
        .send({ csrf: form.csrf, password, totp: totp(), ...values });
    const consent = (form: ReturnType<typeof fields>) =>
      client
        .post("/authorize/consent")
        .set("Cookie", form.cookie)
        .type("form")
        .send({ csrf: form.csrf, decision: "allow" });
    const authorize = async () => {
      const form = fields(await begin().expect(200));
      const approved = fields(
        await login(form)
          .expect(200)
          .expect(/claude\.ai/),
      );
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
    const refresh = (token: string) =>
      client.post("/token").type("form").send({
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
      key,
      password,
      secret,
      client,
      clientId,
      http,
      totp,
      register,
      begin,
      login,
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
      expect(tools.body.result.tools).toMatchObject([
        { name: "ping", annotations: { readOnlyHint: true } },
      ]);
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
    "S6/S12: wrong credentials look alike and forged forwarding cannot bypass the IP limit",
    async ({ begin, login, totp, event }) => {
      const form = fields(await begin().expect(200));
      const validTotps = [-1, 0, 1, 2].map(totp);
      const wrongTotp = ["194025", "649175", "510068", "777021", "831252"].find(
        (value) => !validTotps.includes(value),
      );
      const passwordError = await login(
        form,
        { password: random() },
        undefined,
        `198.51.100.1, ${forwardedIp}`,
      ).expect(401);
      const totpError = await login(
        form,
        { totp: wrongTotp },
        undefined,
        `198.51.100.2, ${forwardedIp}`,
      ).expect(401);
      expect(passwordError.text).toBe(totpError.text);
      for (let i = 3; i <= 5; i++)
        await login(
          form,
          { password: random() },
          undefined,
          `198.51.100.${i}, ${forwardedIp}`,
        ).expect(401);
      await login(form, {}, undefined, `198.51.100.6, ${forwardedIp}`).expect(
        429,
      );
      expect((await event("login", "invalid")).ip).toBe(forwardedIp);
      expect((await event("login", "blocked")).ip).toBe(forwardedIp);
    },
  );

  run(
    "S6: a TOTP cannot be reused and the global limit spans clients' IPs",
    async ({ begin, login, event }) => {
      const first = fields(await begin().expect(200));
      await login(first).expect(200);
      const other = fields(await begin().expect(200));
      await login(other).expect(401);
      for (let i = 1; i < 20; i++)
        await login(
          other,
          { password: random() },
          undefined,
          `198.51.100.${i}`,
        ).expect(401);
      await login(other, {}, undefined, "203.0.113.8").expect(429);
      await event("login", "success");
      await event("login", "invalid");
      await event("login", "blocked");
    },
  );

  run(
    "S7: CSRF uses two request-specific values and secure headers",
    async ({ begin, login, http, key, client }) => {
      const page = await begin("S256", http(key, true))
        .expect(200)
        .expect("Content-Security-Policy", /default-src 'none'/)
        .expect("X-Frame-Options", "DENY")
        .expect("Referrer-Policy", "no-referrer");
      expect(page.get("Set-Cookie")?.[0]).toMatch(
        /(?=.*HttpOnly)(?=.*SameSite=Strict)(?=.*Secure)/,
      );
      const first = fields(await begin().expect(200));
      const second = fields(await begin().expect(200));
      await login(first, { csrf: "" }).expect(403);
      await login(first, { csrf: second.csrf }).expect(403);
      await client
        .post("/authorize/login")
        .type("form")
        .send({ csrf: first.csrf })
        .expect(403);
      const authenticated = fields(await login(first).expect(200));
      await client
        .post("/authorize/consent")
        .type("form")
        .set("Cookie", authenticated.cookie)
        .send({ csrf: first.csrf, decision: "allow" })
        .expect(403);
    },
  );

  run(
    "S8: auth storage has no plaintext credentials and wrong encryption keys fail safely",
    async ({
      authorize,
      exchange,
      password,
      secret,
      begin,
      login,
      http,
      sql,
    }) => {
      const code = await authorize();
      const { body } = await exchange(code).expect(200);
      const needles = [
        password,
        secret.base32,
        secret.hex,
        code,
        body.access_token,
        body.refresh_token,
      ].map((value) => Buffer.from(value));
      needles.push(Buffer.from(secret.hex, "hex"));
      for (const table of tables) {
        const [rows] = await sql.query<RowDataPacket[]>(
          `SELECT * FROM ${table}`,
        );
        for (const row of rows)
          for (const value of Object.values(row)) {
            const bytes = Buffer.isBuffer(value)
              ? value
              : Buffer.from(String(value));
            expect(needles.some((needle) => bytes.includes(needle))).toBe(
              false,
            );
          }
      }
      const problem = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const wrong = http(randomBytes(32));
        const form = fields(await begin("S256", wrong).expect(200));
        await login(form, {}, wrong).expect(503);
        expect(problem).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(/TOTP_ENCRYPTION_KEY/),
        );
        expect(problem.mock.calls[0].length).toBe(1);
      } finally {
        problem.mockRestore();
      }
    },
  );

  run(
    "S9: CLI can list, revoke one family, and invalidate all tokens or replace the user",
    async ({ issue, ping, refresh, sql, key, event, clientId }) => {
      const first = await issue();
      const url = new URL(setting("DATABASE_URL"));
      url.pathname = "/finance_test";
      const env = {
        ...process.env,
        DATABASE_URL: url.href,
        DATABASE_SOCKET: undefined,
        TOTP_ENCRYPTION_KEY: key.toString("base64"),
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
      const listed = (await tokens("list")).stdout;
      expect(listed.includes(clientId)).toBe(true);
      expect(
        listed.includes(first.access_token) ||
          listed.includes(first.refresh_token),
      ).toBe(false);
      await tokens("revoke", token.id);
      await ping(first.access_token).expect(401);
      await refresh(first.refresh_token).expect(400);
      await sql.query("UPDATE auth_users SET last_totp_step = NULL");
      const second = await issue();
      await tokens("revoke-all");
      await ping(second.access_token).expect(401);
      await refresh(second.refresh_token).expect(400);
      await sql.query("UPDATE auth_users SET last_totp_step = NULL");
      const third = await issue();
      const password = random();
      // Emulate the TTY methods used by readline while keeping credentials off the test output.
      const tty =
        "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;";
      const setup = spawn(
        process.execPath,
        [
          `--import=data:text/javascript,${encodeURIComponent(tty)}`,
          "src/server/dist/auth-cli.js",
          "setup",
        ],
        {
          env,
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 10_000,
        },
      );
      let output = "";
      let answered = 0;
      setup.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (answered === 0 && output.includes("tokens): ")) {
          answered++;
          setup.stdin.write(`${password}\r`);
        } else if (
          answered === 1 &&
          output.includes("Repite la contraseña: ")
        ) {
          answered++;
          setup.stdin.end(`${password}\r`);
        }
      });
      expect((await once(setup, "close"))[0]).toBe(0);
      expect(output.includes(password)).toBe(false);
      expect(
        /Secreto base32: [A-Z2-7]+\r?\nURI: otpauth:\/\/totp\//.test(output),
      ).toBe(true);
      await ping(third.access_token).expect(401);
      await refresh(third.refresh_token).expect(400);
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
