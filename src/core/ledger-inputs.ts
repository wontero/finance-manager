import { z } from "zod";

export const actorInput = z.enum(["claude", "web", "system"]);
export const rowId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((id) => id.length < 20 || id <= "18446744073709551615");
export const accountingDate = z.iso
  .date()
  .refine((date) => date >= "1000-01-01");
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.string().trim().min(1).max(280);
const positiveAmount = amount.refine((value) => /^\d/.test(value));
const text = (max: number) => z.string().trim().min(1).max(max);
const name = text(160);
const description = text(255);
const note = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).length <= 65535,
    "La nota excede el tamaño máximo.",
  );
const fieldKey = z.string().min(1).max(80);
const custom = z.record(fieldKey, z.union([z.string(), z.number()])).nullable();
const entry = z.strictObject({
  date: accountingDate.optional(),
  description,
  note: note.nullable().optional(),
  tags: z.array(text(120)).optional(),
  custom: custom.optional(),
});
const lines = z
  .array(
    z.strictObject({
      accountId: rowId,
      currency,
      side: z.enum(["debit", "credit"]),
      amount: positiveAmount,
      memo: z.string().max(255).nullable().optional(),
    }),
  )
  .min(2);
export const transactionInput = entry.extend({ lines });
const id = z.strictObject({ id: rowId });
const account = z.strictObject({
  name,
  currency,
  parentId: rowId.nullable().optional(),
  opening: z
    .strictObject({ amount: positiveAmount, date: accountingDate })
    .optional(),
  custom: custom.optional(),
});
export const accountInput = z.discriminatedUnion("kind", [
  account.extend({
    kind: z.literal("asset"),
    subtype: z.enum(["banco", "efectivo", "ahorro", "inversion", "por_cobrar"]),
  }),
  account.extend({
    kind: z.literal("liability"),
    subtype: z.enum(["tarjeta_credito", "prestamo_recibido"]),
  }),
]);
const field = z.strictObject({
  entity: z.enum(["account", "transaction"]),
  key: fieldKey.refine(
    (key) => !["__proto__", "constructor", "prototype"].includes(key),
  ),
  label: text(120),
});
const pair = z.strictObject({
  from: currency,
  to: currency,
  date: accountingDate.optional(),
});
const goalDates = {
  startDate: accountingDate.nullable().optional(),
  endDate: accountingDate.nullable().optional(),
};
const goalAccounts = z
  .array(rowId)
  .min(1)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Las cuentas deben ser distintas.",
  );
const goal = z.strictObject({
  name,
  amount: positiveAmount,
  currency,
  ...goalDates,
});

export const ledgerInputs = {
  createGoal: z.discriminatedUnion("type", [
    goal.extend({ type: z.literal("savings"), accountIds: goalAccounts }),
    goal.extend({ type: z.literal("spending"), categoryId: rowId }),
  ]),
  updateGoal: id.extend({
    name: name.optional(),
    amount: positiveAmount.optional(),
    ...goalDates,
    accountIds: goalAccounts.optional(),
    categoryId: rowId.optional(),
  }),
  archiveGoal: id,
  listGoals: z.strictObject({ id: rowId.optional() }),
  createAccount: accountInput,
  createCategory: z.strictObject({
    name,
    parentId: rowId,
    custom: custom.optional(),
  }),
  renameAccount: id.extend({ name }),
  moveAccount: id.extend({ parentId: rowId.nullable() }),
  setAccountCustom: id.extend({ custom }),
  archiveAccount: id,
  mergeCategories: z.strictObject({ sourceId: rowId, targetId: rowId }),
  createTransaction: transactionInput,
  recordExpense: entry.extend({
    accountId: rowId,
    categoryId: rowId,
    amount: positiveAmount,
  }),
  recordIncome: entry.extend({
    accountId: rowId,
    categoryId: rowId,
    amount: positiveAmount,
  }),
  transfer: entry.extend({
    fromAccountId: rowId,
    toAccountId: rowId,
    amount: positiveAmount,
    receivedAmount: positiveAmount.optional(),
  }),
  editTransaction: entry.extend({ lines }).partial().extend({ id: rowId }),
  deleteTransaction: id,
  batch: z.array(transactionInput),
  batchOptions: z.strictObject({ duplicates: z.enum(["skip", "include"]) }),
  reconcile: id.extend({
    actualBalance: amount,
    date: accountingDate.optional(),
  }),
  recordExchangeRate: pair.extend({
    rate: z.string().max(25),
    source: name,
    ifAbsent: z.literal(true).optional(),
  }),
  getExchangeRate: pair,
  defineCustomField: z.discriminatedUnion("type", [
    field.extend({ type: z.enum(["text", "number", "date"]) }),
    field.extend({
      type: z.literal("option"),
      options: z
        .array(text(120))
        .min(1)
        .refine(
          (options) => new Set(options).size === options.length,
          "Las opciones del campo deben ser distintas.",
        ),
    }),
  ]),
  archiveCustomField: id,
  getBalance: id.extend({ date: accountingDate.optional() }),
  getNetWorth: z.strictObject({ date: accountingDate.optional() }),
  getCategoryTotals: id
    .extend({ from: accountingDate, to: accountingDate })
    .refine(
      ({ from, to }) => from <= to,
      "El inicio del rango debe ser anterior o igual al final.",
    ),
  listOperations: z.strictObject({
    limit: z.number().int().min(1).max(100).optional(),
  }),
  undoOperation: z.strictObject({ id: z.uuid() }),
  registerLoan: z.strictObject({
    direction: z.enum(["given", "received"]),
    counterparty: name,
    amount: positiveAmount,
    currency,
    date: accountingDate.optional(),
    rate: z.string().regex(/^\d{1,3}(?:[.,]\d{1,6})?$/),
    ratePeriod: z.enum(["monthly", "annual"]),
    dueDate: accountingDate.optional(),
    notes: note.optional(),
    accountId: rowId.optional(),
    withoutCash: z.boolean().optional(),
  }),
  payLoan: id.extend({
    accountId: rowId,
    amount: positiveAmount,
    date: accountingDate.optional(),
  }),
  getLoan: id.extend({ date: accountingDate.optional() }),
  listLoans: z.strictObject({
    counterparty: name.optional(),
    status: z.enum(["open", "closed"]).optional(),
    date: accountingDate.optional(),
  }),
};

export type LedgerInput<Key extends keyof typeof ledgerInputs> = z.input<
  (typeof ledgerInputs)[Key]
>;
export type TransactionInput = z.output<typeof transactionInput>;

export function parseLedgerInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input, { error: () => "Valor inválido." });
  if (!result.success)
    throw new Error(
      result.error.issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.map(String).join(".")} — ${issue.message}`
            : issue.message,
        )
        .join(" "),
    );
  return result.data;
}
