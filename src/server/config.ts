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

const redirectSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value) || /[\s*#]/.test(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  }, "OAUTH_ALLOWED_REDIRECT_URIS debe incluir solo URLs HTTPS exactas");

const googleValue = (name: string) =>
  z
    .string()
    .trim()
    .regex(
      /^\S{1,512}$/,
      `${name} debe tener entre 1 y 512 caracteres sin espacios`,
    )
    .optional();

const nonnegativeInteger = (name: string) => {
  const error = `${name} debe ser un entero no negativo`;
  return z
    .string()
    .regex(/^\d+$/, error)
    .transform(Number)
    .pipe(z.number().int(error).nonnegative(error));
};

const configSchema = z.object({
  NODE_ENV: z.string().optional(),
  PUBLIC_URL: z
    .string()
    .max(2000)
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      const loopback =
        url.hostname === "localhost" || url.hostname === "127.0.0.1";
      return (
        (url.protocol === "https:" || (loopback && url.protocol === "http:")) &&
        url.href === `${url.origin}/`
      );
    }, "PUBLIC_URL debe indicar un origen HTTPS o HTTP en localhost")
    .optional(),
  OAUTH_ALLOWED_REDIRECT_URIS: z
    .string()
    .transform((value) => value.split(",").map((uri) => uri.trim()))
    .pipe(z.array(redirectSchema).min(1))
    .default([
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
    ]),
  GOOGLE_CLIENT_ID: googleValue("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: googleValue("GOOGLE_CLIENT_SECRET"),
  FIRST_USER_EMAIL: z
    .string()
    .trim()
    .pipe(z.email("FIRST_USER_EMAIL debe ser un correo válido").max(320))
    .optional(),
  GOOGLE_AUTHORIZATION_URL: z
    .string()
    .default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_TOKEN_URL: z.string().default("https://oauth2.googleapis.com/token"),
  GOOGLE_ISSUER: z
    .string()
    .min(1, "GOOGLE_ISSUER debe ser una URL HTTPS válida")
    .optional(),
  MAX_USERS: nonnegativeInteger("MAX_USERS").default(50),
  MAX_REQUESTS_PER_USER_PER_MINUTE: nonnegativeInteger(
    "MAX_REQUESTS_PER_USER_PER_MINUTE",
  )
    .refine(
      (value) => value > 0 && value < 2 ** 32 - 1,
      "MAX_REQUESTS_PER_USER_PER_MINUTE debe ser un entero positivo menor que 4294967295",
    )
    .default(120),
  TRUST_PROXY: z
    .enum(["passenger", "loopback", "off"], {
      error: "TRUST_PROXY debe ser passenger, loopback u off",
    })
    .default("off"),
  PORT: z
    .string()
    .regex(/^\d+$/, portError)
    .transform(Number)
    .pipe(z.number().int(portError).min(1, portError).max(65535, portError))
    .default(3000),
  DATABASE_URL: databaseUrl("DATABASE_URL").optional(),
  READONLY_DATABASE_URL: databaseUrl("READONLY_DATABASE_URL").optional(),
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
  const {
    DATABASE_URL: database,
    READONLY_DATABASE_URL: readonly,
    DATABASE_SOCKET: socketPath,
  } = config;
  if (
    readonly &&
    (!readonly.credentials.user ||
      !readonly.credentials.database ||
      readonly.credentials.user === database?.credentials.user ||
      readonly.credentials.database.toLowerCase() ===
        database?.credentials.database?.toLowerCase())
  )
    throw new Error(
      "READONLY_DATABASE_URL requiere un usuario lector y una base distintos de los principales.",
    );
  const issuer = new URL(
    config.PUBLIC_URL ?? `http://localhost:${config.PORT}`,
  );
  if (
    config.NODE_ENV === "production" &&
    database &&
    (!config.PUBLIC_URL || issuer.protocol !== "https:")
  ) {
    throw new Error(
      "Configura PUBLIC_URL con HTTPS para activar la autenticación en producción.",
    );
  }
  const providerUrl = (name: string, value: string) => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    const localTest =
      config.NODE_ENV === "test" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname ?? "") &&
      url?.protocol === "http:";
    if (
      !url ||
      (!localTest && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(`${name} debe ser una URL HTTPS válida.`);
    return url;
  };
  const authorizationUrl = providerUrl(
    "GOOGLE_AUTHORIZATION_URL",
    config.GOOGLE_AUTHORIZATION_URL,
  );
  const tokenUrl = providerUrl("GOOGLE_TOKEN_URL", config.GOOGLE_TOKEN_URL);
  const googleIssuer = config.GOOGLE_ISSUER;
  if (googleIssuer) providerUrl("GOOGLE_ISSUER", googleIssuer);
  let google;
  if (
    database ||
    config.GOOGLE_CLIENT_ID ||
    config.GOOGLE_CLIENT_SECRET ||
    config.FIRST_USER_EMAIL
  ) {
    const {
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: clientSecret,
      FIRST_USER_EMAIL: firstUserEmail,
    } = config;
    if (!clientId || !clientSecret || !firstUserEmail)
      throw new Error(
        "Configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y FIRST_USER_EMAIL.",
      );
    google = {
      clientId,
      clientSecret,
      firstUserEmail: firstUserEmail.toLowerCase(),
      authorizationUrl,
      tokenUrl,
      issuers: googleIssuer
        ? [googleIssuer]
        : ["https://accounts.google.com", "accounts.google.com"],
      callback: new URL("/auth/google/callback", issuer),
      maxUsers: config.MAX_USERS,
    };
  }
  return {
    port: config.PORT,
    database: database && connectionOptions(database, socketPath),
    readonlyDatabase: readonly && connectionOptions(readonly, socketPath),
    webDistDir: resolve(config.WEB_DIST_DIR),
    version: config.APP_VERSION,
    auth: {
      issuer,
      resource: new URL("/mcp", issuer),
      redirects: config.OAUTH_ALLOWED_REDIRECT_URIS,
      google,
      requestsPerMinute: config.MAX_REQUESTS_PER_USER_PER_MINUTE,
      secureCookies:
        config.NODE_ENV === "production" || issuer.protocol === "https:",
      trustProxy: config.TRUST_PROXY === "off" ? false : config.TRUST_PROXY,
    },
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
