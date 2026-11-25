import { extname, join } from "node:path";
import { APP_NAME } from "@finance-manager/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { installAuth } from "./auth-http.js";
import type { readConfig } from "./config.js";
import { checkDatabase, createDatabase } from "./database.js";
import { createMcp } from "./mcp/index.js";

type Config = ReturnType<typeof readConfig>;

export function createApp(
  { auth, database, readonlyDatabase, webDistDir, version }: Config,
  release?: string,
  connection = database && createDatabase(database),
) {
  const app = express();
  const pool = connection?.pool;
  const readonlyPool =
    readonlyDatabase &&
    createDatabase({
      ...readonlyDatabase,
      connectionLimit: 2,
      multipleStatements: false,
    }).pool;
  const requireAuth = installAuth(app, auth, connection?.db);
  let probe: ReturnType<typeof checkDatabase> | undefined;
  let expiresAt = Infinity;

  app.get("/health", async (_request, response) => {
    if (!probe || performance.now() >= expiresAt) {
      expiresAt = Infinity;
      probe = checkDatabase(pool).finally(() => {
        expiresAt = performance.now() + 10_000;
      });
    }
    response.set("Cache-Control", "no-store");
    if (release) response.set("X-Finance-Release", release);
    response.json({
      status: "ok",
      app: APP_NAME,
      version,
      db: await probe,
    });
  });

  app.post("/mcp", requireAuth, express.json(), async (request, response) => {
    const server = createMcp(version, connection?.db, readonlyPool);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close();
    }
  });
  app.all("/mcp", (_request, response) => {
    response.set("Allow", "POST").sendStatus(405);
  });

  app.use(express.static(webDistDir));
  app.get("/{*path}", (request, response, next) => {
    const segments = request.params.path;
    if (segments?.[0] === "assets" || extname(segments?.at(-1) ?? ""))
      return next();
    response.sendFile(join(webDistDir, "index.html"));
  });

  return app;
}
