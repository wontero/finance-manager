import type { ServerResponse } from "node:http";
import { extname } from "node:path";
import { APP_NAME } from "@finance-manager/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { warnUnlinkedOwner } from "./auth-google.js";
import { installAuth } from "./auth-http.js";
import { allowUserRequest } from "./auth-rate-limit.js";
import type { readConfig } from "./config.js";
import { dashboardApi, dashboardHeaders } from "./dashboard-http.js";
import { checkDatabase, createDatabase } from "./database.js";
import { createMcp } from "./mcp/index.js";
import { clearReadonlySessions } from "./mcp/readonly-sql.js";
import { countRequests, installPrivacyPages } from "./privacy-pages.js";

type Config = ReturnType<typeof readConfig>;

function setDashboardHeaders(response: ServerResponse) {
  for (const [name, value] of Object.entries(dashboardHeaders))
    if (!response.hasHeader(name)) response.setHeader(name, value);
}

export function createApp(
  { auth, database, privacy, readonlyDatabase, webDistDir, version }: Config,
  release?: string,
  connection = database && createDatabase(database),
) {
  const app = express();
  const pool = connection?.pool;
  const readonly =
    connection?.schema && readonlyDatabase?.database
      ? {
          pool: createDatabase({
            ...readonlyDatabase,
            connectionLimit: 2,
            multipleStatements: false,
          }).pool,
          mainSchema: connection.schema,
          schema: readonlyDatabase.database,
        }
      : undefined;
  if (readonly && connection)
    void clearReadonlySessions(connection.db).catch(() => {
      console.error("No se pudieron limpiar las sesiones SQL de solo lectura.");
    });
  if (connection)
    void warnUnlinkedOwner(connection.db).catch(() => {
      console.error("No se pudo comprobar la vinculación del usuario #1.");
    });
  app.use("/mcp", countRequests(connection?.db, "mcp"));
  app.use("/api", countRequests(connection?.db, "api"));
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
    const userId = request.auth?.extra?.userId;
    if (typeof userId !== "string" || !connection) {
      response.sendStatus(401);
      return;
    }
    if (
      !(await allowUserRequest(
        connection.db,
        userId,
        auth.requestsPerMinute,
        response,
      ))
    )
      return;
    const server = createMcp(version, connection.db, readonly, userId);
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

  app.use("/api", dashboardApi(auth, connection?.db));
  installPrivacyPages(app, auth, privacy, connection?.db);
  app.use(express.static(webDistDir, { setHeaders: setDashboardHeaders }));
  app.get("/{*path}", (request, response, next) => {
    const segments = request.params.path;
    if (segments?.[0] === "assets" || extname(segments?.at(-1) ?? ""))
      return next();
    setDashboardHeaders(response);
    response.sendFile("index.html", { root: webDistDir });
  });

  return app;
}
