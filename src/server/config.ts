import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

const serverDir =
  basename(import.meta.dirname) === "dist"
    ? join(import.meta.dirname, "..")
    : import.meta.dirname;
const defaultVersion: string = JSON.parse(
  readFileSync(join(serverDir, "package.json"), "utf8"),
).version;
const portError = "PORT debe ser un entero entre 1 y 65535";
const dbError =
  "DATABASE_URL debe ser una URL mysql:// válida, con host y sin parámetros ni fragmento";

const configSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, portError)
    .transform(Number)
    .pipe(z.number().int(portError).min(1, portError).max(65535, portError))
    .default(3000),
  DATABASE_URL: z
    .string()
    .transform((value, ctx) => {
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
          throw new Error(dbError);
        }
        return {
          host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
          port,
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: decodeURIComponent(url.pathname.slice(1)) || undefined,
        };
      } catch {
        ctx.addIssue({ code: "custom", message: dbError });
        return z.NEVER;
      }
    })
    .optional(),
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

export function readConfig(env: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join(". "),
    );
  }

  return {
    port: parsed.data.PORT,
    database: parsed.data.DATABASE_URL,
    webDistDir: resolve(parsed.data.WEB_DIST_DIR),
    version: parsed.data.APP_VERSION,
  };
}
