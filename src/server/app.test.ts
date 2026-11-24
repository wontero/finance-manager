import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { expect, test } from "vitest";
import { APP_NAME } from "@finance-manager/core";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const version = "m002-test";
const app = createApp(readConfig({ APP_VERSION: version }));

function postMcp(method: string, params: object = {}) {
  return request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method, params });
}

test("S1: initialize responds with JSON and no MCP session", async () => {
  const response = await postMcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "integration-client", version: "1" },
  });
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toMatch(/^application\/json/);
  expect(response.headers["mcp-session-id"]).toBeUndefined();
  expect(response.body.result.serverInfo).toEqual({
    name: "Finance Manager",
    version,
  });
});

test("S2: tools/list has exactly one read-only tool", async () => {
  const response = await postMcp("tools/list");
  expect(response.status).toBe(200);
  expect(response.body.result.tools).toMatchObject([
    { name: "ping", annotations: { readOnlyHint: true } },
  ]);
});

test("S3: ping returns pong, the version and an ISO timestamp", async () => {
  const response = await postMcp("tools/call", { name: "ping", arguments: {} });
  expect(response.status).toBe(200);
  const [content] = response.body.result.content;
  expect(content.type).toBe("text");
  const { message, version: reportedVersion, time } = JSON.parse(content.text);
  expect(message).toBe("pong");
  expect(reportedVersion).toBe(version);
  expect(new Date(time).toISOString()).toBe(time);
});

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

test("S6: serves the dashboard and assets without masking reserved routes", async () => {
  const dist = await mkdtemp(join(tmpdir(), "finance-web-"));
  try {
    const index = "<html>Finance Manager</html>";
    await writeFile(join(dist, "index.html"), index);
    await writeFile(join(dist, "style.css"), "body { color: red; }");
    const web = request(createApp(readConfig({ WEB_DIST_DIR: dist })));

    await web.get("/").expect(200, index);
    await web.get("/cualquier/ruta").expect(200, index);
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
