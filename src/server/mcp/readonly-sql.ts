import type { Duplex } from "node:stream";
import type { FieldPacket, Pool, PoolConnection } from "mysql2";
import { z } from "zod";
import { readonlyViewDescription } from "../readonly-views.js";
import { registerTool, type ToolServer } from "./tool.js";

const rowLimit = 500;
// Se reserva espacio para el resumen y la envoltura JSON-RPC.
const byteLimit = 64 * 1024 - 1024;
const output = z.object({
  filas: z.array(z.record(z.string(), z.json())),
  recortado: z.boolean(),
  aviso: z.string().nullable(),
});

function singleSelect(input: string) {
  const tokens =
    /\/\*[\s\S]*?\*\/|(?:--(?=\s|$)|#)[^\r\n]*|'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|\x60(?:\x60\x60|[^\x60])*\x60|;/g;
  let end = 0;
  let statement = "";
  let terminated = false;
  for (const match of input.matchAll(tokens)) {
    const preceding = input.slice(end, match.index);
    const token = match[0];
    end = match.index + token.length;
    const comment = /^(?:\/\*|--|#)/.test(token);
    if (/^\/\*(?:!|M!|\+)/i.test(token))
      throw new Error("La consulta no admite comentarios ejecutables.");
    if (terminated && (preceding.trim() || !comment))
      throw new Error("Envía una sola sentencia de solo lectura.");
    statement += preceding;
    if (token === ";") terminated = true;
    else statement += comment ? " " : token;
  }
  const tail = input.slice(end).trim();
  if (terminated && tail)
    throw new Error("Envía una sola sentencia de solo lectura.");
  statement = (statement + tail).trim();
  if (!/^(SELECT|WITH)\b/i.test(statement))
    throw new Error(
      "La consulta de solo lectura debe empezar con SELECT o WITH.",
    );
  return statement;
}

function connectionFrom(pool: Pool) {
  return new Promise<PoolConnection>((resolve, reject) => {
    pool.getConnection((error, connection) =>
      error ? reject(error) : resolve(connection),
    );
  });
}

async function select(
  pool: Pool,
  statement: string,
): Promise<z.output<typeof output>> {
  const conn = await connectionFrom(pool);
  try {
    await conn.promise().query("START TRANSACTION READ ONLY");
    const query = conn.query({
      sql: "SET STATEMENT max_statement_time=5 FOR " + statement,
      rowsAsArray: true,
      timeout: 7500,
    });
    const stream = query.stream({ highWaterMark: 1 });
    // mysql2 quita su listener al cerrar el stream, pero el temporizador aún puede emitir.
    query.on("error", (error: Error) => stream.destroy(error));
    let columns: string[] = [];
    stream.on("fields", (fields: FieldPacket[]) => {
      columns = fields.map(({ name }) => name);
    });
    const filas: z.output<typeof output>["filas"] = [];
    let bytes = 2;
    let aviso: string | null = null;
    for await (const values of stream as AsyncIterable<
      z.output<ReturnType<typeof z.json>>[]
    >) {
      if (filas.length === rowLimit) {
        aviso = "Se muestran como máximo 500 filas.";
        break;
      }
      const row = Object.fromEntries(
        columns.map((name, index) => [
          name,
          Buffer.isBuffer(values[index])
            ? values[index].toString("base64")
            : values[index],
        ]),
      );
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > byteLimit) {
        aviso = "La respuesta se recortó al límite de 64 KB.";
        break;
      }
      filas.push(row);
    }
    if (!aviso) await conn.promise().rollback();
    return { filas, recortado: aviso !== null, aviso };
  } finally {
    // destroy() retira la conexión del pool, pero mysql2 solo hace end() al socket.
    conn.destroy();
    (conn as PoolConnection & { stream: Duplex }).stream.destroy();
  }
}

export function registerSql(server: ToolServer, pool: Pool | undefined) {
  registerTool(
    server,
    "consulta_sql",
    "Consulta datos financieros con SQL de solo lectura. Vistas: " +
      readonlyViewDescription,
    z.object({
      sql: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1024),
    }),
    output,
    "read",
    async ({ sql }) => {
      if (!pool)
        throw new Error("La consulta SQL de solo lectura no está disponible.");
      const statement = singleSelect(sql);
      try {
        const data = await select(pool, statement);
        return [
          data,
          data.aviso ?? "Filas devueltas: " + data.filas.length + ".",
        ];
      } catch (error) {
        const errno =
          error && typeof error === "object" && "errno" in error
            ? error.errno
            : undefined;
        if (errno === 1969)
          throw new Error("La consulta superó el límite de 5 segundos.");
        if (
          [1044, 1045, 1142, 1146, 1227, 1290, 1792].some(
            (code) => code === errno,
          )
        )
          throw new Error(
            "La consulta requiere permisos de solo lectura sobre las vistas autorizadas.",
          );
        if (errno === 1064)
          throw new Error("La sentencia SQL tiene una sintaxis inválida.");
        throw new Error("No se pudo ejecutar la consulta de solo lectura.");
      }
    },
  );
}
