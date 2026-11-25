import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import request from "supertest";
import { expect, test, vi } from "vitest";
import { APP_NAME } from "@finance-manager/core";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import * as database from "./database.js";

const version = "m002-test";
const app = createApp(readConfig({ APP_VERSION: version }));

test("S4: GET and DELETE cannot open an MCP session", async () => {
  await request(app).get("/mcp").expect(405).expect("Allow", "POST");
  await request(app).delete("/mcp").expect(405).expect("Allow", "POST");
});

test("S5: health reports when the database is not configured", async () => {
  const response = await request(app).get("/health").expect(200);
  expect(response.body).toEqual({
    status: "ok",
    app: APP_NAME,
    version,
    db: "not_configured",
  });
});

test("S5: health hides database errors and responds within three seconds", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const unavailable = createApp(
    readConfig({
      APP_VERSION: version,
      DATABASE_URL: `mysql://user:secret@127.0.0.1:${address.port}/test`,
    }),
  );
  const response = await request(unavailable)
    .get("/health")
    .timeout(2900)
    .expect(200);
  expect(response.body).toEqual({
    status: "ok",
    app: APP_NAME,
    version,
    db: "unavailable",
  });
});

test("S11: concurrent health requests share a probe and cache it for 10 seconds", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const probe = vi
    .spyOn(database, "checkDatabase")
    .mockImplementation(async () => {
      await setTimeout(50);
      return "unavailable";
    });
  const health = request(
    createApp(
      readConfig({
        DATABASE_URL: "mysql://user:secret@localhost/test",
      }),
    ),
  );
  const batch = () =>
    Promise.all(
      Array.from({ length: 20 }, () =>
        health
          .get("/health")
          .expect(200)
          .expect(({ body }) => {
            expect(body.db).toBe("unavailable");
          }),
      ),
    );

  try {
    await batch();
    expect(probe).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(9_999);
    await batch();
    expect(probe).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(10_000);
    await batch();
    expect(probe).toHaveBeenCalledTimes(2);
  } finally {
    probe.mockRestore();
    clock.mockRestore();
  }
});

test("S14: health times out during acquisition and releases a late connection", async () => {
  const release = vi.fn();
  const query = vi.fn();
  const connection = { release, query };
  let finishAcquisition!: () => void;
  const acquisition = new Promise<typeof connection>((resolve) => {
    finishAcquisition = () => resolve(connection);
  });
  const pool = {
    promise: () => ({ getConnection: () => acquisition }),
  } as unknown as Parameters<typeof database.checkDatabase>[0];
  vi.useFakeTimers();
  try {
    const health = database.checkDatabase(pool);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.race([health, Promise.resolve("pending")])).toBe(
      "unavailable",
    );
    finishAcquisition();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  } finally {
    finishAcquisition();
    vi.useRealTimers();
  }
});

test("S12: a Unix socket replaces TCP and must be an absolute path", () => {
  const DATABASE_URL = "mysql://user:secret@localhost:3308/test";
  expect(
    readConfig({ DATABASE_URL, DATABASE_SOCKET: "/ruta/abs" }).database,
  ).toEqual({
    socketPath: "/ruta/abs",
    user: "user",
    password: "secret",
    database: "test",
  });
  expect(() =>
    readConfig({ DATABASE_URL, DATABASE_SOCKET: "ruta/rel" }),
  ).toThrow(/DATABASE_SOCKET debe indicar una ruta absoluta/);
});

test("S6 / M-015 S7: serves dashboard routes and assets from a dot-directory worktree", async () => {
  const dist = await mkdtemp(join(tmpdir(), ".finance-web-"));
  try {
    const index = "<html>Finance Manager</html>";
    await writeFile(join(dist, "index.html"), index);
    await writeFile(join(dist, "style.css"), "body { color: red; }");
    const web = request(createApp(readConfig({ WEB_DIST_DIR: dist })));

    await web.get("/").expect(200, index);
    await web.get("/cualquier/ruta").expect(200, index);
    await web.get("/actividad").expect(200, index);
    await web
      .get("/style.css")
      .expect(200)
      .expect("Content-Type", /text\/css/);
    await web.get("/assets/missing").expect(404);
    await web.get("/missing.js").expect(404);
    await web.get("/health").expect(200).expect("Content-Type", /json/);
    await web.get("/mcp").expect(405);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test.each([
  ["PORT", "abc", /PORT debe ser un entero/],
  [
    "DATABASE_URL",
    "https://user:secret@localhost",
    /DATABASE_URL debe ser una URL mysql/,
  ],
])(
  "S7: rejects invalid %s without exposing its value",
  (name, value, message) => {
    expect(() => readConfig({ [name]: value })).toThrow(message);
    expect(() => readConfig({ [name]: value })).not.toThrow(/secret/);
  },
);
