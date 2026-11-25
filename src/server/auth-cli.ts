import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { sql } from "kysely";
import { Secret } from "otpauth";
import { authenticator, replaceUser } from "./auth-credentials.js";
import {
  authEvent,
  authTransaction,
  revokeAll,
  revokeFamily,
  type AuthDb,
} from "./auth-store.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";

class UsageError extends Error {}

async function askPassword() {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new UsageError("Ejecuta auth:setup en una terminal interactiva.");
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const prompt = createInterface({
    input: stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  const controller = new AbortController();
  prompt.on("SIGINT", () => controller.abort());
  const ask = async (label: string) => {
    stdout.write(label);
    try {
      return await prompt.question("", { signal: controller.signal });
    } finally {
      stdout.write("\n");
    }
  };
  try {
    const password = await ask(
      "Contraseña nueva (si reemplazas el usuario se revocarán sus tokens): ",
    );
    if (password !== (await ask("Repite la contraseña: ")))
      throw new UsageError("Las contraseñas no coinciden.");
    if (password.length < 12 || Buffer.byteLength(password) > 1024)
      throw new UsageError(
        "La contraseña debe tener al menos 12 caracteres y como máximo 1024 bytes.",
      );
    return password;
  } finally {
    prompt.close();
  }
}

async function manageTokens(db: AuthDb, command: string, id?: string) {
  if (command === "list") {
    const { rows } = await sql<{
      id: string;
      client_id: string;
      token_type: string;
      expires_at: string;
    }>`
      SELECT id, client_id, token_type, expires_at FROM oauth_tokens
      WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) ORDER BY id
    `.execute(db);
    console.table(rows);
    return;
  }
  await authTransaction(db, async (trx) => {
    if (command === "revoke-all") return revokeAll(trx);
    const {
      rows: [row],
    } = await sql<{ family_id: Buffer; client_id: string }>`
      SELECT family_id, client_id FROM oauth_tokens WHERE id = CAST(${id} AS UNSIGNED)
    `.execute(trx);
    if (!row) throw new UsageError("No existe un token con ese identificador.");
    await revokeFamily(trx, row.family_id);
    await authEvent(trx, "revoke", "success", row.client_id);
  });
  console.log("Revocación completada.");
}

async function main([mode, command, id, ...rest]: string[]) {
  const setup = mode === "setup" && command === undefined;
  const unlock = mode === "unlock" && command === undefined;
  const tokens =
    mode === "tokens" &&
    (((command === "list" || command === "revoke-all") && id === undefined) ||
      (command === "revoke" &&
        !!id &&
        /^[1-9][0-9]{0,19}$/.test(id) &&
        BigInt(id) <= 18_446_744_073_709_551_615n &&
        rest.length === 0));
  if (!setup && !unlock && !tokens)
    throw new UsageError(
      "Usa npm run auth:setup, npm run auth:unlock o npm run auth:tokens -- list|revoke <id>|revoke-all.",
    );
  const config = readConfig(process.env);
  if (!config.database?.database)
    throw new UsageError(
      "Configura DATABASE_URL con la base de la aplicación.",
    );
  const { db } = createDatabase(config.database);
  try {
    if (tokens && command) return await manageTokens(db, command, id);
    if (unlock) {
      await authTransaction(db, async (trx) => {
        await sql`DELETE FROM auth_attempts WHERE created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)`.execute(
          trx,
        );
        await authEvent(trx, "unlock", "success");
      });
      console.log("Bloqueo de inicio de sesión eliminado.");
      return;
    }
    if (!config.auth.encryptionKey)
      throw new UsageError(
        "Configura TOTP_ENCRYPTION_KEY antes de crear el usuario.",
      );
    const password = await askPassword();
    const secret = new Secret({ size: 20 });
    await replaceUser(db, config.auth.encryptionKey, password, secret);
    stdout.write(
      `Usuario configurado. Añade esta cuenta a tu aplicación de autenticación.\nSecreto base32: ${secret.base32}\nURI: ${authenticator(secret).toString()}\n`,
    );
  } finally {
    await db.destroy();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof UsageError
      ? error.message
      : "La operación de autenticación falló. Comprueba la configuración y la migración.",
  );
  process.exitCode = 1;
}
