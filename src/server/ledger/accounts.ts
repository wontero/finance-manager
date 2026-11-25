import {
  parseAmount,
  todayLaPaz,
  type LedgerInput,
} from "@finance-manager/core";
import { utcStamp, type LedgerWrite } from "./audit.js";
import { validateCustom } from "./metadata.js";
import { getAccountTotal, naturalAmount } from "./queries.js";
import { systemAccounts, type Account } from "./schema.js";
import {
  activeAccount,
  currencyAccount,
  minorUnit,
  recordAdjustment,
} from "./transactions.js";

async function mutableAccount(write: LedgerWrite, id: string) {
  const account = await activeAccount(write.db, id);
  if (account.is_system)
    throw new Error(`La cuenta de sistema "${account.name}" es inmutable.`);
  return account;
}

async function parentOfKind(
  write: LedgerWrite,
  parentId: string | null,
  kind: Account["kind"],
) {
  if (parentId === null) {
    if (kind === "income" || kind === "expense")
      throw new Error("La categoría debe quedar bajo su raíz de sistema.");
    return;
  }
  const parent = await activeAccount(write.db, parentId);
  if (parent.kind !== kind)
    throw new Error("La cuenta padre debe ser del mismo tipo.");
}

async function rejectCycle(
  write: LedgerWrite,
  id: string,
  parentId: string | null,
) {
  const seen = new Set([id]);
  while (parentId !== null) {
    if (seen.has(parentId))
      throw new Error("El movimiento de la cuenta crearía un ciclo.");
    seen.add(parentId);
    const parent = await write.db
      .selectFrom("accounts")
      .select("parent_id")
      .where("id", "=", parentId)
      .executeTakeFirstOrThrow();
    parentId = parent.parent_id;
  }
}

export async function createAccount(
  write: LedgerWrite,
  input: LedgerInput<"createAccount">,
) {
  const scale = await minorUnit(write.db, input.currency);
  const custom = await validateCustom(write.db, "account", input.custom);
  await parentOfKind(write, input.parentId ?? null, input.kind);
  const opening = input.opening && parseAmount(input.opening.amount, scale);
  const account = await write.insert("accounts", {
    name: input.name,
    kind: input.kind,
    subtype: input.subtype,
    currency: input.currency,
    parent_id: input.parentId ?? null,
    custom,
  });
  if (opening !== undefined && opening !== 0n)
    await recordAdjustment(
      write,
      { ...account, currency: input.currency },
      opening,
      systemAccounts.opening,
      {
        date: input.opening!.date,
        description: "Saldo de apertura",
      },
    );
  return { id: account.id, operationId: await write.operation() };
}

export async function createCategory(
  write: LedgerWrite,
  input: LedgerInput<"createCategory">,
) {
  const parent = await activeAccount(write.db, input.parentId);
  if (parent.kind !== "income" && parent.kind !== "expense")
    throw new Error("Elige una categoría padre de ingresos o gastos.");
  const custom = await validateCustom(write.db, "account", input.custom);
  const account = await write.insert("accounts", {
    name: input.name,
    kind: parent.kind,
    parent_id: parent.id,
    custom,
  });
  return { id: account.id, operationId: await write.operation() };
}

export async function renameAccount(
  write: LedgerWrite,
  id: string,
  name: string,
) {
  await mutableAccount(write, id);
  await write.update("accounts", { id }, { name });
  return { id, operationId: await write.operation() };
}

export async function setAccountCustom(
  write: LedgerWrite,
  { id, custom }: LedgerInput<"setAccountCustom">,
) {
  await mutableAccount(write, id);
  await write.update(
    "accounts",
    { id },
    { custom: await validateCustom(write.db, "account", custom) },
  );
  return { id, operationId: await write.operation() };
}

export async function moveAccount(
  write: LedgerWrite,
  id: string,
  parentId: string | null,
) {
  const account = await mutableAccount(write, id);
  await parentOfKind(write, parentId, account.kind);
  await rejectCycle(write, id, parentId);
  await write.update("accounts", { id }, { parent_id: parentId });
  return { id, operationId: await write.operation() };
}

export async function archiveAccount(write: LedgerWrite, id: string) {
  const account = await mutableAccount(write, id);
  if (account.kind === "asset" || account.kind === "liability") {
    if ((await getAccountTotal(write.db, id)) !== 0n)
      throw new Error("La cuenta debe tener saldo cero para archivarse.");
  } else {
    const child = await write.db
      .selectFrom("accounts")
      .select("id")
      .where("parent_id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (child) throw new Error("La categoría tiene hijas activas.");
  }
  await write.update("accounts", { id }, { archived_at: utcStamp() });
  return { id, operationId: await write.operation() };
}

export async function mergeCategories(
  write: LedgerWrite,
  sourceId: string,
  targetId: string,
) {
  const source = await mutableAccount(write, sourceId);
  const target = await mutableAccount(write, targetId);
  if (
    source.kind !== target.kind ||
    (source.kind !== "income" && source.kind !== "expense")
  )
    throw new Error("Solo se pueden fusionar categorías del mismo tipo.");
  await rejectCycle(write, sourceId, targetId);
  const postings = await write.db
    .selectFrom("postings")
    .select("id")
    .where("account_id", "=", sourceId)
    .orderBy("id")
    .execute();
  for (const posting of postings)
    await write.update("postings", posting, { account_id: targetId });
  const children = await write.db
    .selectFrom("accounts")
    .select("id")
    .where("parent_id", "=", sourceId)
    .orderBy("id")
    .execute();
  for (const child of children)
    await write.update("accounts", child, { parent_id: targetId });
  await write.update("accounts", { id: sourceId }, { archived_at: utcStamp() });
  return { id: targetId, operationId: await write.operation() };
}

export async function reconcile(
  write: LedgerWrite,
  input: LedgerInput<"reconcile">,
) {
  const account = await currencyAccount(write.db, input.id);
  const date = input.date ?? todayLaPaz();
  const scale = await minorUnit(write.db, account.currency);
  const actualBalance = parseAmount(input.actualBalance, scale);
  const balance = naturalAmount(
    account.kind,
    await getAccountTotal(write.db, account.id, date),
  );
  const difference = actualBalance - balance;
  if (difference === 0n) return null;
  return recordAdjustment(
    write,
    account,
    difference,
    systemAccounts.adjustment,
    {
      date,
      description: "Ajuste de conciliación",
    },
  );
}
