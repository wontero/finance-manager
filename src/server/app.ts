import { extname, join } from "node:path";
import { APP_NAME } from "@finance-manager/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { readConfig } from "./config.js";
import { checkDatabase, createDatabase } from "./database.js";

type Config = ReturnType<typeof readConfig>;

export function createApp(
  { database, webDistDir, version }: Config,
  release?: string,
) {
  const app = express();
  const pool = database && createDatabase(database).pool;
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

  app.post("/mcp", express.json(), async (request, response) => {
    const server = new McpServer({ name: APP_NAME, version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server.registerTool(
      "ping",
      {
        description: "Devuelve el estado, la versión y la hora del servidor.",
        annotations: { readOnlyHint: true },
      },
      () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: "pong",
              version,
              time: new Date().toISOString(),
            }),
          },
        ],
      }),
    );
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
