import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { digest } from "./auth-store.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { fakeGoogle, responseCookie } from "./google-test-provider.js";
import { createLedger } from "./ledger/index.js";
import { localDatabase } from "./scripts/local-database.js";

const site = "https://finanzas.example";
const redirect = "https://claude.ai/api/mcp/auth_callback";
const verifier = randomBytes(32).toString("base64url");
const legacyAccess = "a".repeat(43);
const legacyRefresh = "r".repeat(43);
const legacySession = "s".repeat(43);
const legacyCode = "c".repeat(43);
const legacyClient = "10000000-0000-4000-8000-000000000022";

export async function seedPreviousAuth(db: Kysely<unknown>) {
  const metadata = JSON.stringify({
    client_id: legacyClient,
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  });
  const family = digest("old-family");
  await sql`INSERT INTO oauth_clients (id, metadata) VALUES (${legacyClient}, ${metadata})`.execute(
    db,
  );
  await sql`INSERT INTO oauth_authorization_codes (id, code_hash, phase, client_id, redirect_uri, resource, code_challenge, expires_at)
    VALUES (${family}, ${digest(legacyCode)}, 'code', ${legacyClient}, ${redirect}, ${site + "/mcp"}, ${digest(verifier)},
    DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`.execute(db);
  for (const [type, value] of [
    ["access", legacyAccess],
    ["refresh", legacyRefresh],
  ]) {
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, family_id, client_id, resource, expires_at, family_expires_at)
      VALUES (${digest(value)}, ${type}, ${family}, ${legacyClient}, ${site + "/mcp"},
      DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 DAY))`.execute(
      db,
    );
  }
  await sql`INSERT INTO web_sessions (token_hash, created_at, expires_at)
    VALUES (${digest(legacySession)}, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`.execute(
    db,
  );
}

export function googleSpecs(schema: string, readonlySchema: string) {
  describe("M-022 Google OIDC", () => {
    let google: Awaited<ReturnType<typeof fakeGoogle>>;
    let database: ReturnType<typeof createDatabase>;
    let a: string;
    let b: string;
    const client = (env: NodeJS.ProcessEnv = {}) =>
      request(
        createApp(
          readConfig({
            ...google.env,
            PUBLIC_URL: site,
            ...env,
          }),
          undefined,
          database,
        ),
      );
    let http: ReturnType<typeof client>;

    beforeAll(async () => {
      google = await fakeGoogle();
      database = createDatabase({
        ...localDatabase("DATABASE_URL"),
        database: schema,
      });
      http = client();
    });
    afterAll(async () => {
      await google?.close();
      await database?.db.destroy();
    });

    const callback = (
      browser: typeof http,
      { cookie, ...query }: ReturnType<typeof google.callback>,
    ) =>
      browser.get("/auth/google/callback").set("Cookie", cookie).query(query);
    const start = async (sub: string, extra = {}, browser = http) =>
      google.callback(
        await browser.get("/auth/google/start").expect(303),
        sub,
        extra,
      );
    const login = async (sub: string, browser = http) => {
      const result = await callback(browser, await start(sub, {}, browser))
        .expect(303)
        .expect("Location", "/");
      const cookie = result
        .get("Set-Cookie")
        ?.find((c) => c.startsWith("__Host-fm-session="));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      return cookie!.split(";")[0];
    };
    const users = async () =>
      (
        await sql<{
          id: string;
          google_sub: string | null;
          last_seen_at: string | null;
        }>`
        SELECT id, google_sub, last_seen_at FROM users ORDER BY id
      `.execute(database.db)
      ).rows;
    const accountNames = async (cookie: string) =>
      (await http.get("/api/accounts").set("Cookie", cookie).expect(200)).text;

    test("S1: rechaza state, nonce, aud, iss, caducidad y email sin verificar", async () => {
      const before = await users();
      const params = await start("intruso");
      await callback(http, { ...params, state: "incorrecto" }).expect(403);
      await callback(http, { ...params, cookie: "" }).expect(403);
      for (const claims of [
        { nonce: "incorrecto" },
        { aud: "otro-cliente" },
        { aud: [google.env.GOOGLE_CLIENT_ID, "otro-cliente"] },
        { iss: "https://otro.example" },
        { exp: 1 },
        { email_verified: false },
      ]) {
        await callback(http, await start("intruso", claims)).expect(403);
      }
      expect(await users()).toEqual(before);
    });

    test("S2: vincula el #1, conserva su cuenta y aprovisiona una sola vez al #2", async () => {
      await createLedger(database.db, "web", "1").createAccount({
        name: "Caja privada M022 A",
        kind: "asset",
        subtype: "efectivo",
        currency: "BOB",
      });
      a = await login("owner", client({ MAX_USERS: "0" }));
      b = await login("other");
      expect(await users()).toMatchObject([
        { id: "1", google_sub: "owner", last_seen_at: expect.any(String) },
        { id: "2", google_sub: "other", last_seen_at: expect.any(String) },
      ]);
      expect(await accountNames(a)).toContain("Caja privada M022 A");
      expect(await accountNames(b)).not.toContain("Caja privada M022 A");
      expect(await accountNames(b)).toContain("Comida");
      await createLedger(database.db, "web", "2").createAccount({
        name: "Caja privada M022 B",
        kind: "asset",
        subtype: "efectivo",
        currency: "BOB",
      });
    });

    test("S3: callbacks concurrentes respetan el cupo y no duplican el mismo sub", async () => {
      const capped = client({ MAX_USERS: "3" });
      const starts = await Promise.all(
        ["tres-a", "tres-b"].map((sub) => start(sub, {}, capped)),
      );
      const results = await Promise.all(
        starts.map((item) => callback(capped, item)),
      );
      expect(results.map(({ status }) => status).sort()).toEqual([303, 403]);
      expect(results.find(({ status }) => status === 403)?.text).toContain(
        "Registro cerrado",
      );
      expect(await users()).toHaveLength(3);
      await login("owner", client({ MAX_USERS: "0" }));
      const open = client({ MAX_USERS: "4" });
      const duplicates = await Promise.all([
        start("repetido", {}, open),
        start("repetido", {}, open),
      ]);
      await Promise.all(
        duplicates.map((item) => callback(open, item).expect(303)),
      );
      expect(
        (await users()).filter(({ google_sub }) => google_sub === "repetido"),
      ).toHaveLength(1);
      await callback(open, duplicates[0]).expect(403);
    });

    const rpc = (token: string, name: string, args = {}, browser = http) =>
      browser
        .post("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        });
    const token = (clientId: string, grant: object) =>
      http
        .post("/token")
        .type("form")
        .send({ client_id: clientId, ...grant });

    async function issue(clientId: string, sub: string) {
      const start = await http
        .get("/authorize")
        .query({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: "code",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          state: "claude-state",
          resource: site + "/mcp",
        })
        .expect(200);
      const csrf = (response: typeof start) =>
        /name="csrf" value="([^"]+)"/.exec(response.text)![1];
      const googleRedirect = await http
        .post("/authorize/google")
        .type("form")
        .set("Cookie", responseCookie(start))
        .send({ csrf: csrf(start) })
        .expect(303);
      const consent = await callback(http, google.callback(googleRedirect, sub))
        .expect(200)
        .expect(/Autorizar/);
      const approved = await http
        .post("/authorize/consent")
        .type("form")
        .set("Cookie", responseCookie(consent))
        .send({ csrf: csrf(consent), decision: "allow" })
        .expect(303);
      const url = new URL(approved.headers.location);
      expect(url.searchParams.get("state")).toBe("claude-state");
      return (
        await token(clientId, {
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          code_verifier: verifier,
          redirect_uri: redirect,
        }).expect(200)
      ).body;
    }

    test("S4: Claude conserva el usuario al emitir, refrescar y revocar", async () => {
      const registration = await http
        .post("/register")
        .send({
          client_name: "Claude de prueba",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        })
        .expect(201);
      const id: string = registration.body.client_id;
      const [ta, tb] = await Promise.all([
        issue(id, "owner"),
        issue(id, "other"),
      ]);
      const tool = "listar_cuentas";
      const dataA = await rpc(ta.access_token, tool).expect(200);
      expect(dataA.text).toContain("Caja privada M022 A");
      expect(dataA.text).not.toContain("Caja privada M022 B");
      expect((await rpc(tb.access_token, tool).expect(200)).text).toContain(
        "Caja privada M022 B",
      );
      const reader = new URL(process.env.READONLY_DATABASE_URL!);
      reader.pathname = readonlySchema;
      const sqlClient = client({ READONLY_DATABASE_URL: reader.href });
      for (const [token, own, other] of [
        [ta.access_token, "A", "B"],
        [tb.access_token, "B", "A"],
      ]) {
        const result = await rpc(
          token,
          "consulta_sql",
          { sql: "SELECT name FROM v_accounts" },
          sqlClient,
        ).expect(200);
        expect(result.body.result.isError).not.toBe(true);
        expect(result.text).toContain("Caja privada M022 " + own);
        expect(result.text).not.toContain("Caja privada M022 " + other);
      }
      const next = (
        await token(id, {
          grant_type: "refresh_token",
          refresh_token: ta.refresh_token,
        }).expect(200)
      ).body;
      expect((await rpc(next.access_token, tool).expect(200)).text).toContain(
        "Caja privada M022 A",
      );
      await http
        .post("/revoke")
        .type("form")
        .send({ client_id: id, token: next.refresh_token })
        .expect(200);
      await rpc(next.access_token, tool).expect(401);
      await rpc(tb.access_token, tool).expect(200);
    });

    test("S5: las sesiones se aíslan y cerrar o revocar A no afecta a B", async () => {
      expect(await accountNames(a)).not.toContain("Caja privada M022 B");
      expect(await accountNames(b)).not.toContain("Caja privada M022 A");
      await http.delete("/api/session").set("Cookie", a).expect(403);
      const secondA = await login("owner");
      await http
        .delete("/api/session")
        .set("Cookie", a)
        .set("Origin", site)
        .expect(204);
      await http.get("/api/session").set("Cookie", a).expect(401);
      await http.get("/api/session").set("Cookie", secondA).expect(200);
      await http
        .post("/api/session/revoke")
        .set("Cookie", secondA)
        .set("Origin", site)
        .expect(204);
      await http.get("/api/session").set("Cookie", secondA).expect(401);
      await http.get("/api/session").set("Cookie", b).expect(200);
    });

    test("S6: la migración invalida credenciales anteriores y retira el login local", async () => {
      await rpc(legacyAccess, "ping").expect(401);
      const refresh = await token(legacyClient, {
        grant_type: "refresh_token",
        refresh_token: legacyRefresh,
      }).expect(400);
      expect(refresh.body.error).toBe("invalid_grant");
      await token(legacyClient, {
        grant_type: "authorization_code",
        code: legacyCode,
        code_verifier: verifier,
        redirect_uri: redirect,
      }).expect(400);
      await http
        .get("/api/session")
        .set("Cookie", `__Host-fm-session=${legacySession}`)
        .expect(401);
      await http
        .post("/api/session")
        .set("Origin", site)
        .send({ password: "anterior" })
        .expect(401);
      await http
        .post("/authorize/login")
        .type("form")
        .send({ password: "anterior", totp: "123456" })
        .expect(404);
      const { rows } = await sql`SHOW TABLES LIKE 'auth_users'`.execute(
        database.db,
      );
      expect(rows).toHaveLength(0);
    });

    test("S7: la petición 121 recibe 429 y otro usuario conserva su cupo", async () => {
      const c = await login("rate-a");
      const d = await login("rate-b");
      const {
        body: { client_id },
      } = await http
        .post("/register")
        .send({
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        })
        .expect(201);
      const { access_token } = await issue(client_id, "rate-a");
      await rpc(access_token, "ping").expect(200);
      for (let i = 0; i < 119; i++)
        await http.get("/api/session").set("Cookie", c).expect(200);
      await http
        .get("/api/session")
        .set("Cookie", c)
        .expect(429)
        .expect(/Demasiadas solicitudes/);
      await rpc(access_token, "ping", {}, client()).expect(429);
      await http.get("/api/session").set("Cookie", d).expect(200);
    });
  });
}
