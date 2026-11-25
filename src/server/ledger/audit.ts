import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  sql,
  type Insertable,
  type Kysely,
  type Selectable,
  type Transaction,
} from "kysely";
import { archivedAccountWithBalance } from "./queries.js";
import { systemAccounts, type Actor, type LedgerDatabase } from "./schema.js";

const primaryKeys = {
  accounts: ["id"],
  transactions: ["id"],
  postings: ["id"],
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

export function utcStamp() {
  return new Date().toISOString().slice(0, 23).replace("T", " ");
}

export class LedgerWrite {
  operationId: string | null = null;

  constructor(
    readonly db: Transaction<LedgerDatabase>,
    private readonly actor: Actor,
    private readonly description: string,
    private readonly undoes: string | null,
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
        operation_id: await this.operation(),
        table_name: table,
        row_id: id,
        action,
        before: before ? JSON.stringify(before) : null,
        after: after ? JSON.stringify(after) : null,
      })
      .execute();
  }

  async operation() {
    if (this.operationId === null) {
      const id = randomUUID();
      await this.db
        .insertInto("operations")
        .values({
          id,
          actor: this.actor,
          description: this.description,
          undoes_operation_id: this.undoes,
        })
        .execute();
      this.operationId = id;
    }
    return this.operationId;
  }

  private async row<T extends Table>(table: T, key: Key<T>) {
    const {
      rows: [row],
    } = await sql<Row<T>>`SELECT * FROM ${sql.table(table)}
      WHERE ${where(table, key)} FOR UPDATE`.execute(this.db);
    return row;
  }

  private async insertRow<T extends Table>(table: T, values: SqlValues) {
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
    values: Insertable<LedgerDatabase[T]>,
  ) {
    return this.insertRow(table, values as SqlValues);
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
    )} WHERE ${where(table, key)}`.execute(this.db);
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
    values: Partial<Row<T>>,
  ) {
    return this.updateRow(table, key, values as SqlValues);
  }

  async delete<T extends Table>(table: T, key: Key<T>) {
    const before = await this.row(table, key);
    if (!before) throw new Error(`No existe ${table}/${rowId(table, key)}.`);
    await sql`DELETE FROM ${sql.table(table)} WHERE ${where(table, key)}`.execute(
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
      throw new Error(
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
              WHERE ${ref} = ${rowId} AND ${rowKey} = a.row_id)`,
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
    if (!target) throw new Error(`No existe la operación ${id}.`);
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
      throw new Error(
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
    if (!log.length && target.undoes_operation_id === null)
      throw new Error(`La operación ${id} no tiene cambios en la bitácora.`);
    const conflicts: string[] = [];
    const changes: Reversal[] = [];
    for (const item of log) {
      if (!Object.hasOwn(primaryKeys, item.table_name))
        throw new Error(`No se puede deshacer la tabla ${item.table_name}.`);
      const table = item.table_name as Table;
      const before = parseSnapshot(item.before);
      const after = parseSnapshot(item.after);
      const key = (after ?? before) as Key<Table>;
      if (!key || rowId(table, key) !== item.row_id)
        throw new Error(
          `La bitácora tiene una clave inválida en ${table}/${item.row_id}.`,
        );
      const row = await this.row(table, key);
      const current = row ? snapshot(row) : null;
      if (after === null && sameState(current, before)) continue;
      const later = await this.laterChange(item, sameState(current, after));
      if (later) conflicts.push(`${table}/${item.row_id} (${later})`);
      changes.push({ table, key, before, after, rowId: item.row_id });
    }
    if (conflicts.length)
      throw new Error(
        `No se puede deshacer ${id}. Filas modificadas y sus operaciones: ${conflicts.join(", ")}.`,
      );
    await this.checkRestoredParents(changes, target.seq);

    const retainedTags: Row<"tags">[] = [];
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
          const operation = await this.foreignKeyOperation(
            change,
            target.seq,
            code,
          );
          const detail = operation
            ? `Operación posterior: ${operation}.`
            : "No consta una operación posterior en la bitácora.";
          throw new Error(
            `No se puede restaurar ${table}/${rowId}: hay un conflicto con una fila relacionada. ${detail}`,
            { cause: error },
          );
        }
        if (code === "ER_DUP_ENTRY")
          throw new Error(
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
  actor: Actor,
  description: string,
  run: (write: LedgerWrite) => Promise<T>,
  undoes: string | null = null,
) {
  try {
    return await db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        // La raíz de sistema serializa las decisiones que abarcan varias filas.
        const root = await trx
          .selectFrom("accounts")
          .select("is_system")
          .where("active_parent_id", "=", "0")
          .where("name", "=", systemAccounts.income)
          .forUpdate()
          .executeTakeFirst();
        if (!root?.is_system)
          throw new Error("Falta la raíz contable Ingresos.");
        const write = new LedgerWrite(trx, actor, description, undoes);
        const result = await run(write);
        if (write.operationId !== null) {
          const account = await archivedAccountWithBalance(trx);
          if (account)
            throw new Error(
              `La cuenta archivada "${account.name}" debe tener saldo cero. Desarchívala o deshaz primero el archivado.`,
            );
        }
        return result;
      });
  } catch (error) {
    if (errorCode(error) === "ER_DUP_ENTRY")
      throw new Error("Ya existe un registro con la misma clave o nombre.", {
        cause: error,
      });
    throw error;
  }
}
