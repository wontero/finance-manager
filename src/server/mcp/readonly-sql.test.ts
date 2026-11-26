import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Kysely } from "kysely";
import type { Pool } from "mysql2";
import { expect, test, vi } from "vitest";
import { registerSql } from "./readonly-sql.js";

test("M-023C S1: rechaza comentarios de línea y separadores ajenos a MariaDB", async () => {
  const getConnection = vi.fn((callback) => callback(new Error("sin lector")));
  const server = new McpServer({ name: "m023c", version: "1" });
  registerSql(
    server,
    {} as Kysely<unknown>,
    {
      pool: { getConnection } as unknown as Pool,
      mainSchema: "principal",
      schema: "lectura",
    },
    "1",
  );
  const client = new Client({ name: "m023c", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    for (const sql of [
      ...["\u00a0", "\u2028", "\u3000", "\ufeff", " "].map(
        (separator) => `SELECT 1 --${separator}comentario\n`,
      ),
      "SELECT 1 # comentario",
      "\ufeffSELECT 1",
      "SELECT 1\u00a0",
      "SELECT 1;\u3000/* comentario */",
    ]) {
      const result = await client.callTool({
        name: "consulta_sql",
        arguments: { sql },
      });
      expect(result.isError).toBe(true);
      expect(getConnection, JSON.stringify(sql)).not.toHaveBeenCalled();
    }
  } finally {
    await client.close();
  }
});
