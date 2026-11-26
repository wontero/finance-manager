import {
  convert,
  parseRate,
  todayLaPaz,
  decimalMoney,
  type Category,
  type DashboardAccounts,
  type DashboardMovements,
  type DashboardOperation,
  type DashboardReports,
  type DashboardSummary,
  type DashboardTransaction,
  type PeriodTotals,
  type Page,
  type Worth,
} from "@finance-manager/core";
import type { Kysely, Transaction } from "kysely";
import { LedgerWrite } from "./audit.js";
import { findExchangeRate } from "./metadata.js";
import {
  amountConverter,
  getCurrencyScales as currencyScales,
  getNetWorth,
  getOperations,
} from "./queries.js";
import {
  findTransactions,
  getAccountBalances,
  getAccountTree,
  getPeriodSummary,
  monthEnd,
} from "./reports.js";
import type { LedgerDatabase } from "./schema.js";

type Database = Kysely<LedgerDatabase>;
type Scales = ReadonlyMap<string, number>;
type Amount = { currency: string; amount: bigint };

export function shiftMonth(month: string, offset: number) {
  const date = new Date(month + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function money({ amount, currency }: Amount, scales: Scales) {
  return decimalMoney(amount, currency, scales);
}

async function period(db: Database, from: string, to: string, scales: Scales) {
  const result = await getPeriodSummary(db, {
    from,
    to,
    includeArchived: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (!result.totals.some(({ currency }) => currency === "BOB"))
    result.totals.unshift({ currency: "BOB", income: 0n, expense: 0n });
  const totals: PeriodTotals = result.totals.map(
    ({ currency, income, expense }) => ({
      income: money({ amount: income, currency }, scales),
      expense: money({ amount: expense, currency }, scales),
    }),
  );
  const categories = result.categories.filter(
    ({ kind, amounts }) =>
      kind === "expense" && amounts.some(({ amount }) => amount !== 0n),
  );
  return { totals, categories };
}

async function worth(
  db: Database,
  date: string,
  scales: Scales,
): Promise<Worth> {
  const result = await getNetWorth(db, date);
  const bobScale = scales.get("BOB")!;
  const usdScale = scales.get("USD")!;
  const direct = await findExchangeRate(db, "BOB", "USD", date);
  const inverse = !direct && (await findExchangeRate(db, "USD", "BOB", date));
  let usd = null;
  if (direct) usd = convert(result.amount, direct.rate, bobScale, usdScale);
  else if (inverse) {
    const magnitude = result.amount < 0n ? -result.amount : result.amount;
    const numerator = magnitude * 10n ** BigInt(usdScale + 10);
    const divisor = parseRate(inverse.rate) * 10n ** BigInt(bobScale);
    usd =
      ((numerator + divisor / 2n) / divisor) * (result.amount < 0n ? -1n : 1n);
  }
  return {
    bob: money(result, scales),
    usd: usd === null ? null : money({ amount: usd, currency: "USD" }, scales),
    unvalued: result.unvalued.map(
      ({ name, amount, currency }) =>
        name + " · " + money({ amount, currency }, scales).texto,
    ),
  };
}

async function expenseCategories(
  db: Database,
  categories: Awaited<ReturnType<typeof period>>["categories"],
  date: string,
  scales: Scales,
): Promise<Category[]> {
  const sum = amountConverter(db, "BOB", date, scales);
  const sorted = await Promise.all(
    categories.map(async ({ id, name, amounts }) => ({
      id,
      name,
      amounts: amounts.map((value) => money(value, scales)),
      total: (await sum(amounts)).amount,
    })),
  );
  sorted.sort((a, b) =>
    a.total === b.total
      ? a.name.localeCompare(b.name, "es-BO")
      : a.total > b.total
        ? -1
        : 1,
  );
  return sorted.map(({ id, name, amounts }) => ({ id, name, amounts }));
}

export async function dashboardTransactions(
  db: Database,
  input: Parameters<typeof findTransactions>[1],
  scales?: Scales,
): Promise<DashboardMovements> {
  const result = await findTransactions(db, input);
  const units = scales ?? (await currencyScales(db));
  const accountIds = new Set(
    result.entries.flatMap(({ postings }) =>
      postings.map(({ account_id }) => account_id),
    ),
  );
  const accounts = new Map(
    (accountIds.size
      ? await db
          .selectFrom("accounts")
          .select(["id", "name", "kind"])
          .where("id", "in", [...accountIds])
          .execute()
      : []
    ).map((account) => [account.id, account]),
  );
  const rows = result.entries.map((entry): DashboardTransaction => {
    const postings: DashboardTransaction["postings"] = [];
    const categories: DashboardTransaction["categories"] = [];
    for (const { account_id, currency, amount, memo } of entry.postings) {
      const { name, kind } = accounts.get(account_id)!;
      const signed = BigInt(amount);
      if (kind === "income" || kind === "expense")
        categories.push({
          id: account_id,
          name,
          kind,
          money: money(
            { currency, amount: kind === "income" ? -signed : signed },
            units,
          ),
        });
      else if (kind !== "equity")
        postings.push({
          accountId: account_id,
          name,
          money: money({ currency, amount: signed }, units),
          memo,
        });
    }
    const { id, date, description, note, actor, type, tags } = entry;
    return {
      id,
      date,
      description,
      note,
      actor,
      type,
      tags,
      postings,
      categories,
      custom:
        entry.custom === null
          ? null
          : (JSON.parse(entry.custom) as DashboardTransaction["custom"]),
    };
  });
  const last = rows.at(-1);
  const dayTotals: DashboardMovements["dayTotals"] = {};
  for (const { date, currency, amount, kind } of result.dayTotals) {
    const flow = kind === "income" ? "income" : "expense";
    const total = (dayTotals[date] ??= { income: [], expense: [] });
    const natural = BigInt(amount) * (flow === "income" ? -1n : 1n);
    total[flow].push(money({ currency, amount: natural }, units));
  }
  return {
    rows,
    dayTotals,
    cursor: result.more && last ? last.date + ":" + last.id : null,
  };
}

export async function dashboardAccounts(
  db: Database,
): Promise<DashboardAccounts> {
  const accounts = await getAccountTree(db, true);
  const scales = await currencyScales(db);
  const balances = await getAccountBalances(
    db,
    accounts.map(({ id }) => id),
    todayLaPaz(),
  );
  return {
    accounts: accounts.map(
      ({ id, parent_id, name, path, kind, currency, archived_at }) => {
        const values = balances.filter((balance) => balance.id === id);
        if (!values.length && currency)
          values.push({ id, kind, currency, amount: 0n });
        return {
          id,
          parentId: parent_id,
          name,
          path,
          kind,
          currency,
          archived: archived_at !== null,
          balances: values.map((value) => money(value, scales)),
        };
      },
    ),
  };
}

export async function dashboardSummary(
  db: Database,
  month: string,
): Promise<DashboardSummary> {
  const today = todayLaPaz();
  const from = month + "-01";
  const to = monthEnd(month);
  const valuation = today.startsWith(month) ? today : to;
  const previousMonth = shiftMonth(month, -1);
  const scales = await currencyScales(db);
  const current = await period(db, from, to, scales);
  const previous = await period(
    db,
    previousMonth + "-01",
    monthEnd(previousMonth),
    scales,
  );
  const accounts = await db
    .selectFrom("accounts")
    .select(["id", "currency"])
    .where("kind", "=", "asset")
    .where("subtype", "in", ["efectivo", "banco"])
    .execute();
  const cash = new Map<string, bigint>([["BOB", 0n]]);
  for (const { currency } of accounts)
    if (currency && !cash.has(currency)) cash.set(currency, 0n);
  const balances = await getAccountBalances(
    db,
    accounts.map(({ id }) => id),
    valuation,
  );
  for (const { currency, amount } of balances)
    cash.set(currency, (cash.get(currency) ?? 0n) + amount);
  return {
    month,
    previousMonth,
    current: current.totals,
    previous: previous.totals,
    netWorth: await worth(db, valuation, scales),
    liquid: [...cash].map(([currency, amount]) =>
      money({ amount, currency }, scales),
    ),
    topCategories: (
      await expenseCategories(db, current.categories, to, scales)
    ).slice(0, 5),
    recent: (await dashboardTransactions(db, { from, to, limit: 5 }, scales))
      .rows,
  };
}

export async function dashboardReports(
  db: Database,
  from: string,
  to: string,
): Promise<DashboardReports> {
  const scales = await currencyScales(db);
  const months: DashboardReports["months"] = [];
  const finalMonth = to.slice(0, 7);
  for (let month = from.slice(0, 7); ;) {
    const start = month + "-01";
    const end = monthEnd(month);
    const { totals } = await period(
      db,
      start < from ? from : start,
      end > to ? to : end,
      scales,
    );
    months.push({ month, totals, netWorth: await worth(db, end, scales) });
    if (month === finalMonth) break;
    month = shiftMonth(month, 1);
  }
  const { categories } = await period(db, from, to, scales);
  return {
    months,
    categories: await expenseCategories(db, categories, to, scales),
  };
}

const entities: Record<string, string> = {
  accounts: "Cuenta o categoría",
  transactions: "Movimiento",
  postings: "Partida",
  loans: "Préstamo",
  goals: "Meta",
  goal_accounts: "Cuenta de la meta",
  tags: "Etiqueta",
  transaction_tags: "Etiqueta del movimiento",
  custom_field_definitions: "Campo personalizado",
  exchange_rates: "Tipo de cambio",
};
const labels: Record<string, string> = {
  name: "Nombre",
  date: "Fecha",
  description: "Descripción",
  note: "Nota",
  account_id: "Cuenta",
  parent_id: "Cuenta superior",
  transaction_id: "Movimiento",
  tag_id: "Etiqueta",
  amount: "Monto",
  target_amount: "Monto objetivo",
  currency: "Moneda",
  custom: "Campos",
  kind: "Tipo",
  subtype: "Subtipo",
  archived_at: "Archivado",
  deleted_at: "Eliminado",
  principal: "Capital",
  principal_paid: "Capital pagado",
  interest_paid: "Interés pagado",
  interest_carry: "Interés acumulado",
  counterparty: "Contraparte",
  rate: "Tasa",
  from_currency: "Moneda de origen",
  to_currency: "Moneda de destino",
  source: "Fuente",
  memo: "Nota de partida",
  closed_at: "Cerrado",
  due_date: "Vencimiento",
};

function changeDetail(
  {
    table_name,
    row_id,
    before,
    after,
  }: Pick<
    LedgerDatabase["audit_log"],
    "table_name" | "row_id" | "before" | "after"
  >,
  scales: Scales,
) {
  type Snapshot = Record<string, string | number | null>;
  const old: Snapshot | null = before === null ? null : JSON.parse(before);
  const next: Snapshot | null = after === null ? null : JSON.parse(after);
  const fields = Object.keys(next ?? old ?? {}).filter(
    (field) =>
      ![
        "id",
        "operation_id",
        "user_id",
        "created_at",
        "updated_at",
        "is_system",
        "loan_interest",
      ].includes(field) &&
      (old && next
        ? old[field] !== next[field]
        : (next ?? old)?.[field] != null),
  );
  const describe = (row: Snapshot | null) =>
    row === null
      ? null
      : fields
          .map((field) => {
            const value = row[field];
            const currency = row.currency;
            const monetary = [
              "amount",
              "target_amount",
              "principal",
              "principal_paid",
              "interest_paid",
            ].includes(field);
            const text =
              monetary &&
              typeof currency === "string" &&
              typeof value === "string"
                ? money({ currency, amount: BigInt(value) }, scales).texto
                : (value ?? "—");
            return (labels[field] ?? field.replaceAll("_", " ")) + ": " + text;
          })
          .join("\n") || "#" + row_id;
  return {
    entity: (entities[table_name] ?? "Fila contable") + " · " + row_id,
    before: describe(old),
    after: describe(next),
  };
}

export async function dashboardOperations(
  db: Transaction<LedgerDatabase>,
  userId: string,
  limit: number,
  before?: string,
): Promise<Page<DashboardOperation>> {
  const entries = await getOperations(db, limit + 1, before);
  const rows = entries.slice(0, limit);
  if (!rows.length) return { rows: [], cursor: null };
  const ids = rows.map(({ id }) => id);
  const scales = await currencyScales(db);
  const audit = await db
    .selectFrom("audit_log")
    .selectAll()
    .where("operation_id", "in", ids)
    .orderBy("id", "desc")
    .execute();
  const reversed = new Set(
    (
      await db
        .selectFrom("operations")
        .select("undoes_operation_id")
        .where("undoes_operation_id", "in", ids)
        .execute()
    ).map(({ undoes_operation_id }) => undoes_operation_id),
  );
  const logByOperation = new Map<string, typeof audit>();
  for (const row of audit) {
    const log = logByOperation.get(row.operation_id) ?? [];
    log.push(row);
    logByOperation.set(row.operation_id, log);
  }
  const planner = new LedgerWrite(db, userId, "web", "", null);
  const operations: DashboardOperation[] = [];
  for (const entry of rows) {
    const { id, actor, description, created_at, undone } = entry;
    const log = logByOperation.get(id) ?? [];
    operations.push({
      id,
      actor,
      description,
      date: created_at.replace(" ", "T") + "Z",
      undone,
      changes: [...log].reverse().map((row) => changeDetail(row, scales)),
      canUndo: !reversed.has(id) && (await planner.canUndo(entry, log)),
    });
  }
  return {
    rows: operations,
    cursor: entries.length > rows.length ? rows.at(-1)!.seq : null,
  };
}
