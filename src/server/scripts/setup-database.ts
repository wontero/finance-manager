import { createConnection } from "mysql2/promise";
import { checkLocalDataDir, localDatabase } from "./local-database.js";

const mainDatabases = ["finance_dev", "finance_test"];
const readonlyDatabases = ["finance_dev_ro", "finance_test_ro"];
const roles = [
  {
    env: "DATABASE_URL",
    user: "finance_dev",
    databases: mainDatabases,
    privileges: "SELECT, INSERT, UPDATE, DELETE",
  },
  {
    env: "MIGRATION_DATABASE_URL",
    user: "finance_migration",
    databases: [...mainDatabases, ...readonlyDatabases],
    privileges: "ALL PRIVILEGES",
  },
  {
    env: "READONLY_DATABASE_URL",
    user: "finance_readonly",
    databases: readonlyDatabases,
    privileges: "SELECT",
  },
];

async function setup() {
  const admin = localDatabase("MARIADB_ADMIN_URL");
  const users = roles.map((role) => {
    const options = localDatabase(role.env);
    if (
      options.user !== role.user ||
      options.port !== admin.port ||
      !options.database ||
      !role.databases.includes(options.database) ||
      !options.password
    ) {
      throw new Error(
        `Revisa el usuario, contraseña, puerto y base de ${role.env} en .env.`,
      );
    }
    return { ...role, password: options.password };
  });
  if (admin.database || admin.user !== "root" || !admin.password)
    throw new Error(
      "MARIADB_ADMIN_URL debe identificar al root local y omitir la base.",
    );

  const db = await createConnection(admin);
  try {
    await checkLocalDataDir(db, admin.port);
    await db.query(
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'",
    );
    for (const database of [...mainDatabases, ...readonlyDatabases]) {
      await db.query(
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    }
    for (const { user, password, databases, privileges } of users) {
      const account = `'${user}'@'127.0.0.1'`;
      await db.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [
        password,
      ]);
      await db.query(`ALTER USER ${account} IDENTIFIED BY ?`, [password]);
      // Replaces the former full-access grant for finance_dev on existing local installs.
      await db.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`);
      for (const database of databases) {
        const exactDatabase = database.replaceAll("_", "\\_");
        await db.query(
          `GRANT ${privileges} ON \`${exactDatabase}\`.* TO ${account}`,
        );
      }
    }
    console.log("Bases y permisos de MariaDB local configurados.");
  } finally {
    await db.end();
  }
}

try {
  await setup();
} catch (error) {
  const detail =
    error instanceof Error && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : "Fallo desconocido.";
  console.error(`No se pudo preparar MariaDB local. ${detail}`);
  process.exitCode = 1;
}
