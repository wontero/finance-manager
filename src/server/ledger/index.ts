import {
  actorInput,
  ledgerInputs,
  parseLedgerInput,
  todayLaPaz,
  type LedgerInput,
} from "@finance-manager/core";
import type { Kysely } from "kysely";
import type { z } from "zod";
import * as accounts from "./accounts.js";
import { utcStamp, writeLedger, type LedgerWrite } from "./audit.js";
import { findExchangeRate, saveExchangeRate } from "./metadata.js";
import {
  getAccountTotal,
  getCategoryTotals,
  getNetWorth,
  getOperations,
  naturalAmount,
} from "./queries.js";
import type { Actor, LedgerDatabase } from "./schema.js";
import * as reports from "./reports.js";
import * as entries from "./transactions.js";

export function createLedger(database: Kysely<unknown>, actor: Actor) {
  const db = database.withTables<LedgerDatabase>();
  const writer = parseLedgerInput(actorInput, actor);
  const mutate =
    <Schema extends z.ZodType, Result>(
      schema: Schema,
      description: string,
      run: (write: LedgerWrite, input: z.output<Schema>) => Promise<Result>,
    ) =>
    async (input: z.input<Schema>) => {
      const value = parseLedgerInput(schema, input);
      return writeLedger(db, writer, description, (write) => run(write, value));
    };
  const read = <Result>(
    run: (trx: Kysely<LedgerDatabase>) => Promise<Result>,
  ) => db.transaction().setIsolationLevel("repeatable read").execute(run);

  return {
    createAccount: mutate(
      ledgerInputs.createAccount,
      "Crear cuenta",
      accounts.createAccount,
    ),
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
      return writeLedger(db, writer, "Conciliar cuenta", (write) =>
        accounts.reconcile(write, input),
      );
    },
    recordExchangeRate: mutate(
      ledgerInputs.recordExchangeRate,
      "Registrar tipo de cambio",
      (write, { from, to, date, source, rate }) =>
        saveExchangeRate(write, from, to, date ?? todayLaPaz(), source, rate),
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
      return writeLedger(db, writer, "Importar lote de asientos", (write) =>
        entries.importEntries(write, batch, duplicates),
      );
    },
    async undoOperation(operationId: string) {
      const { id } = parseLedgerInput(ledgerInputs.undoOperation, {
        id: operationId,
      });
      return writeLedger(
        db,
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
      const rate = await findExchangeRate(db, from, to, date);
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
    getAccountTree: (includeArchived: boolean) =>
      reports.getAccountTree(db, includeArchived),
    listAccountBalances: (ids: string[], date: string) =>
      read((trx) => reports.getAccountBalances(trx, ids, date)),
    getPeriodSummary: (input: Parameters<typeof reports.getPeriodSummary>[1]) =>
      read((trx) => reports.getPeriodSummary(trx, input)),
    findTransactions: (input: Parameters<typeof reports.findTransactions>[1]) =>
      read((trx) => reports.findTransactions(trx, input)),
    listMetadata: (input: Parameters<typeof reports.listMetadata>[1]) =>
      reports.listMetadata(db, input),
  };
}
