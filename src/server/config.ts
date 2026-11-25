import { readFileSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { z } from "zod";

const serverDir =
  basename(import.meta.dirname) === "dist"
    ? join(import.meta.dirname, "..")
    : import.meta.dirname;
const defaultVersion: string = JSON.parse(
  readFileSync(join(serverDir, "package.json"), "utf8"),
).version;
const portError = "PORT debe ser un entero entre 1 y 65535";
function databaseUrl(name: string) {
  const error = `${name} debe ser una URL mysql:// válida, con host y sin parámetros ni fragmento`;
  return z.string().transform((value, ctx) => {
    try {
      const url = new URL(value);
      const port = url.port ? Number(url.port) : 3306;
      if (
        !value.startsWith("mysql://") ||
        !url.hostname ||
        url.search ||
        url.hash ||
        !port
      ) {
        throw new Error(error);
      }
      return {
        tcp: { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port },
        credentials: {
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: decodeURIComponent(url.pathname.slice(1)) || undefined,
        },
      };
    } catch {
      ctx.addIssue({ code: "custom", message: error });
      return z.NEVER;
    }
  });
}

const socketSchema = z
  .string()
  .refine(
    (value) => posix.isAbsolute(value) && !value.includes("\0"),
    "DATABASE_SOCKET debe indicar una ruta absoluta de socket Unix",
  )
  .optional();

const configSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, portError)
    .transform(Number)
    .pipe(z.number().int(portError).min(1, portError).max(65535, portError))
    .default(3000),
  DATABASE_URL: databaseUrl("DATABASE_URL").optional(),
  DATABASE_SOCKET: socketSchema,
  WEB_DIST_DIR: z
    .string()
    .trim()
    .min(1, "WEB_DIST_DIR debe indicar un directorio")
    .default(join(serverDir, "../web/dist")),
  APP_VERSION: z
    .string()
    .trim()
    .min(1, "APP_VERSION debe indicar una versión")
    .default(defaultVersion),
});

function parseConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join(". "),
    );
  }

  return parsed.data;
}

function connectionOptions(
  database: z.infer<ReturnType<typeof databaseUrl>>,
  socketPath?: string,
) {
  return {
    ...(socketPath ? { socketPath } : database.tcp),
    ...database.credentials,
  };
}

export function readConfig(env: NodeJS.ProcessEnv) {
  const config = parseConfig(configSchema, env);
  const { DATABASE_URL: database, DATABASE_SOCKET: socketPath } = config;
  return {
    port: config.PORT,
    database: database && connectionOptions(database, socketPath),
    webDistDir: resolve(config.WEB_DIST_DIR),
    version: config.APP_VERSION,
  };
}

const migrationSchema = z.object({
  MIGRATION_DATABASE_URL: databaseUrl("MIGRATION_DATABASE_URL").optional(),
  DATABASE_SOCKET: socketSchema,
  READONLY_DATABASE_NAME: z
    .string()
    .regex(
      /^[a-zA-Z0-9_]{1,64}$/,
      "READONLY_DATABASE_NAME debe tener de 1 a 64 letras ASCII, números o guiones bajos",
    )
    .optional(),
});

export function readMigrationConfig(env: NodeJS.ProcessEnv) {
  const {
    MIGRATION_DATABASE_URL: url,
    DATABASE_SOCKET: socketPath,
    READONLY_DATABASE_NAME: readonlyDatabase,
  } = parseConfig(migrationSchema, env);
  if (!url?.credentials.user || !url.credentials.database)
    throw new Error(
      "MIGRATION_DATABASE_URL debe incluir usuario y base principal.",
    );
  if (!readonlyDatabase)
    throw new Error(
      "Configura READONLY_DATABASE_NAME con el nombre de la base de solo lectura.",
    );
  if (url.credentials.database.toLowerCase() === readonlyDatabase.toLowerCase())
    throw new Error(
      "La base principal y READONLY_DATABASE_NAME deben ser distintas.",
    );
  return {
    connection: connectionOptions(url, socketPath),
    mainDatabase: url.credentials.database,
    readonlyDatabase,
  };
}
