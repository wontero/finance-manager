import { sql, type Kysely } from "kysely";
import { rowId } from "@finance-manager/core";
import { systemAccounts, type LedgerDatabase } from "./schema.js";

export async function provisionUser(database: Kysely<unknown>, id: string) {
  const userId = rowId.parse(id);
  if (userId === "1") return;
  const provision = async (db: Kysely<LedgerDatabase>) => {
    const { rows } =
      await sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`.execute(
        db,
      );
    if (!rows.length) throw new Error(`No existe el usuario ${userId}.`);
    const root = await db
      .selectFrom("accounts")
      .select("id")
      .where("user_id", "=", userId)
      .where("is_system", "=", 1)
      .where("name", "=", systemAccounts.income)
      .executeTakeFirst();
    if (root) return;

    for (const [kind, name, categories] of [
      ["income", systemAccounts.income, ["Sueldo", "Otros ingresos"]],
      [
        "expense",
        systemAccounts.expense,
        ["Comida", "Transporte", "Vivienda", "Servicios", "Salud", "Ocio"],
      ],
    ] as const) {
      const { insertId } = await db
        .insertInto("accounts")
        .values({ user_id: userId, name, kind, is_system: 1 })
        .executeTakeFirstOrThrow();
      const parent_id = insertId!.toString();
      await db
        .insertInto("accounts")
        .values([
          {
            user_id: userId,
            name: "Intereses",
            kind,
            parent_id,
            is_system: 1,
            loan_interest: kind,
          },
          ...categories.map((name) => ({
            user_id: userId,
            name,
            kind,
            parent_id,
          })),
        ])
        .execute();
    }
    await db
      .insertInto("accounts")
      .values(
        [
          systemAccounts.opening,
          systemAccounts.adjustment,
          systemAccounts.clearing,
        ].map((name) => ({
          user_id: userId,
          name,
          kind: "equity" as const,
          is_system: 1,
        })),
      )
      .execute();
  };
  const db = database.withTables<LedgerDatabase>();
  await (db.isTransaction
    ? provision(db)
    : db.transaction().execute(provision));
}
