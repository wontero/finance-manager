import {
  assertBalanced,
  parseAmount,
  todayLaPaz,
  type TransactionInput,
} from "@finance-manager/core";
import type { Kysely } from "kysely";
import { utcStamp, type LedgerWrite } from "./audit.js";
import { setTags, validateCustom } from "./metadata.js";
import {
  systemAccounts,
  type Account,
  type LedgerDatabase,
  type Posting,
} from "./schema.js";

type Line = TransactionInput["lines"][number];
type PreparedLine = Pick<
  Posting,
  "account_id" | "currency" | "amount" | "memo"
>;
type Entry = Omit<TransactionInput, "lines">;

export async function accountById(db: Kysely<LedgerDatabase>, id: string) {
  const account = await db
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!account) throw new Error(`No existe la cuenta ${id}.`);
  return account;
}

function requireActive(account: Account) {
  if (account.archived_at !== null)
    throw new Error(`La cuenta "${account.name}" está archivada.`);
  return account;
}

export async function activeAccount(db: Kysely<LedgerDatabase>, id: string) {
  return requireActive(await accountById(db, id));
}

export async function currencyAccount(db: Kysely<LedgerDatabase>, id: string) {
  const account = await activeAccount(db, id);
  if (
    !account.currency ||
    (account.kind !== "asset" && account.kind !== "liability")
  )
    throw new Error("Se requiere una cuenta de activo o pasivo.");
  return { ...account, currency: account.currency };
}

export async function systemAccount(db: Kysely<LedgerDatabase>, name: string) {
  const account = await db
    .selectFrom("accounts")
    .select("id")
    .where("name", "=", name)
    .where("is_system", "=", 1)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!account) throw new Error(`Falta la cuenta de sistema "${name}".`);
  return account.id;
}

export async function minorUnit(db: Kysely<LedgerDatabase>, currency: string) {
  const row = await db
    .selectFrom("currencies")
    .select("minor_unit")
    .where("code", "=", currency)
    .executeTakeFirst();
  if (!row) throw new Error(`No existe la moneda ${currency}.`);
  return row.minor_unit;
}

function validatePostingAccount(account: Account, currency: string) {
  requireActive(account);
  if (
    account.is_system &&
    (account.kind === "income" || account.kind === "expense")
  )
    throw new Error(
      `La raíz "${account.name}" no admite líneas. Elige una categoría.`,
    );
  if (account.currency !== null && account.currency !== currency)
    throw new Error(
      `La moneda de "${account.name}" debe ser ${account.currency}.`,
    );
}

async function prepareLines(db: Kysely<LedgerDatabase>, lines: Line[]) {
  const accounts = new Map(
    (
      await db
        .selectFrom("accounts")
        .selectAll()
        .where("id", "in", [...new Set(lines.map((line) => line.accountId))])
        .execute()
    ).map((account) => [account.id, account]),
  );
  const currencies = new Map(
    (
      await db
        .selectFrom("currencies")
        .select(["code", "minor_unit"])
        .where("code", "in", [...new Set(lines.map((line) => line.currency))])
        .execute()
    ).map(({ code, minor_unit }) => [code, minor_unit]),
  );
  const parsed = lines.map(({ accountId, currency, side, amount, memo }) => {
    const account = accounts.get(accountId);
    const scale = currencies.get(currency);
    if (!account) throw new Error(`No existe la cuenta ${accountId}.`);
    if (scale === undefined)
      throw new Error(`No existe la moneda ${currency}.`);
    validatePostingAccount(account, currency);
    return {
      account_id: accountId,
      currency,
      amount: parseAmount(side === "credit" ? "-" + amount : amount, scale),
      memo: memo ?? null,
    };
  });
  assertBalanced(parsed);
  return parsed.map((line) => ({ ...line, amount: line.amount.toString() }));
}

async function insertEntry(
  write: LedgerWrite,
  entry: Entry & { date: string },
  lines: PreparedLine[],
  custom: string | null,
) {
  const operationId = await write.operation();
  const transaction = await write.insert("transactions", {
    date: entry.date,
    description: entry.description,
    note: entry.note ?? null,
    operation_id: operationId,
    custom,
  });
  for (const line of lines)
    await write.insert("postings", { transaction_id: transaction.id, ...line });
  if (entry.tags?.length) await setTags(write, transaction.id, entry.tags);
  return { id: transaction.id, operationId };
}

export async function createEntry(write: LedgerWrite, entry: TransactionInput) {
  const lines = await prepareLines(write.db, entry.lines);
  const custom = await validateCustom(write.db, "transaction", entry.custom);
  return insertEntry(
    write,
    { ...entry, date: entry.date ?? todayLaPaz() },
    lines,
    custom,
  );
}

export async function recordCategorized(
  write: LedgerWrite,
  input: Entry & { accountId: string; categoryId: string; amount: string },
  kind: "income" | "expense",
) {
  const { currency } = await currencyAccount(write.db, input.accountId);
  const category = await activeAccount(write.db, input.categoryId);
  if (category.kind !== kind)
    throw new Error(
      `Elige una categoría de ${kind === "income" ? "ingresos" : "gastos"}.`,
    );
  const line = { currency, amount: input.amount };
  const [debited, credited] =
    kind === "income"
      ? [input.accountId, input.categoryId]
      : [input.categoryId, input.accountId];
  return createEntry(write, {
    ...input,
    lines: [
      { ...line, accountId: credited, side: "credit" },
      { ...line, accountId: debited, side: "debit" },
    ],
  });
}

