import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { readMigrationConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createReadonlyViews } from "./readonly-views.js";

async function migrate() {
  const config = readMigrationConfig(process.env);
  const { db } = createDatabase(config.connection);
  try {
    const server =
      path.basename(import.meta.dirname) === "dist"
        ? path.dirname(import.meta.dirname)
        : import.meta.dirname;
    const preflight = await fs.readFile(
      path.join(server, "../deploy/trigger-preflight.sql"),
      "utf8",
    );
    const {
      rows: [status],
    } = await db.executeQuery(
      sql
        .raw<{
          log_bin: unknown;
          trust: unknown;
          can_trigger: unknown;
          has_super: unknown;
          foreign_definers: unknown;
        }>(preflight)
        .compile(db),
    );
    const flags = [
      status?.log_bin,
      status?.trust,
      status?.can_trigger,
      status?.has_super,
      status?.foreign_definers,
    ];
    if (
      !flags.every(
        (value) => value === 0 || value === 1 || value === "0" || value === "1",
      )
    )
      throw new Error(
        "No se pudieron comprobar los permisos de triggers de MariaDB.",
      );
    const [binlog, trust, canTrigger, hasSuper, foreignDefiners] =
      flags.map(Number);
    if (binlog === 1 && trust === 0 && hasSuper === 0)
      throw new Error(
        "Pide al administrador que habilite log_bin_trust_function_creators para crear triggers con el binlog activo.",
      );
    if (canTrigger === 0)
      throw new Error(
        "Pide al administrador el privilegio TRIGGER sobre la base principal para el usuario de migración.",
      );
    if (foreignDefiners === 1)
      throw new Error(
        "Pide al administrador que compruebe que las vistas y los triggers de la base principal pertenezcan al usuario de migración.",
      );
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(import.meta.dirname, "migrations"),
        import: (file) => import(pathToFileURL(file).href),
      }),
    });
    const { results, error } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      if (result.status === "Success")
        console.log(`Migración aplicada: ${result.migrationName}`);
      if (result.status === "Error")
        console.error(`Falló la migración: ${result.migrationName}`);
    }
    if (error) throw error;
    if (!results?.length) console.log("Sin migraciones pendientes.");
    await createReadonlyViews(db, config.mainDatabase, config.readonlyDatabase);
    console.log(
      `Vistas de solo lectura disponibles en ${config.readonlyDatabase}.`,
    );
  } finally {
    await db.destroy();
  }
}

try {
  await migrate();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo migrar Finance Manager. ${detail}`);
  process.exitCode = 1;
}
