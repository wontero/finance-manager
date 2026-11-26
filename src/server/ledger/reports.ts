import { parseAmount, type TransactionType } from "@finance-manager/core";
import { sql, type Kysely } from "kysely";
import { currentPostings, descendants, naturalAmount } from "./queries.js";
import type { LedgerDatabase } from "./schema.js";

type Database = Kysely<LedgerDatabase>;
type Page = { limit: number; after?: string };

export async function getAccountTree(db: Database, includeArchived: boolean) {
  const accounts = await db
    .selectFrom("accounts")
    .select([
      "id",
      "parent_id",
      "name",
      "kind",
      "subtype",
      "currency",
      "archived_at",
    ])
    .orderBy("id")
    .execute();
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const visible = includeArchived
    ? accounts
    : accounts.filter(({ archived_at }) => archived_at === null);
  return visible.map((account) => {
    const names = [account.name];
    const archivedAncestors: string[] = [];
    const seen = new Set([account.id]);
    for (let parent = account.parent_id; parent;) {
      if (seen.has(parent))
        throw new Error("El árbol de cuentas contiene un ciclo.");
      seen.add(parent);
      const node = byId.get(parent);
      if (!node) break;
      names.push(node.name);
      if (node.archived_at !== null) archivedAncestors.push(node.id);
      parent = node.parent_id;
    }
    return {
      ...account,
      path: names.reverse().join(" > "),
      archivedAncestors: archivedAncestors.reverse(),
    };
  });
}

export async function getAccountBalances(
  db: Database,
  ids: string[],
  date: string,
) {
  if (ids.length === 0) return [];
  const rows = await currentPostings(db)
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .select([
      "a.id",
      "a.kind",
      "p.currency",
      sql<string>`SUM(p.amount)`.as("amount"),
    ])
    .where("a.id", "in", ids)
    .where("t.date", "<=", date)
    .groupBy(["a.id", "a.kind", "p.currency"])
    .orderBy("p.currency")
    .execute();
  return rows.map((row) => ({
    ...row,
    amount: naturalAmount(row.kind, BigInt(row.amount)),
  }));
}

export async function getPeriodSummary(
  db: Database,
  input: Page & {
    from: string;
    to: string;
    categoryId?: string;
    includeArchived: boolean;
  },
) {
  if (input.from > input.to)
    throw new Error("El inicio del rango debe ser anterior o igual al final.");
  const accounts = await db
    .selectFrom("accounts")
    .select(["id", "parent_id", "name", "kind", "archived_at"])
    .where("kind", "in", ["income", "expense"])
    .orderBy("id")
    .execute();
  const roots = accounts.filter((account) => account.parent_id === null);
  const selected = input.categoryId
    ? accounts.find(({ id }) => id === input.categoryId)
    : undefined;
  if (input.categoryId && !selected)
    throw new Error("Se requiere una categoría de ingresos o gastos.");
  const parents = selected ? [selected] : roots;
  const ids = selected
    ? descendants(accounts, selected.id)
    : accounts.map(({ id }) => id);
  const rows = ids.length
    ? await currentPostings(db)
        .innerJoin("accounts as a", "a.id", "p.account_id")
        .select([
          "a.id",
          "a.kind",
          "p.currency",
          sql<string>`SUM(p.amount)`.as("amount"),
        ])
        .where("a.id", "in", ids)
        .where("t.date", ">=", input.from)
        .where("t.date", "<=", input.to)
        .groupBy(["a.id", "a.kind", "p.currency"])
        .orderBy("p.currency")
        .execute()
    : [];
  const totals = new Map<
    string,
    { currency: string; income: bigint; expense: bigint }
  >();
  const balances = new Map<string, { currency: string; amount: bigint }[]>();
  for (const row of rows) {
    const amount = naturalAmount(row.kind, BigInt(row.amount));
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      income: 0n,
      expense: 0n,
    };
    if (row.kind === "income") total.income += amount;
    else total.expense += amount;
    totals.set(row.currency, total);
    const list = balances.get(row.id) ?? [];
    list.push({ currency: row.currency, amount });
    balances.set(row.id, list);
  }
  const children = accounts
    .filter(
      (row) =>
        parents.some(({ id }) => row.parent_id === id) &&
        (input.includeArchived || row.archived_at === null) &&
        (!input.after || BigInt(row.id) > BigInt(input.after)),
    )
    .slice(0, input.limit + 1);
  return {
    totals: [...totals.values()],
    categories: children.map((row) => {
      const amounts = new Map<string, bigint>();
      for (const id of descendants(accounts, row.id))
        for (const { currency, amount } of balances.get(id) ?? [])
          amounts.set(currency, (amounts.get(currency) ?? 0n) + amount);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        amounts: [...amounts]
          .sort()
          .map(([currency, amount]) => ({ currency, amount })),
      };
    }),
  };
}

