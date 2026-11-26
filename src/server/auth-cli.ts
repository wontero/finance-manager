import { rowId } from "@finance-manager/core";
import { sql } from "kysely";
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

async function manageTokens(
  db: AuthDb,
  command: string,
  userId: string,
  id?: string,
) {
  if (command === "list") {
    const { rows } = await sql`
      SELECT id, client_id, token_type, expires_at FROM oauth_tokens
      WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) ORDER BY id
    `.execute(db);
    console.table(rows);
    return;
  }
  await authTransaction(db, async (trx) => {
    if (command === "revoke-all") {
      const { rows } =
        await sql`SELECT id FROM users WHERE id = ${userId}`.execute(trx);
      if (!rows.length) throw new UsageError("No existe ese usuario.");
      return revokeAll(trx, userId);
    }
    const {
      rows: [row],
    } = await sql<{ family_id: Buffer; client_id: string }>`
      SELECT family_id, client_id FROM oauth_tokens WHERE user_id = ${userId} AND id = CAST(${id} AS UNSIGNED)
    `.execute(trx);
    if (!row)
      throw new UsageError("No existe ese token para el usuario indicado.");
    await revokeFamily(trx, row.family_id, userId);
    await authEvent(trx, "revoke", "success", row.client_id, userId);
  });
  console.log("Revocación completada.");
}

async function main([command, userId, id, ...rest]: string[]) {
  if (
    !rowId.safeParse(userId).success ||
    rest.length ||
    !(
      ((command === "list" || command === "revoke-all") && id === undefined) ||
      (command === "revoke" && rowId.safeParse(id).success)
    )
  )
    throw new UsageError(
      "Usa auth:tokens -- list <usuario> | revoke <usuario> <token> | revoke-all <usuario>.",
    );
  const config = readConfig(process.env);
  if (!config.database?.database)
    throw new UsageError(
      "Configura DATABASE_URL con la base de la aplicación.",
    );
  const { db } = createDatabase(config.database);
  try {
    await manageTokens(db, command, userId, id);
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
