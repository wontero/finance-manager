import { accountingDate, ledgerInputs, rowId } from "@finance-manager/core";
import { z } from "zod";
import { accountLookup, accountRef, type Ledger } from "./accounts.js";
import { amount, money, registerTool, type ToolServer } from "./tool.js";
import { done, operationWithId } from "./write-tools.js";

const register = ledgerInputs.registerLoan.shape;
const payment = ledgerInputs.payLoan.shape;
const status = z.enum(["abierto", "cerrado"]);
const split = z.object({ capital: money, interes: money, monto: money });
const movement = operationWithId.extend({ cuenta: rowId, asiento: rowId });
const summary = z.object({
  id: rowId,
  cuenta: rowId,
  direccion: register.direction,
  persona: register.counterparty,
  moneda: register.currency,
  capital_inicial: money,
  capital_pendiente: money,
  interes_pendiente: money,
  total: money,
  fecha_alta: accountingDate,
  tasa: z.string(),
  periodo: register.ratePeriod,
  vencimiento: accountingDate.nullable(),
  notas: z.string().nullable(),
  estado: status,
  vencido: z.boolean(),
});

function showLoan(
  {
    loan,
    principal,
    interest,
    total,
    status,
    overdue,
  }:
    | Awaited<ReturnType<Ledger["getLoan"]>>
    | Awaited<ReturnType<Ledger["listLoans"]>>["summaries"][number],
  scales: ReadonlyMap<string, number>,
) {
  const show = (value: bigint) => amount(value, loan.currency, scales);
  return {
    id: loan.id,
    cuenta: loan.account_id,
    direccion: loan.direction,
    persona: loan.counterparty,
    moneda: loan.currency,
    capital_inicial: show(BigInt(loan.principal)),
    capital_pendiente: show(principal),
    interes_pendiente: show(interest),
    total: show(total),
    fecha_alta: loan.start_date,
    tasa: loan.rate,
    periodo: loan.rate_period,
    vencimiento: loan.due_date,
    notas: loan.notes,
    estado: status === "open" ? ("abierto" as const) : ("cerrado" as const),
    vencido: overdue,
  };
}

