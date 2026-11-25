import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { readMigrationConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createReadonlyViews } from "./readonly-views.js";

async function migrate() {
  const config = readMigrationConfig(process.env);
  const { db } = createDatabase(config.connection);
  try {
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
