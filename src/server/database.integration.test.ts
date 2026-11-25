import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import request from "supertest";
import express from "express";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { localDatabase } from "./scripts/local-database.js";

let connection: Connection;

beforeAll(async () => {
  connection = await createConnection(localDatabase("DATABASE_URL"));
});

afterAll(async () => {
  await connection?.end();
});

test("connects to MariaDB 10.6 using DATABASE_URL", async () => {
  const [[row]] = await connection.query<RowDataPacket[]>(
    "SELECT VERSION() AS version",
  );

  expect(row.version).toMatch(/^10\.6\..*MariaDB/);
});

test("S5: health reports a working connection to local MariaDB", async () => {
  const response = await request(createApp(readConfig(process.env)))
    .get("/health")
    .expect(200);
  expect(response.body.db).toBe("ok");
});

test("S14: ten concurrent requests wait for connections in the application pool", async () => {
  const { pool } = createDatabase(localDatabase("DATABASE_URL"));
  const server = express();
  const connectionIds = new Set<number>();
  const queued = vi.fn();
  pool.on("enqueue", queued);
  server.get("/", async (_req, res) => {
    const [[row]] = await pool
      .promise()
      .query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id, SLEEP(0.1)");
    connectionIds.add(row.id);
    res.sendStatus(204);
  });
  try {
    const responses = await Promise.allSettled(
      Array.from({ length: 10 }, () => request(server).get("/").expect(204)),
    );
    for (const response of responses)
      if (response.status === "rejected") throw response.reason;
    expect(connectionIds.size).toBeLessThan(10);
    expect(queued).toHaveBeenCalled();
  } finally {
    await pool.promise().end();
  }
});
