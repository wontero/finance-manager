import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { digest, newToken } from "./auth-store.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { fakeGoogle, responseCookie } from "./google-test-provider.js";
import { seed } from "./multiuser-specs.js";
import { localDatabase } from "./scripts/local-database.js";

const site = "https://finanzas.example";
const domain = [
  "accounts",
  "transactions",
  "postings",
  "tags",
  "transaction_tags",
  "custom_field_definitions",
  "loans",
  "exchange_rates",
  "operations",
  "audit_log",
] as const;
const owned = [
  ...domain,
  "oauth_authorization_codes",
  "oauth_tokens",
  "web_sessions",
  "auth_events",
  "user_request_limits",
  "readonly_sql_sessions",
] as const;

export function accountSpecs(schema: string, readonlySchema: string) {
  describe("M-024: cuenta, privacidad y métricas", () => {
    let google: Awaited<ReturnType<typeof fakeGoogle>>;
    let database: ReturnType<typeof createDatabase>;
    let browser: ReturnType<typeof request>;
    let a: Awaited<ReturnType<typeof seed>>;
    let b: typeof a;
    let userB: string;
    let cookieA: string;
    let cookieB: string;
    const access = newToken();
    const sessionHash = (cookie: string) => digest(cookie.split("=")[1]);

    function googleCallback(response: Response, sub: string) {
      const { cookie, ...params } = google.callback(response, sub);
      return browser
        .get("/auth/google/callback")
        .set("Cookie", cookie)
        .query(params);
    }

    async function login(sub: string) {
      const start = await browser.get("/auth/google/start").expect(303);
      return responseCookie(await googleCallback(start, sub).expect(303));
    }

    const rpc = (method: string, params?: object) =>
      browser
        .post("/mcp")
        .set("Authorization", "Bearer " + access)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method, params });

    async function snapshot(user: string) {
      return Object.fromEntries(
        await Promise.all(
          owned.map(async (table) => [
            table,
            (
              await sql`SELECT * FROM ${sql.table(table)} WHERE user_id = ${user}`.execute(
                database.db,
              )
            ).rows
              .map((row) => JSON.stringify(row))
              .sort(),
          ]),
        ),
      );
    }

    beforeAll(async () => {
      google = await fakeGoogle();
      database = createDatabase({
        ...localDatabase("DATABASE_URL"),
        database: schema,
      });
      const reader = new URL(process.env.READONLY_DATABASE_URL!);
      reader.pathname = readonlySchema;
      browser = request(
        createApp(
          readConfig({
            ...google.env,
            PUBLIC_URL: site,
            READONLY_DATABASE_URL: reader.href,
            MAX_REQUESTS_PER_USER_PER_MINUTE: "10000",
            METRICS_EMAIL: "metricas@example.test",
            OPERATOR_NAME: "Operadora <Prueba>",
            OPERATOR_CONTACT: "contacto@example.test",
          }),
          undefined,
          database,
        ),
      );
      cookieA = await login("owner");
      cookieB = await login("metricas");
      const {
        rows: [owner],
      } = await sql<{ user_id: string }>`SELECT user_id FROM web_sessions
        WHERE token_hash = ${sessionHash(cookieA)}`.execute(database.db);
      expect(owner.user_id).toBe("1");
      const {
        rows: [other],
      } = await sql<{ user_id: string }>`SELECT user_id FROM web_sessions
        WHERE token_hash = ${sessionHash(cookieB)}`.execute(database.db);
      userB = other.user_id;
      a = await seed(database.db, "1", "m024_privado_a", "90071992547409.91");
      b = await seed(database.db, userB, "m024_privado_b", "17.03");
      const clientId = randomUUID();
      await sql`INSERT INTO oauth_clients (id, metadata) VALUES (${clientId}, '{}')`.execute(
        database.db,
      );
      for (const user of ["1", userB]) {
        const family = digest(newToken());
        const expires = sql`UTC_TIMESTAMP(3) + INTERVAL 1 HOUR`;
        await sql`INSERT INTO oauth_authorization_codes
          (id, user_id, phase, client_id, redirect_uri, resource, code_challenge, expires_at)
          VALUES (${family}, ${user}, 'used', ${clientId}, ${site}, ${site + "/mcp"}, ${digest(newToken())}, ${expires})`.execute(
          database.db,
        );
        await sql`INSERT INTO oauth_tokens (token_hash, token_type, family_id, client_id, resource, expires_at, family_expires_at, user_id)
          VALUES (${digest(user === "1" ? access : newToken())}, 'access', ${family}, ${clientId}, ${site + "/mcp"}, ${expires}, ${expires}, ${user}),
            (${digest(newToken())}, 'refresh', ${family}, ${clientId}, ${site + "/mcp"}, ${expires}, ${expires}, ${user})`.execute(
          database.db,
        );
        await sql`INSERT INTO readonly_sql_sessions (connection_id, user_id, lock_name, expires_at)
          VALUES (${1000000000 + Number(user)}, ${user}, ${randomUUID()}, ${expires})`.execute(
          database.db,
        );
      }
    });

    afterAll(async () => {
      await google?.close();
      await database?.db.destroy();
    });

    test("S1: exporta todos los datos financieros propios con montos decimales exactos", async () => {
      const result = await browser
        .get("/api/account/export")
        .set("Cookie", cookieA)
        .expect(200)
        .expect("Content-Disposition", /attachment/)
        .expect("Cache-Control", "no-store");
      const expected = await snapshot("1");
      for (const table of domain) {
        expect(expected[table].length, table).toBeGreaterThan(0);
        expect(result.body[table], table).toHaveLength(expected[table].length);
        expect(
          result.body[table].every(
            (row: { user_id: string }) => row.user_id === "1",
          ),
          table,
        ).toBe(true);
      }
      expect(result.body.postings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            transaction_id: a.entry.id,
            amount: "90071992547409.91",
          }),
          expect.objectContaining({
            transaction_id: a.entry.id,
            amount: "-90071992547409.91",
          }),
        ]),
      );
      expect(result.body.exchange_rates).toContainEqual(
        expect.objectContaining({
          source: "m024_privado_a",
          rate: "90071992547409.9100000000",
        }),
      );
      expect(result.body.loans).toContainEqual(
        expect.objectContaining({
          counterparty: "m024_privado_a",
          principal: "100.00",
          principal_paid: "0.00",
          interest_paid: "0.00",
        }),
      );
      expect(result.text).not.toContain("m024_privado_b");
      expect(result.text).not.toContain("metricas@example.test");
      await browser.get("/api/account/export").expect(401);
    });

    test("S3: un usuario no puede modificar la bitácora por SQL ni con deshacer", async () => {
      const {
        rows: [row],
      } = await sql<{ id: string; operation_id: string }>`
        SELECT id, operation_id FROM audit_log WHERE user_id = 1 ORDER BY id DESC LIMIT 1
      `.execute(database.db);
      for (const query of [
        sql`UPDATE audit_log SET row_id = '0' WHERE id = ${row.id}`,
        sql`DELETE FROM audit_log WHERE id = ${row.id}`,
        sql`DELETE FROM operations WHERE id = ${row.operation_id}`,
      ])
        await expect(query.execute(database.db)).rejects.toMatchObject({
          sqlState: "45000",
        });
      for (const statement of [
        "UPDATE audit_log SET row_id = '0'",
        "DELETE FROM audit_log",
      ]) {
        const result = await rpc("tools/call", {
          name: "consulta_sql",
          arguments: { sql: statement },
        }).expect(200);
        expect(result.body.result.isError).toBe(true);
      }
      const readAudit = async () =>
        (
          await sql<{ id: string }>`
        SELECT * FROM audit_log WHERE user_id = 1 ORDER BY id
      `.execute(database.db)
        ).rows;
      const account = await a.ledger.createAccount({
        name: "m024_undo",
        kind: "asset",
        subtype: "efectivo",
        currency: "BOB",
      });
      const before = await readAudit();
      await browser
        .post("/api/operations/" + account.operationId + "/undo")
        .set("Cookie", cookieA)
        .set("Origin", site)
        .expect(200);
      const after = await readAudit();
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
    });

    test("S4: solo el email verificado de métricas obtiene agregados", async () => {
      await browser.get("/metricas").expect(404);
      await browser.get("/metricas").set("Cookie", cookieA).expect(404);
      const requests = () =>
        sql<{
          day: string;
          channel: string;
          status_class: number;
          requests: string;
        }>`
        SELECT * FROM request_metrics WHERE day = UTC_DATE()
      `.execute(database.db);
      const count = (
        rows: Awaited<ReturnType<typeof requests>>["rows"],
        channel: string,
        status: number,
      ) =>
        Number(
          rows.find(
            ({ channel: key, status_class }) =>
              key === channel && status_class === status,
          )?.requests ?? 0,
        );
      const previous = (await requests()).rows;
      await browser.get("/api/session").set("Cookie", cookieB).expect(200);
      await browser.get("/api/session").expect(401);
      await rpc("ping").expect(200);
      await browser.get("/mcp").expect(405);
      await expect
        .poll(async () => {
          const { rows } = await requests();
          return (["api", "mcp"] as const).flatMap((channel) =>
            [2, 4].map(
              (status) =>
                count(rows, channel, status) - count(previous, channel, status),
            ),
          );
        })
        .toEqual([1, 1, 1, 1]);

      const {
        rows: [users],
      } = await sql<{
        total: string;
        week: string;
        month: string;
        active: string;
      }>`
        SELECT COUNT(*) AS total,
          COUNT(CASE WHEN created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY THEN 1 END) AS week,
          COUNT(CASE WHEN created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY THEN 1 END) AS month,
          COUNT(CASE WHEN last_seen_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY THEN 1 END) AS active
        FROM users
      `.execute(database.db);
      const { text } = await browser
        .get("/metricas")
        .set("Cookie", cookieB)
        .expect(200);
      for (const [label, value] of Object.entries({
        "Usuarios totales": users.total,
        "Altas en 7 días": users.week,
        "Altas en 30 días": users.month,
        "Usuarios activos en 7 días": users.active,
      }))
        expect(text).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
      const { rows } = await requests();
      const today = rows[0].day;
      const row = text.match(
        new RegExp(`<tr><th scope="row">${today}</th>(.*?)</tr>`),
      )?.[1];
      const expectedCells = ["mcp", "api"].flatMap((channel) => {
        const total = [1, 2, 3, 4, 5].reduce(
          (sum, status) => sum + count(rows, channel, status),
          0,
        );
        return [
          `<td>${total}</td>`,
          ...[4, 5].map(
            (status) =>
              `<td>${((100 * count(rows, channel, status)) / total).toFixed(2)} %</td>`,
          ),
        ];
      });
      expect(row).toBe(expectedCells.join(""));
      expect(text.match(/<th scope="row">/g)).toHaveLength(30);
      expect(text).not.toMatch(
        /@|user_id|m024_privado|metricas@example|owner@example/,
      );
    });

    test("S5: muestra públicamente al operador con sus valores escapados", async () => {
      const result = await browser
        .get("/privacidad")
        .expect(200)
        .expect("Content-Type", /html/);
      for (const value of [
        "Privacidad y términos",
        "Operadora &lt;Prueba&gt;",
        "contacto@example.test",
        "Claude",
        "cifradas",
        "Exportar",
        "Borrar",
      ])
        expect(result.text).toContain(value);
    });

    test("S2: borra por transacción al usuario #1, exige confirmación y deja a B intacto", async () => {
      const remove = (confirmation: string, cookie = cookieA) =>
        browser
          .delete("/api/account")
          .set("Origin", site)
          .set("Cookie", cookie)
          .send({ confirmation });
      const before = await snapshot("1");
      await remove("borrar").expect(400);
      expect((await snapshot("1")).accounts).toEqual(before.accounts);
      await sql`UPDATE web_sessions SET created_at = UTC_TIMESTAMP(3) - INTERVAL 11 MINUTE
        WHERE token_hash = ${sessionHash(cookieA)}`.execute(database.db);
      await remove("BORRAR").expect(428);
      expect((await snapshot("1")).audit_log).toEqual(before.audit_log);

      const start = () =>
        browser
          .post("/auth/google/reauth")
          .set("Origin", site)
          .set("Cookie", cookieA)
          .expect(303);
      const wrong = await start();
      expect(new URL(wrong.headers.location).searchParams.get("prompt")).toBe(
        "select_account",
      );
      await googleCallback(wrong, "metricas").expect(403);
      await remove("BORRAR").expect(428);
      const correct = await googleCallback(await start(), "owner")
        .expect(303)
        .expect("Location", "/cuenta?reauth=1");
      const fresh = responseCookie(correct);
      expect(fresh).not.toBe(cookieA);
      await browser.get("/api/session").set("Cookie", cookieA).expect(401);

      // Conserva un reto de reautenticación pendiente para comprobar su borrado en cascada.
      await browser
        .post("/auth/google/reauth")
        .set("Origin", site)
        .set("Cookie", fresh)
        .expect(303);
      const otherBefore = await snapshot(userB);
      const balances = await b.ledger.dashboardAccounts();
      const ownBefore = await snapshot("1");
      for (const table of owned)
        expect(ownBefore[table].length, table).toBeGreaterThan(0);
      const migration = createDatabase({
        ...localDatabase("MIGRATION_DATABASE_URL"),
        database: schema,
      });
      try {
        await sql`CREATE TRIGGER m024_fail_delete BEFORE DELETE ON users FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Prueba de rollback de cuenta'`.execute(
          migration.db,
        );
        await remove("BORRAR", fresh).expect(500);
        const ownAfter = await snapshot("1");
        for (const table of owned) {
          if (table !== "user_request_limits")
            expect(ownAfter[table], table).toEqual(ownBefore[table]);
        }
      } finally {
        await sql`DROP TRIGGER IF EXISTS m024_fail_delete`.execute(
          migration.db,
        );
        await migration.db.destroy();
      }
      await remove("BORRAR", fresh).expect(204);
      const own = await snapshot("1");
      for (const table of owned) expect(own[table], table).toEqual([]);
      expect(
        (await sql`SELECT id FROM users WHERE id = 1`.execute(database.db))
          .rows,
      ).toEqual([]);
      expect(
        (
          await sql`SELECT state_hash FROM google_login_requests WHERE reauth_session_hash = ${sessionHash(fresh)}`.execute(
            database.db,
          )
        ).rows,
      ).toEqual([]);
      expect(await snapshot(userB)).toEqual(otherBefore);
      expect(await b.ledger.dashboardAccounts()).toEqual(balances);
      await browser.get("/api/session").set("Cookie", fresh).expect(401);
      await rpc("ping").expect(401);
      await browser.get("/api/session").set("Cookie", cookieB).expect(200);
      await browser
        .get("/api/session")
        .set("Cookie", await login("owner"))
        .expect(200);
      expect(
        (
          await sql`SELECT id FROM users WHERE google_sub = 'owner'`.execute(
            database.db,
          )
        ).rows,
      ).not.toEqual([{ id: "1" }]);
    });
  });
}