export async function transfer(
  write: LedgerWrite,
  input: Entry & {
    fromAccountId: string;
    toAccountId: string;
    amount: string;
    receivedAmount?: string;
  },
) {
  if (input.fromAccountId === input.toAccountId)
    throw new Error("La transferencia requiere dos cuentas distintas.");
  const from = await currencyAccount(write.db, input.fromAccountId);
  const to = await currencyAccount(write.db, input.toAccountId);
  const lines: Line[] = [
    {
      accountId: from.id,
      currency: from.currency,
      amount: input.amount,
      side: "credit",
    },
    {
      accountId: to.id,
      currency: to.currency,
      amount: input.receivedAmount ?? input.amount,
      side: "debit",
    },
  ];
  if (from.currency !== to.currency) {
    if (input.receivedAmount === undefined)
      throw new Error("Indica el monto recibido en la moneda de destino.");
    const clearing = await systemAccount(write.db, systemAccounts.clearing);
    lines.push(
      { ...lines[0], accountId: clearing, side: "debit" },
      { ...lines[1], accountId: clearing, side: "credit" },
    );
  }
  return createEntry(write, { ...input, lines });
}

export async function recordAdjustment(
  write: LedgerWrite,
  account: Account & { currency: string },
  amount: bigint,
  offsetName: string,
  entry: { date: string; description: string },
) {
  const offset = await systemAccount(write.db, offsetName);
  const signed = account.kind === "liability" ? -amount : amount;
  const lines = [
    {
      account_id: account.id,
      currency: account.currency,
      amount: signed,
      memo: null,
    },
    {
      account_id: offset,
      currency: account.currency,
      amount: -signed,
      memo: null,
    },
  ];
  assertBalanced(lines);
  return insertEntry(
    write,
    entry,
    lines.map((line) => ({ ...line, amount: line.amount.toString() })),
    null,
  );
}

async function activeEntry(db: Kysely<LedgerDatabase>, id: string) {
  const entry = await db
    .selectFrom("transactions")
    .select("id")
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!entry) throw new Error(`El asiento ${id} no existe o está borrado.`);
  const archived = await db
    .selectFrom("postings as p")
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .select("a.name")
    .where("p.transaction_id", "=", id)
    .where("a.kind", "in", ["asset", "liability"])
    .where("a.archived_at", "is not", null)
    .limit(1)
    .executeTakeFirst();
  if (archived)
    throw new Error(
      `El asiento usa la cuenta archivada "${archived.name}". Desarchívala o deshaz primero el archivado.`,
    );
}

export async function editEntry(
  write: LedgerWrite,
  input: Partial<TransactionInput> & { id: string },
) {
  const { id, date, description, note, custom, tags } = input;
  await activeEntry(write.db, id);
  const lines = input.lines && (await prepareLines(write.db, input.lines));
  const fields = {
    ...(date === undefined ? {} : { date }),
    ...(description === undefined ? {} : { description }),
    ...(note === undefined ? {} : { note }),
    ...(custom === undefined
      ? {}
      : { custom: await validateCustom(write.db, "transaction", custom) }),
  };
  if (Object.keys(fields).length)
    await write.update("transactions", { id }, fields);
  if (lines) {
    const old = await write.db
      .selectFrom("postings")
      .select("id")
      .where("transaction_id", "=", id)
      .orderBy("id")
      .execute();
    for (const posting of old) await write.delete("postings", posting);
    for (const line of lines)
      await write.insert("postings", { transaction_id: id, ...line });
  }
  if (tags !== undefined) await setTags(write, id, tags);
  return { id, operationId: write.operationId };
}

export async function deleteEntry(write: LedgerWrite, id: string) {
  await activeEntry(write.db, id);
  await write.update("transactions", { id }, { deleted_at: utcStamp() });
  return { id, operationId: await write.operation() };
}

function signature(
  lines: Pick<Posting, "account_id" | "currency" | "amount">[],
) {
  return lines
    .map(
      ({ account_id, currency, amount }) =>
        `${account_id}/${currency}/${amount}`,
    )
    .sort()
    .join(";");
}

async function duplicatesOn(db: Kysely<LedgerDatabase>, date: string) {
  const existing = await db
    .selectFrom("transactions as t")
    .innerJoin("postings as p", "p.transaction_id", "t.id")
    .select(["p.transaction_id", "p.account_id", "p.currency", "p.amount"])
    .where("t.date", "=", date)
    .where("t.deleted_at", "is", null)
    .orderBy("t.id")
    .execute();
  const linesById = new Map<string, typeof existing>();
  for (const line of existing) {
    const lines = linesById.get(line.transaction_id) ?? [];
    lines.push(line);
    linesById.set(line.transaction_id, lines);
  }
  const ids = new Map<string, string>();
  for (const [id, lines] of linesById) {
    const key = signature(lines);
    if (!ids.has(key)) ids.set(key, id);
  }
  return ids;
}

export async function importEntries(
  write: LedgerWrite,
  entries: TransactionInput[],
  duplicates: "include" | "skip",
) {
  const created: string[] = [];
  const skipped: { index: number; existingId: string }[] = [];
  const byDate = new Map<string, Map<string, string>>();
  const today = todayLaPaz();
  for (const [index, entry] of entries.entries()) {
    const date = entry.date ?? today;
    const lines = await prepareLines(write.db, entry.lines);
    const custom = await validateCustom(write.db, "transaction", entry.custom);
    if (duplicates === "include") {
      created.push(
        (await insertEntry(write, { ...entry, date }, lines, custom)).id,
      );
      continue;
    }
    const seen = byDate.get(date) ?? (await duplicatesOn(write.db, date));
    byDate.set(date, seen);
    const key = signature(lines);
    const existingId = seen.get(key);
    if (existingId) {
      skipped.push({ index, existingId });
      continue;
    }
    const { id } = await insertEntry(write, { ...entry, date }, lines, custom);
    seen.set(key, id);
    created.push(id);
  }
  return { created, skipped, operationId: write.operationId };
}
