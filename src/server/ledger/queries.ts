import { convert } from "@finance-manager/core";
import { sql, type Kysely } from "kysely";
import { findExchangeRate } from "./metadata.js";
import type { AccountKind, LedgerDatabase } from "./schema.js";

export function naturalAmount(kind: AccountKind, amount: bigint) {
  return kind === "asset" || kind === "expense" ? amount : -amount;
}

export function currentPostings(db: Kysely<LedgerDatabase>) {
  return db
    .selectFrom("postings as p")
    .innerJoin("transactions as t", "t.id", "p.transaction_id")
    .where("t.deleted_at", "is", null);
}

export function archivedAccountWithBalance(db: Kysely<LedgerDatabase>) {
  return currentPostings(db)
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .select("a.name")
    .where("a.kind", "in", ["asset", "liability"])
    .where("a.archived_at", "is not", null)
    .groupBy(["a.id", "a.name"])
    .having(sql<string>`SUM(p.amount)`, "!=", "0")
    .limit(1)
    .executeTakeFirst();
}

export async function getAccountTotal(
  db: Kysely<LedgerDatabase>,
  id: string,
  date?: string,
) {
  let query = currentPostings(db)
    .select(sql<string | null>`SUM(p.amount)`.as("amount"))
    .where("p.account_id", "=", id);
  if (date !== undefined) query = query.where("t.date", "<=", date);
  const { amount } = await query.executeTakeFirstOrThrow();
  return BigInt(amount ?? 0);
}

export async function getCurrencyScales(db: Kysely<LedgerDatabase>) {
  const rows = await db
    .selectFrom("currencies")
    .select(["code", "minor_unit"])
    .execute();
  return new Map(rows.map(({ code, minor_unit }) => [code, minor_unit]));
}

export function amountConverter(
  db: Kysely<LedgerDatabase>,
  destination: string,
  date: string,
  scales: ReadonlyMap<string, number>,
) {
  const scale = scales.get(destination);
  if (scale === undefined)
    throw new Error(`No existe la moneda ${destination}.`);
  const rates = new Map<string, Promise<string | undefined>>();
  return async <T extends { currency: string; amount: bigint }>(
    rows: readonly T[],
  ) => {
    let amount = 0n;
    const unvalued: T[] = [];
    for (const row of rows) {
      if (row.amount === 0n) continue;
      if (row.currency === destination) {
        amount += row.amount;
        continue;
      }
      let lookup = rates.get(row.currency);
      if (!lookup) {
        lookup = findExchangeRate(db, row.currency, destination, date).then(
          (rate) => rate?.rate,
        );
        rates.set(row.currency, lookup);
      }
      const rate = await lookup;
      if (rate)
        amount += convert(row.amount, rate, scales.get(row.currency)!, scale);
      else unvalued.push(row);
    }
    return { amount, unvalued };
  };
}

export async function getNetWorth(db: Kysely<LedgerDatabase>, date: string) {
  const balances = await currentPostings(db)
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .innerJoin("currencies as c", "c.code", "a.currency")
    .select([
      "a.id",
      "a.name",
      "a.kind",
      "c.code as currency",
      sql<string>`SUM(p.amount)`.as("amount"),
    ])
    .where("a.kind", "in", ["asset", "liability"])
    .where("t.date", "<=", date)
    .groupBy(["a.id", "a.name", "a.kind", "c.code"])
    .having(sql<string>`SUM(p.amount)`, "!=", "0")
    .orderBy("a.id")
    .execute();
  const currency = "BOB" as const;
  const sum = amountConverter(db, currency, date, await getCurrencyScales(db));
  const { amount, unvalued } = await sum(
    balances.map((balance) => ({ ...balance, amount: BigInt(balance.amount) })),
  );
  return {
    amount,
    currency,
    unvalued: unvalued.map((balance) => ({
      ...balance,
      amount: naturalAmount(balance.kind, balance.amount),
    })),
  };
}

export function descendants(
  accounts: { id: string; parent_id: string | null }[],
  root: string,
) {
  const children = new Map<string, string[]>();
  for (const { id, parent_id } of accounts) {
    if (parent_id === null) continue;
    const siblings = children.get(parent_id) ?? [];
    siblings.push(id);
    children.set(parent_id, siblings);
  }
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) throw new Error("El árbol de cuentas contiene un ciclo.");
    seen.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return [...seen];
}

export async function getCategoryTotals(
  db: Kysely<LedgerDatabase>,
  id: string,
  from: string,
  to: string,
) {
  const accounts = await db
    .selectFrom("accounts")
    .select(["id", "parent_id", "kind"])
    .execute();
  const category = accounts.find((account) => account.id === id);
  if (category?.kind !== "income" && category?.kind !== "expense")
    throw new Error("Se requiere una categoría de ingresos o gastos.");
  const totals = await currentPostings(db)
    .select(["p.currency", sql<string>`SUM(p.amount)`.as("amount")])
    .where("p.account_id", "in", descendants(accounts, id))
    .where("t.date", ">=", from)
    .where("t.date", "<=", to)
    .groupBy("p.currency")
    .orderBy("p.currency")
    .execute();
  return totals.map(({ currency, amount }) => ({
    currency,
    amount: naturalAmount(category.kind, BigInt(amount)),
  }));
}

export async function getOperations(
  db: Kysely<LedgerDatabase>,
  limit: number,
  before?: string,
) {
  let query = db
    .selectFrom("operations")
    .selectAll()
    .orderBy("seq", "desc")
    .limit(limit);
  if (before) query = query.where("seq", "<", before);
  const entries = await query.execute();
  const oldest = entries.at(-1);
  if (!oldest) return [];
  const reversals = before
    ? await db
        .selectFrom("operations")
        .select(["id", "undoes_operation_id"])
        .where("seq", ">", oldest.seq)
        .where("undoes_operation_id", "is not", null)
        .orderBy("seq", "desc")
        .execute()
    : entries;
  const undone = new Map<string, boolean>();
  // Un deshacer directo es único. La paridad de la cadena muestra si está aplicado.
  for (const entry of reversals) {
    if (entry.undoes_operation_id !== null)
      undone.set(entry.undoes_operation_id, !undone.get(entry.id));
  }
  return entries.map((entry) => ({
    ...entry,
    undone: undone.get(entry.id) ?? false,
  }));
}
