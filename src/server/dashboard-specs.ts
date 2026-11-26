import { randomUUID } from "node:crypto";
import { decimalMoney, parseAmount } from "@finance-manager/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "kysely";
import request from "supertest";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import { fakeGoogle } from "./google-test-provider.js";
import { authTransaction, digest, purgeAuth, revokeAll } from "./auth-store.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createLedger } from "./ledger/index.js";
import { createMcp } from "./mcp/index.js";
import { localDatabase } from "./scripts/local-database.js";

const origin = "https://finanzas.example";
const path = "/api/session";

export function dashboardSpecs(schema: string) {
  function verify(
    name: string,
    check: (ctx: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ) {
    test(
      "M-015 " + name,
      async () => {
        const ctx = await fixture();
        try {
          await sql`DELETE FROM auth_events`.execute(ctx.db);
          await check(ctx);
        } finally {
          await ctx.db.destroy();
          await ctx.google.close();
        }
      },
      25_000,
    );
  }

  async function fixture() {
    const google = await fakeGoogle();
    const connection = createDatabase({
      ...localDatabase("DATABASE_URL"),
      database: schema,
    });
    const api = request(
      createApp(
        readConfig({
          ...google.env,
          PUBLIC_URL: origin,
          MAX_REQUESTS_PER_USER_PER_MINUTE: "10000",
        }),
        undefined,
        connection,
      ),
    );
    const login = async () => {
      const start = await api.get("/auth/google/start").expect(303);
      const { cookie, ...query } = google.callback(start, "owner");
      return api
        .get("/auth/google/callback")
        .set("Cookie", cookie)
        .query(query)
        .expect(303);
    };
    const cookie = (response: Awaited<ReturnType<typeof login>>) =>
      response
        .get("Set-Cookie")!
        .find((value) => value.startsWith("__Host-fm-session="))!;
    const session = async () => cookie(await login()).split(";")[0];
    return {
      db: connection.db,
      api,
      login,
      cookie,
      google,
      session,
      ledger: createLedger(connection.db, "claude", "1"),
    };
  }

  verify(
    "S1: Google entrega una cookie segura vinculada al usuario",
    async ({ db, login, cookie }) => {
      const header = cookie(await login());
      expect(header).toMatch(/^__Host-[\w-]+=[\w-]{43};/);
      for (const attribute of [
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=43200",
        "Secure",
      ])
        expect(header).toContain(attribute);
      const token = header.split(";")[0].split("=")[1];
      expect(
        (
          await sql<{
            token_hash: Buffer;
          }>`SELECT token_hash FROM web_sessions WHERE token_hash = ${digest(token)}`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ token_hash: digest(token) }]);
    },
  );

  verify(
    "S2: expiración, cierre, revocación y purga de sesiones",
    async ({ db, api, session }) => {
      await api
        .get(path)
        .expect(401, { error: "Inicia sesión para continuar." });
      const expired = await session();
      const expiredHash = digest(expired.split("=")[1]);
      await sql`UPDATE web_sessions SET expires_at = UTC_TIMESTAMP(3) WHERE token_hash = ${expiredHash}`.execute(
        db,
      );
      await api.get("/api/accounts").set("Cookie", expired).expect(401);
      await authTransaction(db, purgeAuth);
      expect(
        (
          await sql`SELECT token_hash FROM web_sessions WHERE token_hash = ${expiredHash}`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
      const loggedOut = await session();
      await api
        .delete(path)
        .set("Cookie", loggedOut)
        .set("Origin", origin)
        .expect(204);
      await api.get(path).set("Cookie", loggedOut).expect(401);
      const cookies = [await session(), await session()];
      await authTransaction(db, (trx) => revokeAll(trx, "1"));
      for (const cookie of cookies)
        await api.get(path).set("Cookie", cookie).expect(401);
    },
  );

  verify(
    "S3: origen obligatorio en logout, revocación y undo, sin efectos",
    async ({ db, api, session, ledger }) => {
      const cookie = await session();
      const { operationId } = await ledger.createAccount({
        name: "Cuenta CSRF",
        currency: "BOB",
        kind: "asset",
        subtype: "efectivo",
      });
      for (const badOrigin of [undefined, "https://otra.example"]) {
        for (const call of [
          api.post(path + "/revoke"),
          api.delete(path),
          api.post("/api/operations/" + operationId + "/undo"),
        ]) {
          call.set("Cookie", cookie);
          if (badOrigin) call.set("Origin", badOrigin);
          await call.expect(403);
        }
      }
      await api.get(path).set("Cookie", cookie).expect(200);
      expect(
        (
          await sql`SELECT id FROM operations WHERE undoes_operation_id = ${operationId}`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql`SELECT id FROM auth_events WHERE event_type = 'login'`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(1);
    },
  );

  verify(
    "S4: lecturas, transferencia en dos monedas y mes sin ingresos",
    async ({ api, session, ledger }) => {
      const cookie = await session();
      const read = (name: string) =>
        api
          .get("/api/" + name)
          .set("Cookie", cookie)
          .expect(200);
      const root = (await ledger.getAccountTree(false)).find(
        (account) => account.kind === "expense" && account.parent_id === null,
      )!;
      const baseline = await read("summary?month=2080-02");
      const bob = await ledger.createAccount({
        name: "Caja dashboard",
        currency: "BOB",
        kind: "asset",
        subtype: "efectivo",
        opening: { amount: "1000", date: "2080-02-01" },
      });
      const usd = await ledger.createAccount({
        name: "Ahorro dashboard",
        currency: "USD",
        kind: "asset",
        subtype: "ahorro",
      });
      const food = await ledger.createCategory({
        name: "Comida dashboard",
        parentId: root.id,
      });
      await ledger.recordExchangeRate({
        from: "USD",
        to: "BOB",
        rate: "7",
        source: "prueba",
        date: "2080-02-01",
      });
      await ledger.recordExpense({
        date: "2080-02-07",
        description: "Almuerzo dashboard",
        accountId: bob.id,
        categoryId: food.id,
        amount: "45.50",
        tags: ["dashboard"],
      });
      await ledger.recordExpense({
        date: "2080-02-07",
        description: "Comida adicional",
        accountId: bob.id,
        categoryId: food.id,
        amount: "4",
      });
      await ledger.transfer({
        date: "2080-02-08",
        description: "Cambio dashboard",
        fromAccountId: bob.id,
        toAccountId: usd.id,
        amount: "70",
        receivedAmount: "10",
      });
      const summary = (await read("summary?month=2080-02")).body;
      const money = (moneda: string, monto: string) =>
        expect.objectContaining({ moneda, monto });
      expect(summary.current[0]).toEqual(
        expect.objectContaining({
          income: money("BOB", "0.00"),
          expense: money("BOB", "49.50"),
        }),
      );
      const worth = await ledger.getNetWorth({ date: "2080-02-29" });
      expect(summary.netWorth.bob).toEqual(
        decimalMoney(worth.amount, "BOB", await ledger.getCurrencyScales()),
      );
      expect(summary.netWorth.usd).toEqual(
        expect.objectContaining({ moneda: "USD" }),
      );
      const liquid = (values: { moneda: string; monto: string }[]) =>
        parseAmount(values.find(({ moneda }) => moneda === "BOB")!.monto, 2);
      expect(liquid(summary.liquid) - liquid(baseline.body.liquid)).toBe(
        88050n,
      );
      expect(summary.topCategories).toContainEqual(
        expect.objectContaining({
          id: food.id,
          amounts: [money("BOB", "49.50")],
        }),
      );
      expect(summary.recent[0].description).toBe("Cambio dashboard");
      const first = (
        await read("transactions?from=2080-02-01&to=2080-02-29&limit=1")
      ).body;
      expect(first.rows[0]).toMatchObject({
        type: "transferencia",
        actor: "claude",
        postings: [
          { accountId: bob.id, money: money("BOB", "-70.00") },
          { accountId: usd.id, money: money("USD", "10.00") },
        ],
      });
      const next = (
        await read(
          "transactions?from=2080-02-01&to=2080-02-29&limit=1&cursor=" +
            first.cursor,
        )
      ).body;
      expect(next.rows[0].description).toBe("Comida adicional");
      expect(next.dayTotals["2080-02-07"].expense).toEqual([
        money("BOB", "49.50"),
      ]);
      expect(
        (
          await read(
            "transactions?account=" +
              bob.id +
              "&category=" +
              food.id +
              "&type=gasto&tag=dashboard&q=Almuerzo",
          )
        ).body.rows,
      ).toHaveLength(1);
      expect(
        (await read("transactions?category=" + food.id + "&type=transferencia"))
          .body.rows,
      ).toEqual([]);
      const reports = (await read("reports?from=2080-01-01&to=2080-02-29"))
        .body;
      expect(
        reports.months.map((month: { month: string }) => month.month),
      ).toEqual(["2080-01", "2080-02"]);
      expect(reports.months[1]).toMatchObject({
        totals: summary.current,
        netWorth: summary.netWorth,
      });
      expect(reports.categories).toContainEqual(
        expect.objectContaining({ id: food.id }),
      );
      expect((await read("accounts")).body.accounts).toContainEqual(
        expect.objectContaining({
          id: bob.id,
          currency: "BOB",
          balances: expect.any(Array),
        }),
      );
      await api
        .get("/api/reports?from=2080-02-30&to=2080-03-10")
        .set("Cookie", cookie)
        .expect(400);
    },
  );

  verify(
    "S5: detalle de actividad, undo como web y conflictos",
    async ({ api, session, ledger, db }) => {
      const cookie = await session();
      const target = await ledger.createAccount({
        name: "Cuenta deshacer web",
        currency: "BOB",
        kind: "asset",
        subtype: "efectivo",
      });
      const operations = () =>
        api.get("/api/operations?limit=1").set("Cookie", cookie).expect(200);
      const undo = (id: string) =>
        api
          .post("/api/operations/" + id + "/undo")
          .set("Cookie", cookie)
          .set("Origin", origin);
      expect((await operations()).body.rows[0]).toMatchObject({
        id: target.operationId,
        actor: "claude",
        canUndo: true,
        changes: [
          {
            before: null,
            after: expect.stringContaining("Cuenta deshacer web"),
          },
        ],
      });
      const response = await undo(target.operationId!).expect(200);
      expect((await operations()).body.rows[0]).toMatchObject({
        id: response.body.operationId,
        actor: "web",
      });
      const page = (await operations()).body;
      const older = await api
        .get("/api/operations?limit=1&before=" + page.cursor)
        .set("Cookie", cookie)
        .expect(200);
      expect(older.body.rows[0]).toMatchObject({
        id: target.operationId,
        undone: true,
        canUndo: false,
      });
      expect(
        (await sql`SELECT id FROM accounts WHERE id = ${target.id}`.execute(db))
          .rows,
      ).toEqual([]);
      await undo(target.operationId!).expect(409);
      await undo(randomUUID()).expect(409);
      await undo("inválido").expect(400);
      const parent = await ledger.createAccount({
        name: "Cuenta con dependencia",
        currency: "BOB",
        kind: "asset",
        subtype: "banco",
      });
      await ledger.createAccount({
        name: "Cuenta dependiente",
        currency: "BOB",
        kind: "asset",
        subtype: "banco",
        parentId: parent.id,
      });
      const activity = await api
        .get("/api/operations?limit=2")
        .set("Cookie", cookie)
        .expect(200);
      expect(activity.body.rows[1]).toMatchObject({
        id: parent.operationId,
        canUndo: false,
      });
      await undo(parent.operationId!).expect(409);
    },
  );

  verify(
    "S6: JSON, no-store y ausencia de secretos en cuerpos",
    async ({ api, session }) => {
      const cookie = await session();
      const responses = [
        await api.get(path).set("Cookie", cookie).expect(200),
        await api.get(path).expect(401),
        await api.post(path + "/revoke").expect(403),
        await api.get("/api/desconocido").set("Cookie", cookie).expect(404),
        await api.get("/api/operations").set("Cookie", cookie).expect(200),
      ];
      for (const response of responses) {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-type"]).toMatch(/application\/json/);
        expect(response.text).not.toMatch(/token_hash/i);
        expect(response.text).not.toContain(cookie.split("=")[1]);
      }
    },
  );

  verify(
    "M-015B S1: Actividad marca como no deshacible un ciclo de padres",
    async ({ api, session, ledger }) => {
      const cookie = await session();
      const kind = {
        kind: "asset",
        currency: "BOB",
        subtype: "efectivo",
      } as const;
      const parent = await ledger.createAccount({
        ...kind,
        name: "M-015B padre",
      });
      const child = await ledger.createAccount({
        ...kind,
        name: "M-015B hija",
        parentId: parent.id,
      });
      const moved = await ledger.moveAccount({ id: child.id, parentId: null });
      await ledger.moveAccount({ id: parent.id, parentId: child.id });

      const activity = await api
        .get("/api/operations?limit=2")
        .set("Cookie", cookie)
        .expect(200);
      expect(activity.body.rows).toContainEqual(
        expect.objectContaining({ id: moved.operationId, canUndo: false }),
      );
      const undo = await api
        .post(`/api/operations/${moved.operationId}/undo`)
        .set("Origin", origin)
        .set("Cookie", cookie)
        .expect(409);
      expect(undo.body.error).toContain("crearía un ciclo");
    },
  );

  verify(
    "M-015B S2: conflictos de saldo archivado y clave duplicada en web y MCP",
    async ({ api, session, ledger, db }) => {
      const cookie = await session();
      const name = "M-015B caja archivada";
      const date = "2081-01-01";
      const kind = {
        kind: "asset",
        currency: "BOB",
        subtype: "efectivo",
      } as const;
      const cash = await ledger.createAccount({
        ...kind,
        name,
      });
      const correction = await ledger.reconcile(cash.id, "45", date);
      await ledger.reconcile(cash.id, "0", date);
      const movement = await ledger.reconcile(cash.id, "15", date);
      const deleted = await ledger.deleteTransaction({ id: movement!.id });
      const archived = await ledger.archiveAccount({ id: cash.id });
      const before = "M-015B nombre original";
      const account = await ledger.createAccount({ ...kind, name: before });
      const renamed = await ledger.renameAccount({
        id: account.id,
        name: "M-015B nombre nuevo",
      });
      await ledger.createAccount({ ...kind, name: before.toUpperCase() });
      const balanceError = `La cuenta archivada "${name}" debe tener saldo cero. Desarchívala o deshaz primero el archivado.`;
      const conflicts = [
        [correction!.operationId!, balanceError],
        [deleted.operationId, balanceError],
        [
          renamed.operationId!,
          `No se puede restaurar accounts/${account.id}: la clave ya está ocupada.`,
        ],
      ] as const;

      const mcp = createMcp("m015b-test", db, undefined, "1");
      const client = new Client({ name: "m015b-test", version: "1" });
      const [fromClient, fromServer] = InMemoryTransport.createLinkedPair();
      await mcp.connect(fromServer);
      try {
        await client.connect(fromClient);
        for (const [operationId, error] of conflicts) {
          expect(
            await client.callTool({
              name: "deshacer_operacion",
              arguments: { operationId },
            }),
          ).toMatchObject({
            isError: true,
            content: [{ type: "text", text: error }],
          });
        }
        for (const [operationId, error] of conflicts) {
          await api
            .post(`/api/operations/${operationId}/undo`)
            .set("Origin", origin)
            .set("Cookie", cookie)
            .expect(409, { error });
        }
      } finally {
        await client.close();
        await mcp.close();
      }

      const activity = await api
        .get("/api/operations?limit=12")
        .set("Cookie", cookie)
        .expect(200);
      for (const [id] of conflicts) {
        expect(activity.body.rows).toContainEqual(
          expect.objectContaining({ id, canUndo: false, undone: false }),
        );
      }
      expect(activity.body.rows).toContainEqual(
        expect.objectContaining({ id: archived.operationId, canUndo: true }),
      );
    },
  );
}
