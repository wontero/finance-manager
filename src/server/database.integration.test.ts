import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import mariadb, { type Connection } from "mariadb";
import request from "supertest";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { localDatabase } from "./scripts/local-database.js";

let connection: Connection;

beforeAll(async () => {
  connection = await mariadb.createConnection(localDatabase("DATABASE_URL"));
});

afterAll(async () => {
  await connection?.end();
});

test("connects to MariaDB 10.6 using DATABASE_URL", async () => {
  const [row] = await connection.query("SELECT VERSION() AS version");

  expect(row.version).toMatch(/^10\.6\..*MariaDB/);
});

test("S5: health reports a working connection to local MariaDB", async () => {
  const response = await request(createApp(readConfig(process.env)))
    .get("/health")
    .expect(200);
  expect(response.body.db).toBe("ok");
});

test("finance_dev can create and drop a table in finance_test but cannot read mysql", async () => {
  await connection.query("USE finance_test");
  const [row] = await connection.query(
    "SELECT CURRENT_USER() AS account, DATABASE() AS db",
  );
  expect(row.account).toMatch(/^finance_dev@/);
  expect(row.db).toBe("finance_test");

  const table = `m001_${randomUUID().replaceAll("-", "")}`;
  await connection.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
  try {
    await expect(connection.query("USE mysql")).rejects.toMatchObject({
      code: "ER_DBACCESS_DENIED_ERROR",
    });
  } finally {
    await connection.query(`DROP TABLE finance_test.${table}`);
  }
});
