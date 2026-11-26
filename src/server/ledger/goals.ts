import {
  parseAmount,
  todayLaPaz,
  type LedgerInput,
} from "@finance-manager/core";
import type { Kysely } from "kysely";
import { utcStamp, type LedgerWrite } from "./audit.js";
import {
  amountConverter,
  getCategoryTotals,
  getCurrencyScales,
} from "./queries.js";
import { getAccountBalances, monthEnd } from "./reports.js";
import type { Goal, LedgerDatabase } from "./schema.js";
import { accountById, minorUnit } from "./transactions.js";

type Database = Kysely<LedgerDatabase>;

async function goalById(db: Database, id: string, activeOnly = false) {
  let query = db.selectFrom("goals").selectAll().where("id", "=", id);
  if (activeOnly) query = query.where("archived_at", "is", null);
  const goal = await query.executeTakeFirst();
  if (!goal) throw new Error(`No existe la meta ${id}.`);
  return goal;
}

async function accountIds(db: Database, id: string) {
  const rows = await db
    .selectFrom("goal_accounts")
    .select("account_id")
    .where("goal_id", "=", id)
    .orderBy("account_id")
    .execute();
  return rows.map(({ account_id }) => account_id);
}

function validateDates(
  type: Goal["type"],
  start: string | null,
  end: string | null,
) {
  if (start && end && end < start)
    throw new Error(
      "La fecha límite debe ser posterior o igual a la fecha de inicio.",
    );
  if (type === "spending" && (start === null) !== (end === null))
    throw new Error(
      "Un tope por rango requiere ambas fechas; un tope mensual no lleva fechas.",
    );
}

function targetAmount(amount: string, scale: number) {
  const units = parseAmount(amount, scale);
  if (units <= 0n) throw new Error("El monto objetivo debe ser positivo.");
  return units.toString();
}

async function validateCategory(db: Database, id: string) {
  if ((await accountById(db, id)).kind !== "expense")
    throw new Error("El tope requiere una categoría de gastos.");
}

async function replaceAccounts(
  write: LedgerWrite,
  goal_id: string,
  ids: string[],
) {
  const rows = await write.db
    .selectFrom("accounts")
    .select(["kind", "currency"])
    .where("id", "in", ids)
    .execute();
  if (
    rows.length !== ids.length ||
    rows.some(
      ({ kind, currency }) =>
        !currency || (kind !== "asset" && kind !== "liability"),
    )
  )
    throw new Error("La meta requiere cuentas propias de activo o pasivo.");
  const previous = new Set(await accountIds(write.db, goal_id));
  const next = new Set(ids);
  for (const account_id of previous)
    if (!next.has(account_id))
      await write.delete("goal_accounts", { goal_id, account_id });
  for (const account_id of next)
    if (!previous.has(account_id))
      await write.insert("goal_accounts", { goal_id, account_id });
}

export async function createGoal(
  write: LedgerWrite,
  input: LedgerInput<"createGoal">,
) {
  const { name, type, currency, startDate = null, endDate = null } = input;
  validateDates(type, startDate, endDate);
  if (input.type === "spending")
    await validateCategory(write.db, input.categoryId);
  const scale = await minorUnit(write.db, currency);
  const goal = await write.insert("goals", {
    name,
    type,
    currency,
    target_amount: targetAmount(input.amount, scale),
    start_date: startDate,
    end_date: endDate,
    category_id: input.type === "spending" ? input.categoryId : null,
  });
  if (input.type === "savings")
    await replaceAccounts(write, goal.id, input.accountIds);
  return { goal, scale, operationId: await write.operation() };
}

