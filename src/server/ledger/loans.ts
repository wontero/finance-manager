import {
  accruedInterest,
  formatAmount,
  loanInterestDue,
  parseAmount,
  splitLoanPayment,
  todayLaPaz,
  type LedgerInput,
} from "@finance-manager/core";
import { sql, type Kysely } from "kysely";
import { createAccount, createCategory } from "./accounts.js";
import { utcStamp, type LedgerWrite } from "./audit.js";
import { systemAccounts, type LedgerDatabase, type Loan } from "./schema.js";
import {
  currencyAccount,
  minorUnit,
  recordBalancedEntry,
  rejectLoanAccounts,
  systemAccount,
} from "./transactions.js";

type Database = Kysely<LedgerDatabase>;
type PaymentState = Pick<
  Loan,
  | "closed_at"
  | "principal_paid"
  | "interest_paid"
  | "interest_carry"
  | "last_payment_date"
>;

const initialState: PaymentState = {
  principal_paid: "0",
  interest_paid: "0",
  interest_carry: "0",
  last_payment_date: null,
  closed_at: null,
};

function loanBalance(loan: Loan, state: PaymentState, date: string) {
  const principal = BigInt(loan.principal) - BigInt(state.principal_paid);
  const pending =
    BigInt(state.interest_carry) +
    accruedInterest(
      principal,
      loan.rate,
      loan.rate_period,
      state.last_payment_date ?? loan.start_date,
      date,
    );
  const interest = loanInterestDue(pending);
  return { principal, pending, interest, total: principal + interest };
}

async function cashAccount(db: Database, id: string, currency: string) {
  const cash = await currencyAccount(db, id);
  if (cash.currency !== currency)
    throw new Error(
      `La cuenta de caja debe estar en ${currency}. Puedes transferir primero a una cuenta de esa moneda.`,
    );
  await rejectLoanAccounts(db, [id]);
  return id;
}

async function loanAccountName(db: Database, prefix: string, date: string) {
  const characters = [...prefix];
  for (let sequence = 1; ; sequence++) {
    const suffix = ` · ${date}${sequence === 1 ? "" : ` (${sequence})`}`;
    const name =
      characters
        .slice(0, 160 - suffix.length)
        .join("")
        .trimEnd() + suffix;
    const existing = await db
      .selectFrom("accounts")
      .select("id")
      .where("parent_id", "is", null)
      .where("name", "=", name)
      .executeTakeFirst();
    if (!existing) return name;
  }
}

export async function registerLoan(
  write: LedgerWrite,
  input: LedgerInput<"registerLoan">,
) {
  const { accountId, withoutCash, direction, counterparty, currency, dueDate } =
    input;
  const date = input.date ?? todayLaPaz();
  if (dueDate && dueDate < date)
    throw new Error("El vencimiento debe ser igual o posterior al alta.");
  if (withoutCash ? accountId : !accountId)
    throw new Error(
      "Indica una cuenta de caja o la opción sin_movimiento_de_caja.",
    );
  const scale = await minorUnit(write.db, currency);
  const principal = parseAmount(input.amount, scale);
  if (principal <= 0n) throw new Error("El capital debe ser positivo.");
  const cashId = accountId
    ? await cashAccount(write.db, accountId, currency)
    : await systemAccount(write.db, systemAccounts.opening);
  const given = direction === "given";
  const name = await loanAccountName(
    write.db,
    `Préstamo ${given ? "a" : "de"} ${counterparty}`,
    date,
  );
  const { id: loanAccount } = await createAccount(
    write,
    given
      ? { name, currency, kind: "asset", subtype: "por_cobrar" }
      : { name, currency, kind: "liability", subtype: "prestamo_recibido" },
  );
  const signed = given ? principal : -principal;
  const { id: entryId, operationId } = await recordBalancedEntry(
    write,
    { date, description: name },
    currency,
    [
      { accountId: cashId, amount: -signed },
      { accountId: loanAccount, amount: signed },
    ],
  );
  const loan = await write.insert("loans", {
    account_id: loanAccount,
    direction,
    counterparty,
    currency,
    principal: principal.toString(),
    start_date: date,
    rate: input.rate.replace(",", "."),
    rate_period: input.ratePeriod,
    due_date: dueDate ?? null,
    notes: input.notes ?? null,
  });
  return { id: loan.id, accountId: loanAccount, entryId, operationId };
}

async function findLoan(db: Database, id: string) {
  const loan = await db
    .selectFrom("loans")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!loan) throw new Error(`No existe el préstamo ${id}.`);
  return loan;
}

async function interestCategory(write: LedgerWrite, given: boolean) {
  const parentId = await systemAccount(
    write.db,
    given ? systemAccounts.income : systemAccounts.expense,
  );
  const name = "Intereses";
  const existing = await write.db
    .selectFrom("accounts")
    .select("id")
    .where("active_parent_id", "=", parentId)
    .where("name", "=", name)
    .executeTakeFirst();
  return existing?.id ?? (await createCategory(write, { name, parentId })).id;
}

