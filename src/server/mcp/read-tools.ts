import {
  accountingDate,
  ledgerInputs,
  rowId,
  todayLaPaz,
} from "@finance-manager/core";
import { z } from "zod";
import { accountLookup, accountRef, type Ledger } from "./accounts.js";
import {
  amount,
  idPageInput,
  money,
  pageInput,
  paginate,
  registerTool,
  type ToolServer,
} from "./tool.js";
import { rateInput, rateOutput, showRate } from "./write-tools.js";

const date = { fecha: accountingDate.optional() };
const archived = { incluir_archivadas: z.boolean().prefault(false) };
const period = {
  desde: accountingDate.optional(),
  hasta: accountingDate.optional(),
};
const cursor = { cursor: z.string().nullable() };
const accountType = z.enum([
  "asset",
  "liability",
  "income",
  "expense",
  "equity",
]);
const transactionCursor = z
  .string()
  .max(31)
  .refine((value) => {
    const [fecha, id, ...rest] = value.split(":");
    return (
      !rest.length &&
      accountingDate.safeParse(fecha).success &&
      rowId.safeParse(id).success
    );
  }, "Usa el cursor devuelto por la búsqueda.")
  .optional();
const amounts = z.array(money);
const movement = z.object({
  id: rowId,
  fecha: z.string(),
  descripcion: z.string(),
  nota: z.string().nullable(),
  campos: z.record(z.string(), z.union([z.number(), z.string()])).nullable(),
  operationId: z.uuid(),
  borrado: z.boolean(),
  etiquetas: z.array(z.string()),
  lineas: z.array(
    money.extend({
      cuenta: rowId,
      lado: z.enum(["debit", "credit"]),
      nota: z.string().nullable(),
    }),
  ),
});

