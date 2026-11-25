import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import request from "supertest";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
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

test("the migration user can create and drop a table in finance_test but cannot read mysql", async () => {
  const migration = await createConnection({
    ...localDatabase("MIGRATION_DATABASE_URL"),
    database: "finance_test",
  });
  const table = `m001_${randomUUID().replaceAll("-", "")}`;
  try {
    await migration.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
    await expect(migration.query("USE mysql")).rejects.toMatchObject({
      code: "ER_DBACCESS_DENIED_ERROR",
    });
    await migration.query(`DROP TABLE ${table}`);
  } finally {
    await migration.end();
  }
});