export async function payLoan(
  write: LedgerWrite,
  input: LedgerInput<"payLoan">,
) {
  const date = input.date ?? todayLaPaz();
  const loan = await findLoan(write.db, input.id);
  if (date < loan.start_date)
    throw new Error("La fecha del abono es anterior al alta.");
  if (loan.last_payment_date && date < loan.last_payment_date)
    throw new Error(
      `La fecha es anterior al último abono (${loan.last_payment_date}).`,
    );
  const { currency } = loan;
  const scale = await minorUnit(write.db, currency);
  const amount = parseAmount(input.amount, scale);
  if (amount <= 0n) throw new Error("El abono debe ser positivo.");
  const { principal, pending, total } = loanBalance(loan, loan, date);
  if (amount > total)
    throw new Error(
      `El abono supera el total adeudado al ${date}: ${formatAmount(total, currency, scale)} ${currency}.`,
    );
  const cashId = await cashAccount(write.db, input.accountId, currency);
  const split = splitLoanPayment(principal, pending, amount);
  const given = loan.direction === "given";
  const sign = given ? 1n : -1n;
  const lines = [{ accountId: cashId, amount: amount * sign }];
  if (split.principal !== 0n)
    lines.push({ accountId: loan.account_id, amount: -split.principal * sign });
  if (split.interest !== 0n)
    lines.push({
      accountId: await interestCategory(write, given),
      amount: -split.interest * sign,
    });
  const entry = await recordBalancedEntry(
    write,
    { date, description: `Abono al préstamo ${loan.id}` },
    currency,
    lines,
  );
  const closed = amount === total;
  await write.update(
    "loans",
    { id: loan.id },
    {
      last_payment_date: date,
      principal_paid: (
        BigInt(loan.principal_paid) + split.principal
      ).toString(),
      interest_paid: (BigInt(loan.interest_paid) + split.interest).toString(),
      interest_carry: split.carry.toString(),
      closed_at: closed ? utcStamp() : null,
    },
  );
  return {
    id: loan.id,
    entryId: entry.id,
    operationId: entry.operationId,
    currency,
    scale,
    ...split,
    closed,
  };
}

function summarize(loan: Loan, state: PaymentState, date: string) {
  const { principal, interest, total } = loanBalance(loan, state, date);
  return {
    loan,
    principal,
    interest,
    total,
    status: state.closed_at ? ("closed" as const) : ("open" as const),
    overdue: !state.closed_at && loan.due_date !== null && loan.due_date < date,
  };
}

async function paymentHistory(db: Database, ids: string[], date: string) {
  // El asiento conserva su operación original cuando deshacer lo restaura.
  return db
    .selectFrom("audit_log as a")
    .innerJoin("transactions as t", "t.operation_id", "a.operation_id")
    .select([
      "a.row_id",
      "a.before",
      "a.after",
      "a.operation_id",
      "t.id as entryId",
      "t.date",
    ])
    .where("a.table_name", "=", "loans")
    .where("a.action", "=", "update")
    .where("a.row_id", "in", ids)
    .where("t.deleted_at", "is", null)
    .where("t.date", "<=", date)
    .orderBy("a.id")
    .execute();
}

export async function getLoan(db: Database, input: LedgerInput<"getLoan">) {
  const date = input.date ?? todayLaPaz();
  const loan = await findLoan(db, input.id);
  if (date < loan.start_date)
    throw new Error(`El préstamo ${loan.id} aún no existía al ${date}.`);
  const history = await paymentHistory(db, [loan.id], date);
  const payments = history.map((row) => {
    const before = JSON.parse(row.before!) as PaymentState;
    const after = JSON.parse(row.after!) as PaymentState;
    const principal =
      BigInt(after.principal_paid) - BigInt(before.principal_paid);
    const interest = BigInt(after.interest_paid) - BigInt(before.interest_paid);
    return {
      entryId: row.entryId,
      operationId: row.operation_id,
      date: row.date,
      principal,
      interest,
      amount: principal + interest,
    };
  });
  const latest = history.at(-1);
  const state = latest
    ? (JSON.parse(latest.after!) as PaymentState)
    : initialState;
  return { ...summarize(loan, state, date), date, payments };
}

export async function listLoans(db: Database, input: LedgerInput<"listLoans">) {
  const date = input.date ?? todayLaPaz();
  let query = db
    .selectFrom("loans")
    .selectAll()
    .select(
      sql<string>`FIRST_VALUE(counterparty) OVER (PARTITION BY counterparty ORDER BY id)`.as(
        "person",
      ),
    )
    .where("start_date", "<=", date);
  if (input.counterparty)
    query = query.where("counterparty", "=", input.counterparty);
  const loans = await query.orderBy("id").execute();
  const historical = loans.filter(
    (loan) => loan.last_payment_date && loan.last_payment_date > date,
  );
  const snapshots = new Map<string, PaymentState>();
  if (historical.length)
    for (const row of await paymentHistory(
      db,
      historical.map(({ id }) => id),
      date,
    ))
      snapshots.set(row.row_id, JSON.parse(row.after!) as PaymentState);
  const summaries = loans.map((loan) => ({
    ...summarize(
      loan,
      loan.last_payment_date && loan.last_payment_date > date
        ? (snapshots.get(loan.id) ?? initialState)
        : loan,
      date,
    ),
    person: loan.person,
  }));
  return {
    date,
    summaries: input.status
      ? summaries.filter(({ status }) => status === input.status)
      : summaries,
  };
}