export function registerReads(server: ToolServer, ledger: Ledger) {
  registerTool(
    server,
    "listar_cuentas",
    "Lista el árbol de cuentas con su ruta, padre y saldos naturales por moneda.",
    z.strictObject({ ...date, ...archived, ...idPageInput }),
    z.object({
      ...cursor,
      cuentas: z.array(
        z.object({
          id: rowId,
          padre: rowId.nullable(),
          nombre: z.string(),
          ruta: z.string(),
          tipo: accountType,
          subtipo: z.string().nullable(),
          moneda: z.string().nullable(),
          archivada: z.boolean(),
          saldos: amounts,
        }),
      ),
    }),
    "read",
    async ({ fecha, incluir_archivadas, limite, cursor }) => {
      const accounts = await ledger.getAccountTree(incluir_archivadas);
      const page = paginate(
        accounts.filter(({ id }) => !cursor || BigInt(id) > BigInt(cursor)),
        limite,
        ({ id }) => id,
      );
      const balances = await ledger.listAccountBalances(
        page.rows.map(({ id }) => id),
        fecha ?? todayLaPaz(),
      );
      const cuentas = page.rows.map((row) => {
        const saldos = balances
          .filter(({ id }) => id === row.id)
          .map((balance) => amount(balance.amount, balance.currency));
        if (!saldos.length && row.currency)
          saldos.push(amount(0n, row.currency));
        return {
          id: row.id,
          padre: row.parent_id,
          nombre: row.name,
          ruta: row.path,
          tipo: row.kind,
          subtipo: row.subtype,
          moneda: row.currency,
          archivada: row.archived_at !== null,
          saldos,
        };
      });
      return [
        { cuentas, cursor: page.cursor },
        `Cuentas en esta página: ${cuentas.length}.`,
      ];
    },
  );
  registerTool(
    server,
    "ver_saldo",
    "Consulta el saldo natural de una cuenta de moneda fija a una fecha.",
    z.strictObject({ cuenta: accountRef, ...date, ...archived }),
    z.object({ id: rowId, fecha: z.string(), saldo: money }),
    "read",
    async ({ cuenta, fecha = todayLaPaz(), incluir_archivadas }) => {
      const id = (await accountLookup(ledger, incluir_archivadas))(cuenta);
      const balance = await ledger.getBalance({ id, date: fecha });
      const saldo = amount(balance.amount, balance.currency);
      return [{ id, fecha, saldo }, `Saldo al ${fecha}: ${saldo.texto}.`];
    },
  );
  registerTool(
    server,
    "patrimonio_neto",
    "Calcula el patrimonio en BOB e identifica las cuentas sin tipo de cambio aplicable.",
    z.strictObject(date),
    z.object({
      fecha: z.string(),
      total: money,
      no_valuadas: z.array(
        money.extend({
          id: rowId,
          nombre: z.string(),
          tipo: accountType,
        }),
      ),
    }),
    "read",
    async ({ fecha = todayLaPaz() }) => {
      const worth = await ledger.getNetWorth({ date: fecha });
      const total = amount(worth.amount, worth.currency);
      const no_valuadas = worth.unvalued.map((row) => ({
        ...amount(row.amount, row.currency),
        id: row.id,
        nombre: row.name,
        tipo: row.kind,
      }));
      return [
        { fecha, total, no_valuadas },
        `Patrimonio valuado: ${total.texto}. Cuentas sin valuar: ${no_valuadas.length}.`,
      ];
    },
  );
  registerTool(
    server,
    "resumen_periodo",
    "Resume ingresos, gastos y neto por moneda con totales de categorías y descendientes.",
    z.strictObject({
      ...period,
      ...archived,
      ...idPageInput,
      categoria: accountRef.optional(),
    }),
    z.object({
      ...cursor,
      desde: z.string(),
      hasta: z.string(),
      totales: z.array(
        z.object({ ingresos: money, gastos: money, neto: money }),
      ),
      categorias: z.array(
        z.object({
          id: rowId,
          nombre: z.string(),
          tipo: accountType,
          totales: amounts,
        }),
      ),
    }),
    "read",
    async ({ categoria, incluir_archivadas, desde, hasta, cursor, limite }) => {
      const today = todayLaPaz();
      const from = desde ?? today;
      const to = hasta ?? today;
      const categoryId = categoria
        ? (await accountLookup(ledger, incluir_archivadas))(categoria)
        : undefined;
      const summary = await ledger.getPeriodSummary({
        from,
        to,
        categoryId,
        includeArchived: incluir_archivadas,
        limit: limite,
        after: cursor,
      });
      const page = paginate(summary.categories, limite, ({ id }) => id);
      return [
        {
          desde: from,
          hasta: to,
          cursor: page.cursor,
          totales: summary.totals.map(({ currency, income, expense }) => ({
            ingresos: amount(income, currency),
            gastos: amount(expense, currency),
            neto: amount(income - expense, currency),
          })),
          categorias: page.rows.map(({ id, name, kind, amounts }) => ({
            id,
            nombre: name,
            tipo: kind,
            totales: amounts.map((row) => amount(row.amount, row.currency)),
          })),
        },
        `Resumen del ${from} al ${to}. Categorías en esta página: ${page.rows.length}.`,
      ];
    },
  );
  registerTool(
    server,
    "buscar_movimientos",
    "Busca movimientos por fecha, cuenta, etiqueta, texto o monto. Indica un ID para ver el asiento completo.",
    z.strictObject({
      ...period,
      ...archived,
      ...pageInput,
      cursor: transactionCursor,
      id: rowId.optional(),
      cuenta: accountRef.optional(),
      etiqueta: z.string().trim().min(1).max(120).optional(),
      texto: z.string().trim().min(1).max(255).optional(),
      monto_minimo: ledgerInputs.reconcile.shape.actualBalance.optional(),
      monto_maximo: ledgerInputs.reconcile.shape.actualBalance.optional(),
      incluir_borrados: z.boolean().optional(),
    }),
    z.object({ ...cursor, movimientos: z.array(movement) }),
    "read",
    async (input) => {
      const [date, id] = input.cursor?.split(":") ?? [];
      const accountId = input.cuenta
        ? (await accountLookup(ledger, input.incluir_archivadas))(input.cuenta)
        : undefined;
      const result = await ledger.findTransactions({
        id: input.id,
        from: input.desde,
        to: input.hasta,
        accountId,
        text: input.texto,
        tag: input.etiqueta,
        min: input.monto_minimo,
        max: input.monto_maximo,
        includeDeleted: input.incluir_borrados,
        limit: input.limite,
        before: date && id ? { date, id } : undefined,
      });
      const last = result.entries.at(-1);
      const movimientos = result.entries.map((row) => ({
        id: row.id,
        fecha: row.date,
        descripcion: row.description,
        nota: row.note,
        campos:
          row.custom === null
            ? null
            : (JSON.parse(row.custom) as Record<string, string | number>),
        operationId: row.operation_id,
        borrado: row.deleted_at !== null,
        etiquetas: row.tags,
        lineas: row.postings.map((line) => {
          const units = BigInt(line.amount);
          return {
            ...amount(units < 0n ? -units : units, line.currency),
            cuenta: line.account_id,
            lado: units < 0n ? ("credit" as const) : ("debit" as const),
            nota: line.memo,
          };
        }),
      }));
      return [
        {
          movimientos,
          cursor: result.more && last ? last.date + ":" + last.id : null,
        },
        `Movimientos en esta página: ${movimientos.length}.`,
      ];
    },
  );
  registerTool(
    server,
    "ver_tipo_de_cambio",
    "Consulta el tipo de cambio vigente a una fecha y la fuente registrada.",
    rateInput,
    rateOutput,
    "read",
    async ({ origen, destino, fecha }) => {
      const rate = showRate(
        await ledger.getExchangeRate({
          from: origen,
          to: destino,
          date: fecha,
        }),
      );
      return [
        rate,
        `Tipo de cambio de ${origen} a ${destino}: ${rate.tipo} (${rate.fecha}).`,
      ];
    },
  );
  const metadata = z.union([
    z.object({ id: rowId, nombre: z.string() }),
    z.object({
      id: rowId,
      entidad: z.enum(["account", "transaction"]),
      clave: z.string(),
      etiqueta: z.string(),
      tipo: z.enum(["text", "number", "date", "option"]),
      opciones: z.array(z.string()).nullable(),
      archivado: z.boolean(),
    }),
  ]);
  registerTool(
    server,
    "listar_etiquetas_y_campos",
    "Lista etiquetas usadas o definiciones de campos personalizados según la clase elegida.",
    z.strictObject({
      ...archived,
      ...idPageInput,
      clase: z.enum(["etiqueta", "campo"]).prefault("etiqueta"),
    }),
    z.object({ ...cursor, elementos: z.array(metadata) }),
    "read",
    async ({ clase, incluir_archivadas, cursor, limite }) => {
      const rows = await ledger.listMetadata({
        entity: clase,
        includeArchived: incluir_archivadas,
        after: cursor,
        limit: limite,
      });
      const page = paginate<z.output<typeof metadata>>(
        rows,
        limite,
        ({ id }) => id,
      );
      return [
        { elementos: page.rows, cursor: page.cursor },
        `Elementos en esta página: ${page.rows.length}.`,
      ];
    },
  );
  registerTool(
    server,
    "listar_operaciones",
    "Lista el historial de operaciones con su actor, fecha y estado de reversión.",
    z.strictObject(idPageInput),
    z.object({
      ...cursor,
      operaciones: z.array(
        z.object({
          operationId: z.uuid(),
          actor: z.enum(["claude", "web", "system"]),
          descripcion: z.string(),
          registrada_en: z.string(),
          deshecha: z.boolean(),
        }),
      ),
    }),
    "read",
    async ({ limite, cursor }) => {
      const rows = await ledger.listOperations(
        {},
        { limit: limite + 1, before: cursor },
      );
      const page = paginate(rows, limite, ({ seq }) => seq);
      const operaciones = page.rows.map((row) => ({
        operationId: row.id,
        actor: row.actor,
        descripcion: row.description,
        registrada_en: row.created_at,
        deshecha: row.undone,
      }));
      return [
        { operaciones, cursor: page.cursor },
        `Operaciones en esta página: ${operaciones.length}.`,
      ];
    },
  );
}
