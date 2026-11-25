import { Kysely, MysqlDialect } from "kysely";
import { createPool, type PoolOptions, type Pool } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

export function createDatabase(options: PoolOptions) {
  const pool = createPool({
    ...options,
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    connectionLimit: 5,
    waitForConnections: false,
    connectTimeout: 750,
  });
  return {
    pool,
    db: new Kysely<unknown>({ dialect: new MysqlDialect({ pool }) }),
  };
}

export async function checkDatabase(pool: Pool | undefined) {
  if (!pool) return "not_configured";

  let connection: PoolConnection | undefined;
  try {
    connection = await pool.promise().getConnection();
    await connection.query({ sql: "SELECT 1", timeout: 750 });
    connection.release();
    return "ok";
  } catch {
    connection?.destroy();
    return "unavailable";
  }
}