export async function updateGoal(
  write: LedgerWrite,
  input: LedgerInput<"updateGoal">,
) {
  const {
    id,
    name,
    amount,
    startDate,
    endDate,
    categoryId,
    accountIds: ids,
  } = input;
  const current = await goalById(write.db, id, true);
  const start = startDate === undefined ? current.start_date : startDate;
  const end = endDate === undefined ? current.end_date : endDate;
  validateDates(current.type, start, end);
  if (categoryId !== undefined) {
    if (current.type !== "spending")
      throw new Error("Una meta de ahorro usa cuentas.");
    await validateCategory(write.db, categoryId);
  }
  if (ids !== undefined && current.type !== "savings")
    throw new Error("Un tope de gastos usa una categoría.");
  const scale = await minorUnit(write.db, current.currency);
  const goal = await write.update(
    "goals",
    { id },
    {
      name: name ?? current.name,
      target_amount:
        amount === undefined
          ? current.target_amount
          : targetAmount(amount, scale),
      start_date: start,
      end_date: end,
      category_id: categoryId ?? current.category_id,
    },
  );
  if (ids) await replaceAccounts(write, id, ids);
  return { goal, scale, operationId: await write.operation() };
}

export async function archiveGoal(
  write: LedgerWrite,
  { id }: LedgerInput<"archiveGoal">,
) {
  const current = await goalById(write.db, id, true);
  const scale = await minorUnit(write.db, current.currency);
  const goal = await write.update("goals", { id }, { archived_at: utcStamp() });
  return { goal, scale, operationId: await write.operation() };
}

function daysUntil(today: string, end: string) {
  return Math.max(0, (Date.parse(end) - Date.parse(today)) / 86_400_000);
}

function progressFor(progress: bigint | null, target: bigint) {
  if (progress === null) return { progress, remaining: null, percentage: null };
  const missing = target - progress;
  const magnitude = progress < 0n ? -progress : progress;
  const scaled = (magnitude * 10_000n + target / 2n) / target;
  const digits = scaled.toString().padStart(3, "0");
  return {
    progress,
    remaining: missing > 0n ? missing : 0n,
    percentage:
      (progress < 0n && scaled > 0n ? "-" : "") +
      digits.slice(0, -2) +
      "." +
      digits.slice(-2),
  };
}

export async function listGoals(
  db: Database,
  { id }: LedgerInput<"listGoals">,
) {
  const today = todayLaPaz();
  const goals = id
    ? [await goalById(db, id)]
    : await db
        .selectFrom("goals")
        .selectAll()
        .where("archived_at", "is", null)
        .orderBy("id")
        .execute();
  const scales = await getCurrencyScales(db);
  const converters = new Map<string, ReturnType<typeof amountConverter>>();
  async function value(
    rows: { currency: string; amount: bigint }[],
    currency: string,
    date: string,
  ) {
    const key = currency + date;
    let converter = converters.get(key);
    if (!converter) {
      converter = amountConverter(db, currency, date, scales);
      converters.set(key, converter);
    }
    const result = await converter(rows);
    return {
      progress: result.unvalued.length ? null : result.amount,
      missingCurrencies: [
        ...new Set(result.unvalued.map((row) => row.currency)),
      ],
    };
  }

  const results = await Promise.all(
    goals.map(async (goal) => {
      const target = BigInt(goal.target_amount);
      if (goal.type === "savings") {
        const ids = await accountIds(db, goal.id);
        const balance = await value(
          await getAccountBalances(db, ids, today),
          goal.currency,
          today,
        );
        const summary = progressFor(balance.progress, target);
        const days =
          goal.end_date === null ? undefined : daysUntil(today, goal.end_date);
        const duration = BigInt(days ?? 0);
        const monthly =
          summary.remaining === 0n
            ? 0n
            : duration === 0n || summary.remaining === null
              ? null
              : (summary.remaining * 30n + duration - 1n) / duration;
        return {
          ...balance,
          ...summary,
          goal,
          type: "savings" as const,
          accountIds: ids,
          days,
          monthly,
        };
      }
      const month = today.slice(0, 7);
      const from = goal.start_date ?? month + "-01";
      const to = goal.end_date ?? monthEnd(month);
      const spending = await value(
        await getCategoryTotals(db, goal.category_id!, from, to),
        goal.currency,
        to < today ? to : today,
      );
      return {
        ...spending,
        ...progressFor(spending.progress, target),
        goal,
        type: "spending" as const,
        from,
        to,
        exceeded:
          spending.progress === null ? null : spending.progress > target,
      };
    }),
  );
  return { results, scales };
}
