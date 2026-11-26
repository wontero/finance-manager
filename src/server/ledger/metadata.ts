import { accountingDate, parseRate } from "@finance-manager/core";
import { sql, type Kysely } from "kysely";
import type { LedgerWrite } from "./audit.js";
import type { ExchangeRate, LedgerDatabase } from "./schema.js";

export async function validateCustom(
  db: Kysely<LedgerDatabase>,
  entity: "account" | "transaction",
  custom: Record<string, string | number> | null | undefined,
) {
  if (custom == null) return null;
  const definitions = await db
    .selectFrom("custom_field_definitions")
    .select(["key", "type", "options"])
    .where("entity", "=", entity)
    .where("archived_at", "is", null)
    .execute();
  const active = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  for (const [key, value] of Object.entries(custom)) {
    const field = active.get(key);
    if (!field)
      throw new Error(
        `El campo personalizado "${key}" no existe o está archivado.`,
      );
    const valid =
      field.type === "number"
        ? typeof value === "number"
        : typeof value === "string" &&
          (field.type === "text" ||
            (field.type === "date" &&
              accountingDate.safeParse(value).success) ||
            (field.type === "option" &&
              (JSON.parse(field.options ?? "[]") as string[]).includes(value)));
    if (!valid)
      throw new Error(`Valor inválido para el campo personalizado "${key}".`);
  }
  return JSON.stringify(custom);
}

export async function setTags(
  write: LedgerWrite,
  transactionId: string,
  names: string[],
) {
  const current = await write.db
    .selectFrom("transaction_tags")
    .select("tag_id")
    .where("transaction_id", "=", transactionId)
    .execute();
  const old = new Set(current.map(({ tag_id }) => tag_id));
  const next = new Set<string>();
  for (const name of names) {
    const tag = await write.db
      .selectFrom("tags")
      .select("id")
      .where("name", "=", name)
      .executeTakeFirst();
    const { id } = tag ?? (await write.insert("tags", { name }));
    next.add(id);
    if (!old.has(id)) {
      await write.insert("transaction_tags", {
        transaction_id: transactionId,
        tag_id: id,
      });
      old.add(id);
    }
  }
  for (const id of old)
    if (!next.has(id))
      await write.delete("transaction_tags", {
        transaction_id: transactionId,
        tag_id: id,
      });
}

function findUserRate(
  db: Kysely<LedgerDatabase>,
  from: string,
  to: string,
  date: string,
) {
  return db
    .selectFrom("exchange_rates")
    .select(["from_currency", "to_currency", "date", "source", "rate"])
    .where("from_currency", "=", from)
    .where("to_currency", "=", to)
    .where("date", "<=", date)
    .orderBy("date", "desc")
    .orderBy(sql`BINARY source = 'BCB referencial venta'`, "desc")
    .orderBy("source")
    .executeTakeFirst();
}

async function findOfficialRate(
  db: Kysely<LedgerDatabase>,
  from: string,
  to: string,
  date: string,
): Promise<ExchangeRate | undefined> {
  const {
    rows: [rate],
  } =
    await sql<ExchangeRate>`SELECT from_currency, to_currency, date, source, rate
    FROM exchange_rates WHERE user_id IS NULL
      AND from_currency = ${from} AND to_currency = ${to} AND date <= ${date}
    ORDER BY date DESC LIMIT 1`.execute(db);
  return rate;
}

export async function findExchangeRate(
  db: Kysely<LedgerDatabase>,
  from: string,
  to: string,
  date: string,
) {
  const own = await findUserRate(db, from, to, date);
  if (own?.date === date) return own;
  const official = await findOfficialRate(db, from, to, date);
  return official && (!own || official.date > own.date) ? official : own;
}

async function validateRate(
  db: Kysely<LedgerDatabase>,
  from: string,
  to: string,
  rate: string,
) {
  parseRate(rate);
  if (from === to)
    throw new Error("El tipo de cambio requiere dos monedas distintas.");
  const currencies = await db
    .selectFrom("currencies")
    .select("code")
    .where("code", "in", [from, to])
    .execute();
  if (currencies.length !== 2)
    throw new Error("Una moneda del tipo de cambio no existe.");
}

export async function saveOfficialRate(
  write: LedgerWrite,
  from: string,
  to: string,
  date: string,
  source: string,
  rate: string,
) {
  // Distintos usuarios comparten el mismo tipo oficial y su alta es única.
  await write.db
    .selectFrom("currencies")
    .select("code")
    .where("code", "=", from)
    .forUpdate()
    .executeTakeFirst();
  await validateRate(write.db, from, to, rate);
  const existing = await findOfficialRate(write.db, from, to, date);
  if (existing?.date === date) return { rate: existing, operationId: null };
  await sql`INSERT INTO exchange_rates (user_id, from_currency, to_currency, date, source, rate)
    VALUES (NULL, ${from}, ${to}, ${date}, ${source}, ${rate})`.execute(
    write.db,
  );
  const saved = await findOfficialRate(write.db, from, to, date);
  if (!saved)
    throw new Error(
      "No se encontró el tipo de cambio oficial recién registrado.",
    );
  return { rate: saved, operationId: await write.recordOfficialRate(saved) };
}

export async function saveExchangeRate(
  write: LedgerWrite,
  from: string,
  to: string,
  date: string,
  source: string,
  rate: string,
  ifAbsent?: true,
) {
  await validateRate(write.db, from, to, rate);
  if (ifAbsent) {
    const existing = await findUserRate(write.db, from, to, date);
    if (existing?.date === date) return { rate: existing, operationId: null };
  }
  const previous = await write.db
    .selectFrom("exchange_rates")
    .select("source")
    .where("from_currency", "=", from)
    .where("to_currency", "=", to)
    .where("date", "=", date)
    .where("source", "=", source)
    .executeTakeFirst();
  const key = {
    from_currency: from,
    to_currency: to,
    date,
    source: previous?.source ?? source,
  };
  const {
    from_currency,
    to_currency,
    date: savedDate,
    source: savedSource,
    rate: savedRate,
  } = previous
    ? await write.update("exchange_rates", key, { rate })
    : await write.insert("exchange_rates", { ...key, rate });
  return {
    rate: {
      from_currency,
      to_currency,
      date: savedDate,
      source: savedSource,
      rate: savedRate,
    },
    operationId: await write.operation(),
  };
}
