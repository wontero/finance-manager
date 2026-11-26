import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { todayLaPaz } from "@finance-manager/core";
import {
  sql,
  type Insertable,
  type Kysely,
  type Selectable,
  type Transaction,
} from "kysely";
import { archivedAccountWithBalance, getAccountTotal } from "./queries.js";
import {
  systemAccounts,
  type Actor,
  type ExchangeRate,
  type LedgerDatabase,
} from "./schema.js";
import type { LedgerLimits } from "./limits.js";

const primaryKeys = {
  accounts: ["id"],
  transactions: ["id"],
  postings: ["id"],
  loans: ["id"],
  tags: ["id"],
  transaction_tags: ["transaction_id", "tag_id"],
  custom_field_definitions: ["id"],
  exchange_rates: ["from_currency", "to_currency", "date", "source"],
} as const;

type Table = keyof typeof primaryKeys;
type Row<T extends Table> = Selectable<LedgerDatabase[T]>;
type Key<T extends Table> = Record<(typeof primaryKeys)[T][number], string>;
type SqlValues = Record<string, string | number | null>;
type Snapshot = SqlValues;
type Action = LedgerDatabase["audit_log"]["action"];
type Reversal = {
  table: Table;
  key: Key<Table>;
  before: Snapshot | null;
  after: Snapshot | null;
  rowId: string;
};
const foreignKeys = [
  ["accounts", "parent_id", "accounts"],
  ["postings", "account_id", "accounts"],
  ["postings", "transaction_id", "transactions"],
  ["loans", "account_id", "accounts"],
  ["transaction_tags", "transaction_id", "transactions"],
  ["transaction_tags", "tag_id", "tags"],
] as const; // Solo referencias a filas que el dominio puede borrar al deshacer.

function where<T extends Table>(table: T, key: Key<T>) {
  return sql.join(
    primaryKeys[table].map(
      (column) => sql`${sql.ref(column)} = ${(key as SqlValues)[column]}`,
    ),
    sql` AND `,
  );
}

function rowId<T extends Table>(table: T, row: Key<T>) {
  return primaryKeys[table]
    .map((column) => (row as SqlValues)[column])
    .join("/");
}

function snapshot(row: object) {
  const values = { ...row } as Snapshot;
  delete values.active_parent_id;
  delete values.user_id;
  delete values.owner_key;
  delete values.owner_source;
  if ("from_currency" in values) delete values.id;
  return values;
}

function sameState(current: Snapshot | null, expected: Snapshot | null) {
  if (!current || !expected) return current === expected;
  return Object.entries(expected).every(
    ([column, value]) =>
      column === "updated_at" || isDeepStrictEqual(current[column], value),
  );
}