export function registerLoanTools(server: ToolServer, ledger: Ledger) {
  registerTool(
    server,
    "registrar_prestamo",
    "Registra un préstamo hecho (given) o recibido (received) con su tasa simple en porcentaje y período mensual (monthly) o anual (annual). Usa sin_movimiento_de_caja solo para un préstamo histórico cuya caja ya esté registrada.",
    z.strictObject({
      direccion: register.direction,
      persona: register.counterparty,
      monto: register.amount,
      moneda: register.currency,
      fecha: register.date,
      tasa: register.rate,
      periodo: register.ratePeriod,
      vencimiento: register.dueDate,
      notas: register.notes,
      cuenta: accountRef.optional(),
      sin_movimiento_de_caja: register.withoutCash,
    }),
    movement,
    "write",
    async (input) => {
      const result = await ledger.registerLoan({
        direction: input.direccion,
        counterparty: input.persona,
        amount: input.monto,
        currency: input.moneda,
        date: input.fecha,
        rate: input.tasa,
        ratePeriod: input.periodo,
        dueDate: input.vencimiento,
        notes: input.notas,
        accountId:
          input.cuenta === undefined
            ? undefined
            : (await accountLookup(ledger))(input.cuenta),
        withoutCash: input.sin_movimiento_de_caja,
      });
      return done(
        {
          id: result.id,
          cuenta: result.accountId,
          asiento: result.entryId,
          operationId: result.operationId,
        },
        `Préstamo ${result.id} registrado.`,
      );
    },
  );
  registerTool(
    server,
    "abonar_prestamo",
    "Registra un abono por ID de préstamo. Cubre primero el interés devengado y luego el capital.",
    z.strictObject({
      id: rowId,
      cuenta: accountRef,
      monto: payment.amount,
      fecha: payment.date,
    }),
    operationWithId
      .extend(split.shape)
      .extend({ asiento: rowId, cerrado: z.boolean() }),
    "write",
    async ({ id, cuenta, monto, fecha }) => {
      const result = await ledger.payLoan({
        id,
        accountId: (await accountLookup(ledger))(cuenta),
        amount: monto,
        date: fecha,
      });
      const scales = new Map([[result.currency, result.scale]]);
      const show = (value: bigint) => amount(value, result.currency, scales);
      const capital = show(result.principal);
      const interes = show(result.interest);
      return done(
        {
          id,
          asiento: result.entryId,
          operationId: result.operationId,
          capital,
          interes,
          monto: show(result.principal + result.interest),
          cerrado: result.closed,
        },
        `Abono registrado en el préstamo ${id}. Capital ${capital.texto}, interés ${interes.texto}.${result.closed ? " Préstamo cerrado." : ""}`,
      );
    },
  );
  registerTool(
    server,
    "consultar_prestamos",
    "Consulta el saldo de préstamos a una fecha. Con ID muestra el detalle y sus abonos. Sin ID agrupa por persona y totaliza por moneda y dirección. Puedes filtrar por persona y estado.",
    z.strictObject({
      id: rowId.optional(),
      persona: ledgerInputs.listLoans.shape.counterparty,
      estado: status.optional(),
      fecha: register.date,
    }),
    z.object({
      fecha: accountingDate,
      prestamo: summary
        .extend({
          abonos: z.array(
            split.extend({
              asiento: rowId,
              operationId: z.uuid(),
              fecha: accountingDate,
            }),
          ),
        })
        .optional(),
      personas: z
        .array(z.object({ persona: z.string(), prestamos: z.array(summary) }))
        .optional(),
      totales: z
        .array(
          z.object({ moneda: z.string(), por_cobrar: money, por_pagar: money }),
        )
        .optional(),
    }),
    "read",
    async ({ id, persona, estado, fecha }) => {
      if (id && (persona || estado))
        throw new Error(
          "Usa el ID para el detalle o los filtros para la lista.",
        );
      const scales = await ledger.getCurrencyScales();
      if (id) {
        const detail = await ledger.getLoan({ id, date: fecha });
        const show = (value: bigint) =>
          amount(value, detail.loan.currency, scales);
        const data = {
          fecha: detail.date,
          prestamo: {
            ...showLoan(detail, scales),
            abonos: detail.payments.map((item) => ({
              asiento: item.entryId,
              operationId: item.operationId,
              fecha: item.date,
              capital: show(item.principal),
              interes: show(item.interest),
              monto: show(item.amount),
            })),
          },
        };
        return [data, JSON.stringify(data)];
      }
      const result = await ledger.listLoans({
        counterparty: persona,
        date: fecha,
        status:
          estado === "abierto"
            ? "open"
            : estado === "cerrado"
              ? "closed"
              : undefined,
      });
      const people = new Map<string, z.output<typeof summary>[]>();
      const totals = new Map<string, { given: bigint; received: bigint }>();
      for (const item of result.summaries) {
        const group = people.get(item.person) ?? [];
        group.push(showLoan(item, scales));
        people.set(item.person, group);
        const row = totals.get(item.loan.currency) ?? {
          given: 0n,
          received: 0n,
        };
        row[item.loan.direction] += item.total;
        totals.set(item.loan.currency, row);
      }
      const data = {
        fecha: result.date,
        personas: [...people].map(([persona, prestamos]) => ({
          persona,
          prestamos,
        })),
        totales: [...totals.keys()].sort().map((moneda) => ({
          moneda,
          por_cobrar: amount(totals.get(moneda)!.given, moneda, scales),
          por_pagar: amount(totals.get(moneda)!.received, moneda, scales),
        })),
      };
      return [data, JSON.stringify(data)];
    },
  );
}
