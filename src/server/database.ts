import { Kysely, MysqlDialect } from "kysely";
import {
  createPool,
  type PoolOptions,
  type Pool,
  type PoolConnection,
} from "mysql2";
import type { PoolConnection as PromisePoolConnection } from "mysql2/promise";

const strictSession =
  "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO', time_zone='+00:00'";

export function createDatabase(options: PoolOptions) {
  const pool = createPool({
    ...options,
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    dateStrings: true,
    timezone: "Z",
    connectionLimit: options.connectionLimit ?? 5,
    waitForConnections: true,
    queueLimit: 64,
    resetOnRelease: false,
    connectTimeout: 750,
  });
  const initialized = new WeakSet<PoolConnection>();
  const acquire = pool.getConnection.bind(pool);
  // mysql2 does not await its connection event before handing out the connection.
  pool.getConnection = (callback) =>
    acquire((error, connection) => {
      if (error || initialized.has(connection))
        return callback(error, connection);
      connection.query({ sql: strictSession, timeout: 750 }, (error) => {
        if (error) {
          connection.destroy();
          return callback(error, connection);
        }
        initialized.add(connection);
        callback(null, connection);
      });
    });
  return {
    pool,
    schema: options.database,
    db: new Kysely<unknown>({ dialect: new MysqlDialect({ pool }) }),
  };
}

export async function checkDatabase(pool: Pool | undefined) {
  if (!pool) return "not_configured";

  return new Promise<"ok" | "unavailable">((finish) => {
    let connection: PromisePoolConnection | undefined;
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      connection?.destroy();
      finish("unavailable");
    }, 1500);
    pool
      .promise()
      .getConnection()
      .then(async (acquired) => {
        if (expired) {
          acquired.release();
          return;
        }
        connection = acquired;
        await acquired.query({ sql: "SELECT 1", timeout: 750 });
        if (!expired) {
          acquired.release();
          finish("ok");
        }
      })
      .catch(() => {
        if (!expired) connection?.destroy();
        finish("unavailable");
      })
      .finally(() => clearTimeout(deadline));
  });
}
