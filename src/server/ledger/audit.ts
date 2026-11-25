import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  sql,
  type Insertable,
  type Kysely,
  type Selectable,
  type Transaction,
} from "kysely";
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
  const a = { ...current };
  const b = { ...expected };
  delete a.updated_at;
  delete b.updated_at;
  return isDeepStrictEqual(a, b);
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

  async undo(id: string) {
    const target = await this.db
      .selectFrom("operations")
      .select("seq")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!target) throw new Error(`No existe la operación ${id}.`);
    const undone = await this.db
      .selectFrom("operations")
      .select("id")
      .where("undoes_operation_id", "=", id)
      .executeTakeFirst();
    if (undone)
      throw new Error(`La operación ${id} ya fue deshecha por ${undone.id}.`);

    const log = await this.db
      .selectFrom("audit_log")
      .selectAll()
      .where("operation_id", "=", id)
      .orderBy("id", "desc")
      .execute();
    if (!log.length)
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
      const current = await this.row(table, key);
      const later = await this.laterChange(
        item,
        sameState(current ? snapshot(current) : null, after),
      );
      if (later) conflicts.push(`${table}/${item.row_id} (${later})`);
      changes.push({ table, key, before, after, rowId: item.row_id });
    }
    if (conflicts.length)
      throw new Error(
        `No se puede deshacer ${id}. Filas modificadas y sus operaciones: ${conflicts.join(", ")}.`,
      );
    await this.checkRestoredParents(changes, target.seq);

    for (const { table, key, before, after, rowId } of changes) {
      try {
        if (before === null) await this.delete(table, key);
        else if (after === null) await this.insertRow(table, before);
        else await this.updateRow(table, key, before);
      } catch (error) {
        if (
          [
            "ER_ROW_IS_REFERENCED_2",
            "ER_NO_REFERENCED_ROW_2",
            "ER_DUP_ENTRY",
          ].includes(String(errorCode(error)))
        )
          throw new Error(
            `No se puede restaurar ${table}/${rowId}: hay filas relacionadas o una clave ya ocupada.`,
            { cause: error },
          );
        throw error;
      }
    }
    return { operationId: await this.operation() };
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
        return run(new LedgerWrite(trx, actor, description, undoes));
      });
  } catch (error) {
    if (errorCode(error) === "ER_DUP_ENTRY")
      throw new Error("Ya existe un registro con la misma clave o nombre.", {
        cause: error,
      });
    throw error;
  }
}
