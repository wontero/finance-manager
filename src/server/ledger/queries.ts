import { convert } from "@finance-manager/core";
import { sql, type Kysely } from "kysely";
import { findExchangeRate } from "./metadata.js";
import type { AccountKind, LedgerDatabase } from "./schema.js";

export function naturalAmount(kind: AccountKind, amount: bigint) {
  return kind === "asset" || kind === "expense" ? amount : -amount;
}

function currentPostings(db: Kysely<LedgerDatabase>) {
  return db
    .selectFrom("postings as p")
    .innerJoin("transactions as t", "t.id", "p.transaction_id")
    .where("t.deleted_at", "is", null);
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

export async function getNetWorth(db: Kysely<LedgerDatabase>, date: string) {
  const balances = await currentPostings(db)
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .innerJoin("currencies as c", "c.code", "a.currency")
    .select([
      "a.id",
      "a.name",
      "a.kind",
      "c.code as currency",
      "c.minor_unit",
      sql<string>`SUM(p.amount)`.as("amount"),
    ])
    .where("a.kind", "in", ["asset", "liability"])
    .where("t.date", "<=", date)
    .groupBy(["a.id", "a.name", "a.kind", "c.code", "c.minor_unit"])
    .having(sql<string>`SUM(p.amount)`, "!=", "0")
    .orderBy("a.id")
    .execute();
  const bob = await db
    .selectFrom("currencies")
    .select("minor_unit")
    .where("code", "=", "BOB")
    .executeTakeFirst();
  if (!bob) throw new Error("No existe la moneda base BOB.");
  const rates = new Map<string, string | null>();
  const unvalued = [];
  let amount = 0n;
  for (const balance of balances) {
    const units = BigInt(balance.amount);
    if (balance.currency === "BOB") {
      amount += units;
      continue;
    }
    if (!rates.has(balance.currency)) {
      const rate = await findExchangeRate(db, balance.currency, "BOB", date);
      rates.set(balance.currency, rate?.rate ?? null);
    }
    const rate = rates.get(balance.currency);
    if (rate)
      amount += convert(units, rate, balance.minor_unit, bob.minor_unit);
    else
      unvalued.push({
        id: balance.id,
        name: balance.name,
        kind: balance.kind,
        currency: balance.currency,
        amount: naturalAmount(balance.kind, units),
      });
  }
  return { amount, currency: "BOB" as const, unvalued };
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

export async function getOperations(db: Kysely<LedgerDatabase>, limit: number) {
  const entries = await db
    .selectFrom("operations")
    .selectAll()
    .orderBy("seq", "desc")
    .limit(limit)
    .execute();
  const undone = new Map<string, boolean>();
  // Un deshacer directo es único. La paridad de la cadena muestra si está aplicado.
  for (const entry of entries) {
    if (entry.undoes_operation_id !== null)
      undone.set(entry.undoes_operation_id, !undone.get(entry.id));
  }
  return entries.map((entry) => ({
    ...entry,
    undone: undone.get(entry.id) ?? false,
  }));
}