export async function findTransactions(
  db: Database,
  input: {
    limit: number;
    before?: { date: string; id: string };
    id?: string;
    from?: string;
    to?: string;
    accountId?: string;
    categoryId?: string;
    type?: TransactionType;
    tag?: string;
    text?: string;
    min?: string;
    max?: string;
    includeDeleted?: boolean;
    includeDayTotals?: boolean;
  },
) {
  if (input.from && input.to && input.from > input.to)
    throw new Error("El inicio del rango debe ser anterior o igual al final.");
  const hasCategory = (kind: "income" | "expense") => sql`EXISTS (
    SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
    WHERE p.transaction_id = t.id AND p.user_id = t.user_id AND a.kind = ${kind}
  )`;
  const type = sql<TransactionType>`CASE
    WHEN ${hasCategory("expense")} THEN 'gasto'
    WHEN ${hasCategory("income")} THEN 'ingreso'
    WHEN (SELECT COUNT(DISTINCT p.account_id) FROM postings p JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
          WHERE p.transaction_id = t.id AND p.user_id = t.user_id AND a.kind IN ('asset', 'liability')) >= 2 THEN 'transferencia'
    ELSE 'ajuste' END`;
  let query = db
    .selectFrom("transactions as t")
    .innerJoin("operations as o", "o.id", "t.operation_id")
    .select([
      "t.id",
      "t.date",
      "t.description",
      "t.note",
      "t.custom",
      "t.operation_id",
      "t.deleted_at",
      "o.actor",
      type.as("type"),
    ])
    .orderBy("t.date", "desc")
    .orderBy("t.id", "desc")
    .limit(input.limit + 1);
  if (!input.includeDeleted) query = query.where("t.deleted_at", "is", null);
  if (input.id) query = query.where("t.id", "=", input.id);
  if (input.from) query = query.where("t.date", ">=", input.from);
  if (input.to) query = query.where("t.date", "<=", input.to);
  if (input.text)
    query = query.where(sql<boolean>`(
    LOCATE(${input.text}, t.description) > 0 OR LOCATE(${input.text}, t.note) > 0
  )`);
  if (input.type) query = query.where(type, "=", input.type);
  if (input.tag) {
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("transaction_tags as tt")
          .innerJoin("tags as g", "g.id", "tt.tag_id")
          .select("tt.tag_id")
          .whereRef("tt.transaction_id", "=", "t.id")
          .where("g.name", "=", input.tag!),
      ),
    );
  }
  if (input.categoryId) {
    const categories = await db
      .selectFrom("accounts")
      .select(["id", "parent_id"])
      .where("kind", "in", ["income", "expense"])
      .execute();
    const ids = categories.some(({ id }) => id === input.categoryId)
      ? descendants(categories, input.categoryId)
      : [];
    if (!ids.length) return { more: false, entries: [], dayTotals: [] };
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("postings as p")
          .select("p.id")
          .whereRef("p.transaction_id", "=", "t.id")
          .where("p.account_id", "in", ids),
      ),
    );
  }
  if (input.accountId || input.min !== undefined || input.max !== undefined) {
    let matches = db.selectFrom("postings as p").select("p.id");
    if (input.accountId) {
      const tree = await db
        .selectFrom("accounts")
        .select(["id", "parent_id"])
        .execute();
      matches = matches.where(
        "p.account_id",
        "in",
        descendants(tree, input.accountId),
      );
    }
    if (input.min !== undefined || input.max !== undefined) {
      const currencies = await db
        .selectFrom("currencies")
        .selectAll()
        .execute();
      const ranges = currencies.map(({ code, minor_unit }) => {
        const min =
          input.min === undefined ? 0n : parseAmount(input.min, minor_unit);
        const max =
          input.max === undefined
            ? undefined
            : parseAmount(input.max, minor_unit);
        if (min < 0n || (max !== undefined && max < min))
          throw new Error("El rango de montos debe ser positivo y ordenado.");
        return { code, min, max };
      });
      const absolute = sql<string>`ABS(CAST(p.amount AS DECIMAL(20,0)))`;
      matches = matches.where(({ and, or, eb }) =>
        or(
          ranges.map(({ code, min, max }) =>
            and([
              eb("p.currency", "=", code),
              eb(absolute, ">=", min.toString()),
              ...(max === undefined
                ? []
                : [eb(absolute, "<=", max.toString())]),
            ]),
          ),
        ),
      );
    }
    query = query.where(({ exists }) =>
      exists(matches.where("p.transaction_id", "=", sql<string>`t.id`)),
    );
  }
  const filtered = query.clearSelect().clearOrderBy().clearLimit();
  if (input.before) {
    const { date, id } = input.before;
    query = query.where(({ and, or, eb }) =>
      or([
        eb("t.date", "<", date),
        and([eb("t.date", "=", date), eb("t.id", "<", id)]),
      ]),
    );
  }
  const rows = await query.execute();
  const page = rows.slice(0, input.limit);
  const ids = page.map(({ id }) => id);
  const dates = [...new Set(page.map(({ date }) => date))];
  const dayTotals =
    input.includeDayTotals && dates.length
      ? await db
          .selectFrom("postings as p")
          .innerJoin("transactions as t", "t.id", "p.transaction_id")
          .innerJoin("accounts as a", "a.id", "p.account_id")
          .select([
            "t.date",
            "a.kind",
            "p.currency",
            sql<string>`SUM(p.amount)`.as("amount"),
          ])
          .where("a.kind", "in", ["income", "expense"])
          .where("t.date", "in", dates)
          .where(
            "t.id",
            "in",
            filtered.select("t.id").where("t.date", "in", dates),
          )
          .groupBy(["t.date", "a.kind", "p.currency"])
          .orderBy("p.currency")
          .execute()
      : [];
  const postings = ids.length
    ? await db
        .selectFrom("postings")
        .selectAll()
        .where("transaction_id", "in", ids)
        .orderBy("id")
        .execute()
    : [];
  const tags = ids.length
    ? await db
        .selectFrom("transaction_tags as tt")
        .innerJoin("tags as g", "g.id", "tt.tag_id")
        .select(["tt.transaction_id", "g.name"])
        .where("tt.transaction_id", "in", ids)
        .orderBy("g.name")
        .execute()
    : [];
  return {
    more: rows.length > page.length,
    dayTotals,
    entries: page.map((row) => ({
      ...row,
      postings: postings.filter(
        ({ transaction_id }) => transaction_id === row.id,
      ),
      tags: tags
        .filter(({ transaction_id }) => transaction_id === row.id)
        .map(({ name }) => name),
    })),
  };
}

export async function listMetadata(
  db: Database,
  input: Page & {
    entity: "etiqueta" | "campo";
    includeArchived: boolean;
  },
) {
  if (input.entity === "etiqueta") {
    let query = db
      .selectFrom("tags")
      .selectAll()
      .orderBy("id")
      .limit(input.limit + 1);
    if (input.after) query = query.where("id", ">", input.after);
    return (await query.execute()).map(({ id, name }) => ({
      id,
      nombre: name,
    }));
  }
  let query = db
    .selectFrom("custom_field_definitions")
    .selectAll()
    .orderBy("id")
    .limit(input.limit + 1);
  if (input.after) query = query.where("id", ">", input.after);
  if (!input.includeArchived) query = query.where("archived_at", "is", null);
  return (await query.execute()).map((row) => ({
    id: row.id,
    entidad: row.entity,
    clave: row.key,
    etiqueta: row.label,
    tipo: row.type,
    opciones:
      row.options === null ? null : (JSON.parse(row.options) as string[]),
    archivado: row.archived_at !== null,
  }));
}