function parseSnapshot(value: string | null) {
  return value === null ? null : (JSON.parse(value) as Snapshot);
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function uniqueKeys(table: Table, row: Snapshot | null): SqlValues[] {
  if (!row) return [];
  switch (table) {
    case "accounts": {
      const keys: SqlValues[] = [];
      if (row.archived_at === null)
        keys.push({ active_parent_id: row.parent_id ?? "0", name: row.name });
      if (row.loan_interest != null)
        keys.push({ loan_interest: row.loan_interest });
      return keys;
    }
    case "tags":
      return [{ name: row.name }];
    case "custom_field_definitions":
      return [{ entity: row.entity, key: row.key }];
    case "loans":
      return [{ account_id: row.account_id }];
    default:
      return [];
  }
}

export function utcStamp(now = new Date()) {
  return now.toISOString().slice(0, 23).replace("T", " ");
}

export class UndoConflict extends Error {}

export class LedgerWrite {
  operationId: string | null = null;

  constructor(
    readonly db: Transaction<LedgerDatabase>,
    readonly userId: string,
    private readonly actor: Actor,
    private readonly description: string,
    private readonly undoes: string | null,
    private readonly limits?: LedgerLimits,
  ) {}

  private async record(
    table: Table,
    id: string,
    action: Action,
    before: Snapshot | null,
    after: Snapshot | null,
  ) {
    await this.db
      .insertInto("audit_log")
      .values({
        user_id: this.userId,
        operation_id: await this.operation(),
        table_name: table,
        row_id: id,
        action,
        before: before ? JSON.stringify(before) : null,
        after: after ? JSON.stringify(after) : null,
      })
      .execute();
  }

  async recordOfficialRate(rate: ExchangeRate) {
    await this.record(
      "exchange_rates",
      "oficial/" + rowId("exchange_rates", rate),
      "insert",
      null,
      { ...rate, user_id: null },
    );
    return this.operation();
  }

  async operation() {
    if (this.operationId === null) {
      const id = randomUUID();
      await this.db
        .insertInto("operations")
        .values({
          id,
          user_id: this.userId,
          actor: this.actor,
          description: this.description,
          undoes_operation_id: this.undoes,
        })
        .execute();
      this.operationId = id;
    }
    return this.operationId;
  }

  private async row<T extends Table>(table: T, key: Key<T>, lock = true) {
    const {
      rows: [row],
    } = await sql<Row<T>>`SELECT * FROM ${sql.table(table)}
      WHERE user_id = ${this.userId} AND ${where(table, key)} ${lock ? sql`FOR UPDATE` : sql``}`.execute(
      this.db,
    );
    return row;
  }

  private async insertRow<T extends Table>(table: T, values: SqlValues) {
    values = { ...values, user_id: this.userId };
    const keys = Object.keys(values);
    const { insertId } = await sql`INSERT INTO ${sql.table(table)}
      (${sql.join(keys.map((key) => sql.ref(key)))})
      VALUES (${sql.join(keys.map((key) => values[key]))})`.execute(this.db);
    const key =
      Object.hasOwn(values, "id") || primaryKeys[table][0] !== "id"
        ? (values as Key<T>)
        : ({ id: insertId?.toString() } as Key<T>);
    const after = await this.row(table, key);
    if (!after)
      throw new Error(`No se encontró la fila recién insertada en ${table}.`);
    await this.record(
      table,
      rowId(table, key),
      "insert",
      null,
      snapshot(after),
    );
    return after;
  }

  async insert<T extends Table>(
    table: T,
    values: Omit<Insertable<LedgerDatabase[T]>, "user_id">,
  ) {
    let fields = values as SqlValues;
    if (
      this.limits &&
      (table === "accounts" || table === "tags" || table === "transactions")
    ) {
      const now = new Date();
      const start = todayLaPaz(now) + " 04:00:00";
      const limit =
        table === "transactions"
          ? this.limits.dailyTransactions
          : table === "accounts"
            ? this.limits.accounts
            : this.limits.tags;
      const withinDay =
        table === "transactions"
          ? sql`AND created_at >= ${start} AND created_at < DATE_ADD(${start}, INTERVAL 1 DAY)`
          : sql``;
      const {
        rows: [row],
      } = await sql<{
        count: string;
      }>`SELECT COUNT(*) AS count FROM ${sql.table(table)}
        WHERE user_id = ${this.userId} ${withinDay}`.execute(this.db);
      if (Number(row.count) >= limit) {
        const label =
          table === "transactions"
            ? "movimientos nuevos por día"
            : table === "accounts"
              ? "cuentas y categorías"
              : "etiquetas";
        throw new Error(
          `Se alcanzó el límite de ${limit} ${label} por usuario.`,
        );
      }
      if (table === "transactions")
        fields = { ...fields, created_at: utcStamp(now) };
    }
    return this.insertRow(table, fields);
  }

  private async updateRow<T extends Table>(
    table: T,
    key: Key<T>,
    values: SqlValues,
  ) {
    const before = await this.row(table, key);
    if (!before) throw new Error(`No existe ${table}/${rowId(table, key)}.`);
    await sql`UPDATE ${sql.table(table)} SET ${sql.join(
      Object.entries(values).map(
        ([column, value]) => sql`${sql.ref(column)} = ${value}`,
      ),
    )} WHERE user_id = ${this.userId} AND ${where(table, key)}`.execute(
      this.db,
    );
    const after = await this.row(table, key);
    if (!after)
      throw new Error(`No se encontró la fila actualizada en ${table}.`);
    await this.record(
      table,
      rowId(table, key),
      "update",
      snapshot(before),
      snapshot(after),
    );
    return after;
  }

  async update<T extends Table>(
    table: T,
    key: Key<T>,
    values: Partial<Omit<Row<T>, "user_id">>,
  ) {
    return this.updateRow(table, key, values as SqlValues);
  }

  async delete<T extends Table>(table: T, key: Key<T>) {
    const before = await this.row(table, key);
    if (!before) throw new Error(`No existe ${table}/${rowId(table, key)}.`);
    await sql`DELETE FROM ${sql.table(table)} WHERE user_id = ${this.userId} AND ${where(table, key)}`.execute(
      this.db,
    );
    await this.record(
      table,
      rowId(table, key),
      "delete",
      snapshot(before),
      null,
    );
  }

  private async laterChange(
    item: { table_name: string; row_id: string; id: string },
    matches: boolean,
  ) {
    const later = await this.db
      .selectFrom("audit_log as a")
      .innerJoin("operations as o", "o.id", "a.operation_id")
      .select([
        "a.before",
        "a.after",
        "a.operation_id",
        "o.undoes_operation_id",
      ])
      .where("a.table_name", "=", item.table_name)
      .where("a.row_id", "=", item.row_id)
      .where("a.id", ">", item.id)
      .orderBy("a.id", "desc")
      .execute();
    if (!matches)
      return later[0]?.operation_id ?? "cambio sin bitácora posterior";

    // Un deshacer vigente cancela el cambio original para esta fila.
    const canceled = new Set<string>();
    for (const entry of later) {
      if (canceled.has(entry.operation_id)) continue;
      if (entry.undoes_operation_id) canceled.add(entry.undoes_operation_id);
      else if (
        !sameState(parseSnapshot(entry.before), parseSnapshot(entry.after))
      )
        return entry.operation_id;
    }
  }

  private async checkRestoredParents(changes: Reversal[], seq: string) {
    const moved = changes.filter(
      ({ table, before, after }) =>
        table === "accounts" && before && before.parent_id !== after?.parent_id,
    );
    if (!moved.length) return;
    const accounts = await this.db
      .selectFrom("accounts")
      .select(["id", "parent_id"])
      .execute();
    const parents = new Map(
      accounts.map(({ id, parent_id }) => [id, parent_id]),
    );
    for (const change of changes) {
      if (change.table !== "accounts") continue;
      if (change.before === null) parents.delete(change.rowId);
      else parents.set(change.rowId, change.before.parent_id as string | null);
    }
    for (const { rowId } of moved) {
      const seen = new Set<string>();
      let parent: string | null = rowId;
      while (parent !== null && !seen.has(parent)) {
        seen.add(parent);
        parent = parents.get(parent) ?? null;
      }
      if (parent === null) continue;
      const later = await this.db
        .selectFrom("audit_log as a")
        .innerJoin("operations as o", "o.id", "a.operation_id")
        .select("a.operation_id")
        .where("a.table_name", "=", "accounts")
        .where("a.row_id", "in", [...seen])
        .where("o.seq", ">", seq)
        .orderBy("a.id", "desc")
        .executeTakeFirst();
      throw new UndoConflict(
        `No se puede restaurar accounts/${rowId}: crearía un ciclo con las cuentas ${[...seen].join(", ")}.${later ? ` Operación posterior: ${later.operation_id}.` : ""}`,
      );
    }
  }

  private async foreignKeyOperation(
    { table, before, rowId }: Reversal,
    seq: string,
    code: "ER_ROW_IS_REFERENCED_2" | "ER_NO_REFERENCED_ROW_2",
  ) {
    let audit = this.db
      .selectFrom("audit_log as a")
      .innerJoin("operations as o", "o.id", "a.operation_id")
      .select(["a.operation_id", "a.action"])
      .where("o.seq", ">", seq)
      .orderBy("a.id", "desc")
      .limit(1);
    if (this.operationId !== null)
      audit = audit.where("a.operation_id", "!=", this.operationId);
    for (const [child, column, parent] of foreignKeys) {
      if (code === "ER_ROW_IS_REFERENCED_2" && parent === table) {
        const ref = sql.ref(`r.${column}`);
        const path = `$.${column}`;
        const rowKey = sql`CONCAT_WS('/', ${sql.join(primaryKeys[child].map((key) => sql.ref(`r.${key}`)))})`;
        const blocker = await audit
          .where(
            sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(child)} AS r
              WHERE r.user_id = ${this.userId} AND ${ref} = ${rowId} AND ${rowKey} = a.row_id)`,
          )
          .where("a.table_name", "=", child)
          .where(sql<boolean>`JSON_VALUE(a.after, ${path}) = ${rowId}`)
          .where(
            sql<boolean>`NOT (JSON_VALUE(a.before, ${path}) <=> JSON_VALUE(a.after, ${path}))`,
          )
          .executeTakeFirst();
        if (blocker) return blocker.operation_id;
      }
      if (code === "ER_NO_REFERENCED_ROW_2" && child === table) {
        const id = before?.[column];
        if (typeof id !== "string" || (await this.row(parent, { id })))
          continue;
        const removal = await audit
          .where("a.table_name", "=", parent)
          .where("a.row_id", "=", id)
          .executeTakeFirst();
        if (removal?.action === "delete") return removal.operation_id;
      }
    }
  }

  async undo(id: string) {
    const target = await this.db
      .selectFrom("operations")
      .select(["seq", "undoes_operation_id"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!target) throw new UndoConflict(`No existe la operación ${id}.`);
    const reversalOf = (operationId: string) =>
      this.db
        .selectFrom("operations")
        .select("id")
        .where("undoes_operation_id", "=", operationId)
        .executeTakeFirst();
    const direct = await reversalOf(id);
    if (direct) {
      let latest = direct.id;
      let undone = true;
      for (
        let next = await reversalOf(latest);
        next;
        next = await reversalOf(latest)
      ) {
        latest = next.id;
        undone = !undone;
      }
      throw new UndoConflict(
        undone
          ? `La operación ${id} ya fue deshecha por ${latest}.`
          : `La operación ${id} ya fue rehecha. Para revertirla, usa deshacer ${latest}.`,
      );
    }

    const log = await this.db
      .selectFrom("audit_log")
      .selectAll()
      .where("operation_id", "=", id)
      .orderBy("id", "desc")
      .execute();
    const changes = await this.planUndo(id, target, log, true);
    return this.applyUndo(changes, target.seq);
  }

  private async hasDuplicateKey(
    { table, rowId, before, after }: Reversal,
    earlier: string[],
  ) {
    const current = uniqueKeys(table, after);
    for (const key of uniqueKeys(table, before)) {
      if (current.some((value) => isDeepStrictEqual(value, key))) continue;
      // Las filas ya restauradas tienen las claves que convivían con esta en la bitácora.
      const { rows } = await sql`SELECT id FROM ${sql.table(table)}
        WHERE user_id = ${this.userId} AND id NOT IN (${sql.join([rowId, ...earlier])})
        AND ${sql.join(
          Object.entries(key).map(
            ([column, value]) => sql`${sql.ref(column)} = ${value}`,
          ),
          sql` AND `,
        )}
        LIMIT 1`.execute(this.db);
      if (rows.length) return true;
    }
    return false;
  }

  private async restoresArchivedBalance(changes: Reversal[]) {
    // Proyecta el saldo sobre la lectura de Actividad sin ejecutar la reversión.
    const transactions = new Map<string, Snapshot | null>();
    const accounts = new Map<string, Snapshot | null>();
    const postings: Reversal[] = [];
    const transactionIds = new Set<string>();
    for (const change of changes) {
      const { table, rowId, before, after } = change;
      if (table === "accounts") accounts.set(rowId, before);
      if (
        table === "transactions" &&
        before?.deleted_at !== after?.deleted_at
      ) {
        transactions.set(rowId, before);
        transactionIds.add(rowId);
      }
      if (table === "postings") {
        postings.push(change);
        if (before) transactionIds.add(before.transaction_id as string);
        if (after) transactionIds.add(after.transaction_id as string);
      }
    }

    const deltas = new Map<string, bigint>();
    if (transactionIds.size) {
      const active = new Set(
        (
          await this.db
            .selectFrom("transactions")
            .select("id")
            .where("id", "in", [...transactionIds])
            .where("deleted_at", "is", null)
            .execute()
        ).map(({ id }) => id),
      );
      const restoredActive = (id: string) =>
        transactions.has(id)
          ? transactions.get(id)?.deleted_at === null
          : active.has(id);
      const add = (accountId: string, amount: bigint) => {
        deltas.set(accountId, (deltas.get(accountId) ?? 0n) + amount);
      };

      const changedPostings = new Set(postings.map(({ rowId }) => rowId));
      if (transactions.size) {
        const members = await this.db
          .selectFrom("postings")
          .select(["id", "transaction_id", "account_id", "amount"])
          .where("transaction_id", "in", [...transactions.keys()])
          .execute();
        for (const posting of members) {
          if (changedPostings.has(posting.id)) continue;
          if (active.has(posting.transaction_id))
            add(posting.account_id, -BigInt(posting.amount));
          if (restoredActive(posting.transaction_id))
            add(posting.account_id, BigInt(posting.amount));
        }
      }
      for (const { before, after } of postings) {
        if (after && active.has(after.transaction_id as string))
          add(after.account_id as string, -BigInt(after.amount!));
        if (before && restoredActive(before.transaction_id as string))
          add(before.account_id as string, BigInt(before.amount!));
      }
    }

    const ids = new Set([...accounts.keys(), ...deltas.keys()]);
    if (!ids.size) return false;
    const current = await this.db
      .selectFrom("accounts")
      .select(["id", "kind", "archived_at"])
      .where("id", "in", [...ids])
      .execute();
    const currentById = new Map(
      current.map((account) => [account.id, account]),
    );
    for (const id of ids) {
      const account = accounts.has(id) ? accounts.get(id) : currentById.get(id);
      if (
        account &&
        account.archived_at != null &&
        (account.kind === "asset" || account.kind === "liability") &&
        (await getAccountTotal(this.db, id)) + (deltas.get(id) ?? 0n) !== 0n
      )
        return true;
    }
    return false;
  }

  async canUndo(
    entry: Selectable<LedgerDatabase["operations"]>,
    log: Selectable<LedgerDatabase["audit_log"]>[],
  ) {
    try {
      const changes = await this.planUndo(entry.id, entry, log, false);
      const restored = new Map(
        changes.map(({ table, rowId, before }) => [
          table + "/" + rowId,
          before,
        ]),
      );
      const earlier = new Map<Table, string[]>();
      for (const change of changes) {
        const siblings = earlier.get(change.table) ?? [];
        if (await this.hasDuplicateKey(change, siblings)) return false;
        siblings.push(change.rowId);
        earlier.set(change.table, siblings);
        for (const [child, column, parent] of foreignKeys) {
          if (
            change.table === parent &&
            change.before === null &&
            parent !== "tags"
          ) {
            const { rows } =
              await sql<SqlValues>`SELECT * FROM ${sql.table(child)}
              WHERE user_id = ${this.userId} AND ${sql.ref(column)} = ${change.rowId}`.execute(
                this.db,
              );
            if (
              rows.some((row) => {
                const key =
                  child + "/" + rowId(child, row as Key<typeof child>);
                return (
                  !restored.has(key) ||
                  restored.get(key)?.[column] === change.rowId
                );
              })
            )
              return false;
          }
          const referenced = change.before?.[column];
          if (change.table === child && typeof referenced === "string") {
            const key = parent + "/" + referenced;
            if (
              restored.has(key)
                ? !restored.get(key)
                : !(await this.row(parent, { id: referenced }, false))
            )
              return false;
          }
        }
      }
      return !(await this.restoresArchivedBalance(changes));
    } catch (error) {
      if (error instanceof UndoConflict) return false;
      throw error;
    }
  }

  private async planUndo(
    id: string,
    target: Pick<
      Selectable<LedgerDatabase["operations"]>,
      "seq" | "undoes_operation_id"
    >,
    log: Selectable<LedgerDatabase["audit_log"]>[],
    lock: boolean,
  ) {
    if (!log.length && target.undoes_operation_id === null)
      throw new UndoConflict(
        `La operación ${id} no tiene cambios en la bitácora.`,
      );
    const conflicts: string[] = [];
    const changes: Reversal[] = [];
    for (const item of log) {
      if (!Object.hasOwn(primaryKeys, item.table_name))
        throw new UndoConflict(
          `No se puede deshacer la tabla ${item.table_name}.`,
        );
      const table = item.table_name as Table;
      const before = parseSnapshot(item.before);
      const after = parseSnapshot(item.after);
      if (table === "exchange_rates" && after?.user_id === null)
        throw new UndoConflict(
          "El tipo de cambio oficial compartido no se puede deshacer.",
        );
      const key = (after ?? before) as Key<Table>;
      if (!key || rowId(table, key) !== item.row_id)
        throw new UndoConflict(
          `La bitácora tiene una clave inválida en ${table}/${item.row_id}.`,
        );
      const row = await this.row(table, key, lock);
      const current = row ? snapshot(row) : null;
      const alreadyRestored = after === null && sameState(current, before);
      const later = await this.laterChange(
        item,
        alreadyRestored || sameState(current, after),
      );
      if (later) conflicts.push(`${table}/${item.row_id} (${later})`);
      else if (!alreadyRestored)
        changes.push({ table, key, before, after, rowId: item.row_id });
    }
    if (conflicts.length)
      throw new UndoConflict(
        `No se puede deshacer ${id}. Filas modificadas y sus operaciones: ${conflicts.join(", ")}.`,
      );
    await this.checkRestoredParents(changes, target.seq);
    return changes;
  }

  private async applyUndo(changes: Reversal[], seq: string) {
    const retainedTags: Omit<Row<"tags">, "user_id">[] = [];
    for (const change of changes) {
      const { table, key, before, after, rowId } = change;
      try {
        if (before === null) await this.delete(table, key);
        else if (after === null) await this.insertRow(table, before);
        else await this.updateRow(table, key, before);
      } catch (error) {
        const code = errorCode(error);
        if (
          table === "tags" &&
          before === null &&
          code === "ER_ROW_IS_REFERENCED_2"
        ) {
          const tag = await this.row("tags", { id: rowId });
          if (tag) {
            retainedTags.push({ id: tag.id, name: tag.name });
            continue;
          }
        }
        if (
          code === "ER_ROW_IS_REFERENCED_2" ||
          code === "ER_NO_REFERENCED_ROW_2"
        ) {
          const operation = await this.foreignKeyOperation(change, seq, code);
          const detail = operation
            ? `Operación posterior: ${operation}.`
            : "No consta una operación posterior en la bitácora.";
          throw new UndoConflict(
            `No se puede restaurar ${table}/${rowId}: hay un conflicto con una fila relacionada. ${detail}`,
            { cause: error },
          );
        }
        if (code === "ER_DUP_ENTRY")
          throw new UndoConflict(
            `No se puede restaurar ${table}/${rowId}: la clave ya está ocupada.`,
            { cause: error },
          );
        throw error;
      }
    }
    return { operationId: await this.operation(), retainedTags };
  }
}

export async function writeLedger<T>(
  db: Kysely<LedgerDatabase>,
  userId: string,
  limits: LedgerLimits,
  actor: Actor,
  description: string,
  run: (write: LedgerWrite) => Promise<T>,
  undoes: string | null = null,
) {
  const Conflict = undoes === null ? Error : UndoConflict;
  try {
    return await db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        // La raíz de sistema del usuario serializa sus decisiones sobre varias filas.
        const root = await trx
          .selectFrom("accounts")
          .select("is_system")
          .where("user_id", "=", userId)
          .where("active_parent_id", "=", "0")
          .where("name", "=", systemAccounts.income)
          .forUpdate()
          .executeTakeFirst();
        if (!root?.is_system)
          throw new Error("Falta la raíz contable Ingresos.");
        const write = new LedgerWrite(
          trx,
          userId,
          actor,
          description,
          undoes,
          limits,
        );
        const result = await run(write);
        if (write.operationId !== null) {
          const account = await archivedAccountWithBalance(trx);
          if (account)
            throw new Conflict(
              `La cuenta archivada "${account.name}" debe tener saldo cero. Desarchívala o deshaz primero el archivado.`,
            );
        }
        return result;
      });
  } catch (error) {
    if (errorCode(error) === "ER_DUP_ENTRY")
      throw new Conflict("Ya existe un registro con la misma clave o nombre.", {
        cause: error,
      });
    throw error;
  }
}
