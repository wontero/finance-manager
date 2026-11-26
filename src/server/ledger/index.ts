import {
  actorInput,
  ledgerInputs,
  parseLedgerInput,
  rowId,
  todayLaPaz,
  type LedgerInput,
} from "@finance-manager/core";
import type { Kysely, Transaction } from "kysely";
import type { z } from "zod";
import * as accounts from "./accounts.js";
import * as goals from "./goals.js";
import { utcStamp, writeLedger, type LedgerWrite } from "./audit.js";
import {
  findExchangeRate,
  saveExchangeRate,
  saveOfficialRate,
} from "./metadata.js";
import { ledgerLimits, type LedgerLimits } from "./limits.js";
import * as loans from "./loans.js";
import {
  getAccountTotal,
  getCategoryTotals,
  getCurrencyScales,
  getNetWorth,
  getOperations,
  naturalAmount,
} from "./queries.js";
import type { Actor, ExchangeRate, LedgerDatabase } from "./schema.js";
import * as dashboard from "./dashboard.js";
import * as reports from "./reports.js";
import * as entries from "./transactions.js";
import { userScope } from "./user-scope.js";

export { provisionUser } from "./provision.js";

export function createLedger(
  database: Kysely<unknown>,
  actor: Actor,
  id: string,
  limits: LedgerLimits = ledgerLimits(),
) {
  const userId = parseLedgerInput(rowId, id);
  const db = database
    .withTables<LedgerDatabase>()
    .withPlugin(userScope(userId));
  const writer = parseLedgerInput(actorInput, actor);
  const mutate =
    <Schema extends z.ZodType, Result>(
      schema: Schema,
      description: string,
      run: (write: LedgerWrite, input: z.output<Schema>) => Promise<Result>,
    ) =>
    async (input: z.input<Schema>) => {
      const value = parseLedgerInput(schema, input);
      return writeLedger(db, userId, limits, writer, description, (write) =>
        run(write, value),
      );
    };
  const read = <Result>(
    run: (trx: Transaction<LedgerDatabase>) => Promise<Result>,
  ) => db.transaction().setIsolationLevel("repeatable read").execute(run);
  const saveRate = mutate(
    ledgerInputs.recordExchangeRate,
    "Registrar tipo de cambio",
    (write, { from, to, date, source, rate, ifAbsent }) =>
      saveExchangeRate(
        write,
        from,
        to,
        date ?? todayLaPaz(),
        source,
        rate,
        ifAbsent,
      ),
  );
  type RateInput = LedgerInput<"recordExchangeRate">;
  function recordExchangeRate(
    input: RateInput & { ifAbsent?: undefined },
  ): Promise<{ rate: ExchangeRate; operationId: string }>;
  function recordExchangeRate(input: RateInput): ReturnType<typeof saveRate>;
  function recordExchangeRate(input: RateInput) {
    return saveRate(input);
  }

  return {
    createGoal: mutate(ledgerInputs.createGoal, "Crear meta", goals.createGoal),
    updateGoal: mutate(
      ledgerInputs.updateGoal,
      "Modificar meta",
      goals.updateGoal,
    ),
    archiveGoal: mutate(
      ledgerInputs.archiveGoal,
      "Archivar meta",
      goals.archiveGoal,
    ),
    listGoals(input: LedgerInput<"listGoals"> = {}) {
      const value = parseLedgerInput(ledgerInputs.listGoals, input);
      return read((trx) => goals.listGoals(trx, value));
    },
    createAccount: mutate(
      ledgerInputs.createAccount,
      "Crear cuenta",
      accounts.createAccount,
    ),
    registerLoan: mutate(
      ledgerInputs.registerLoan,
      "Registrar préstamo",
      loans.registerLoan,
    ),
    payLoan: mutate(ledgerInputs.payLoan, "Abonar préstamo", loans.payLoan),
    getLoan(input: LedgerInput<"getLoan">) {
      const value = parseLedgerInput(ledgerInputs.getLoan, input);
      return read((trx) => loans.getLoan(trx, value));
    },
    listLoans(input: LedgerInput<"listLoans"> = {}) {
      const value = parseLedgerInput(ledgerInputs.listLoans, input);
      return read((trx) => loans.listLoans(trx, value));
    },
    createCategory: mutate(
      ledgerInputs.createCategory,
      "Crear categoría",
      accounts.createCategory,
    ),
    renameAccount: mutate(
      ledgerInputs.renameAccount,
      "Renombrar cuenta",
      (write, { id, name }) => accounts.renameAccount(write, id, name),
    ),
    moveAccount: mutate(
      ledgerInputs.moveAccount,
      "Mover cuenta",
      (write, { id, parentId }) => accounts.moveAccount(write, id, parentId),
    ),
    setAccountCustom: mutate(
      ledgerInputs.setAccountCustom,
      "Actualizar campos personalizados de cuenta",
      accounts.setAccountCustom,
    ),
    archiveAccount: mutate(
      ledgerInputs.archiveAccount,
      "Archivar cuenta",
      (write, { id }) => accounts.archiveAccount(write, id),
    ),
    mergeCategories: mutate(
      ledgerInputs.mergeCategories,
      "Fusionar categorías",
      (write, { sourceId, targetId }) =>
        accounts.mergeCategories(write, sourceId, targetId),
    ),
    createTransaction: mutate(
      ledgerInputs.createTransaction,
      "Registrar asiento",
      entries.createEntry,
    ),
    recordExpense: mutate(
      ledgerInputs.recordExpense,
      "Registrar gasto",
      (write, input) => entries.recordCategorized(write, input, "expense"),
    ),
    recordIncome: mutate(
      ledgerInputs.recordIncome,
      "Registrar ingreso",
      (write, input) => entries.recordCategorized(write, input, "income"),
    ),
    transfer: mutate(
      ledgerInputs.transfer,
      "Registrar transferencia",
      entries.transfer,
    ),
    editTransaction: mutate(
      ledgerInputs.editTransaction,
      "Editar asiento",
      entries.editEntry,
    ),
    deleteTransaction: mutate(
      ledgerInputs.deleteTransaction,
      "Borrar asiento",
      (write, { id }) => entries.deleteEntry(write, id),
    ),
    async reconcile(id: string, actualBalance: string, date?: string) {
      const input = parseLedgerInput(ledgerInputs.reconcile, {
        id,
        actualBalance,
        date,
      });
      return writeLedger(
        db,
        userId,
        limits,
        writer,
        "Conciliar cuenta",
        (write) => accounts.reconcile(write, input),
      );
    },
    recordExchangeRate,
    recordOfficialRate: mutate(
      ledgerInputs.recordExchangeRate.omit({ ifAbsent: true }),
      "Registrar tipo de cambio oficial",
      (write, { from, to, date, source, rate }) =>
        saveOfficialRate(write, from, to, date ?? todayLaPaz(), source, rate),
    ),
    defineCustomField: mutate(
      ledgerInputs.defineCustomField,
      "Definir campo personalizado",
      async (write, input) => {
        const row = await write.insert("custom_field_definitions", {
          entity: input.entity,
          key: input.key,
          label: input.label,
          type: input.type,
          options:
            input.type === "option" ? JSON.stringify(input.options) : null,
        });
        return { id: row.id, operationId: await write.operation() };
      },
    ),
    archiveCustomField: mutate(
      ledgerInputs.archiveCustomField,
      "Archivar campo personalizado",
      async (write, { id }) => {
        const active = await write.db
          .selectFrom("custom_field_definitions")
          .select("id")
          .where("id", "=", id)
          .where("archived_at", "is", null)
          .executeTakeFirst();
        if (!active)
          throw new Error(
            `El campo personalizado ${id} no existe o está archivado.`,
          );
        await write.update(
          "custom_field_definitions",
          { id },
          { archived_at: utcStamp() },
        );
        return { id, operationId: await write.operation() };
      },
    ),
    async importBatch(
      input: LedgerInput<"batch">,
      options: LedgerInput<"batchOptions">,
    ) {
      const batch = parseLedgerInput(ledgerInputs.batch, input);
      const { duplicates } = parseLedgerInput(
        ledgerInputs.batchOptions,
        options,
      );
      return writeLedger(
        db,
        userId,
        limits,
        writer,
        "Importar lote de asientos",
        (write) => entries.importEntries(write, batch, duplicates),
      );
    },
    async undoOperation(operationId: string) {
      const { id } = parseLedgerInput(ledgerInputs.undoOperation, {
        id: operationId,
      });
      return writeLedger(
        db,
        userId,
        limits,
        writer,
        `Deshacer operación ${id}`,
        (write) => write.undo(id),
        id,
      );
    },
    async getExchangeRate(input: LedgerInput<"getExchangeRate">) {
      const {
        from,
        to,
        date = todayLaPaz(),
      } = parseLedgerInput(ledgerInputs.getExchangeRate, input);
      const rate = await read((trx) => findExchangeRate(trx, from, to, date));
      if (!rate)
        throw new Error(`Sin tipo de cambio de ${from} a ${to} al ${date}.`);
      return rate;
    },
    async getBalance(input: LedgerInput<"getBalance">) {
      const { id, date = todayLaPaz() } = parseLedgerInput(
        ledgerInputs.getBalance,
        input,
      );
      return read(async (trx) => {
        const account = await entries.accountById(trx, id);
        if (!account.currency)
          throw new Error("Se requiere una cuenta de moneda fija.");
        return {
          amount: naturalAmount(
            account.kind,
            await getAccountTotal(trx, id, date),
          ),
          currency: account.currency,
        };
      });
    },
    async getNetWorth(input: LedgerInput<"getNetWorth"> = {}) {
      const { date = todayLaPaz() } = parseLedgerInput(
        ledgerInputs.getNetWorth,
        input,
      );
      return read((trx) => getNetWorth(trx, date));
    },
    async getCategoryTotals(input: LedgerInput<"getCategoryTotals">) {
      const { id, from, to } = parseLedgerInput(
        ledgerInputs.getCategoryTotals,
        input,
      );
      return read((trx) => getCategoryTotals(trx, id, from, to));
    },
    async listOperations(
      input: LedgerInput<"listOperations"> = {},
      page?: {
        limit: number;
        before?: string;
      },
    ) {
      const { limit = 20 } = parseLedgerInput(
        ledgerInputs.listOperations,
        input,
      );
      return read((trx) =>
        getOperations(trx, page?.limit ?? limit, page?.before),
      );
    },
    dashboardAccounts: () => read(dashboard.dashboardAccounts),
    dashboardSummary: (month: string) =>
      read((trx) => dashboard.dashboardSummary(trx, month)),
    dashboardReports: (from: string, to: string) =>
      read((trx) => dashboard.dashboardReports(trx, from, to)),
    dashboardTransactions: (
      input: Parameters<typeof dashboard.dashboardTransactions>[1],
    ) => read((trx) => dashboard.dashboardTransactions(trx, input)),
    dashboardOperations: (limit: number, before?: string) =>
      read((trx) => dashboard.dashboardOperations(trx, userId, limit, before)),
    getAccountTree: (includeArchived: boolean) =>
      reports.getAccountTree(db, includeArchived),
    listAccountBalances: (ids: string[], date: string) =>
      read((trx) => reports.getAccountBalances(trx, ids, date)),
    getCurrencyScales: () => getCurrencyScales(db),
    getPeriodSummary: (input: Parameters<typeof reports.getPeriodSummary>[1]) =>
      read((trx) => reports.getPeriodSummary(trx, input)),
    findTransactions: (input: Parameters<typeof reports.findTransactions>[1]) =>
      read((trx) => reports.findTransactions(trx, input)),
    listMetadata: (input: Parameters<typeof reports.listMetadata>[1]) =>
      reports.listMetadata(db, input),
  };
}
