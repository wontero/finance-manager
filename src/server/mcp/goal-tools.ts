import { ledgerInputs, rowId } from "@finance-manager/core";
import { z } from "zod";
import type { Ledger } from "./accounts.js";
import { amount, money, registerTool, type ToolServer } from "./tool.js";
import { done, operationWithId } from "./write-tools.js";

const update = ledgerInputs.updateGoal.shape;
const fields = {
  inicio: update.startDate,
  limite: update.endDate,
  cuentas: update.accountIds,
  categoria: update.categoryId,
};
const goalOutput = z.object({
  id: rowId,
  tipo: z.enum(["ahorro", "tope"]),
  nombre: z.string(),
  objetivo: money,
  inicio: z.string().nullable(),
  limite: z.string().nullable(),
  archivada: z.boolean(),
  porcentaje: z.string().nullable(),
  monedas_sin_tipo: z.array(z.string()),
  cuentas: z.array(rowId).optional(),
  saldo: money.nullable().optional(),
  falta: money.nullable().optional(),
  dias_restantes: z.number().int().optional(),
  vencida: z.boolean().optional(),
  ahorro_mensual: money.nullable().optional(),
  categoria: rowId.optional(),
  periodo: z.enum(["mensual", "rango"]).optional(),
  gastado: money.nullable().optional(),
  queda: money.nullable().optional(),
  superado: z.boolean().nullable().optional(),
});

export function registerGoalTools(server: ToolServer, ledger: Ledger) {
  const writeOutput = operationWithId.extend({ objetivo: money });
  function confirm(
    { goal, operationId, scale }: Awaited<ReturnType<Ledger["createGoal"]>>,
    action: string,
  ) {
    const objetivo = amount(
      BigInt(goal.target_amount),
      goal.currency,
      new Map([[goal.currency, scale]]),
    );
    return done(
      { id: goal.id, operationId, objetivo },
      `Meta «${goal.name}» ${action} por ${objetivo.texto}.`,
    );
  }

  registerTool(
    server,
    "crear_meta",
    "Crea una meta de ahorro por saldo neto de cuentas (activos menos pasivos) o un tope de gastos por categoría. Indica los IDs. El tope mensual no lleva fechas y el tope por rango requiere ambas.",
    z.strictObject({
      ...fields,
      tipo: goalOutput.shape.tipo,
      nombre: update.name.unwrap(),
      monto: update.amount.unwrap(),
      moneda: ledgerInputs.createGoal.options[0].shape.currency,
      periodo: goalOutput.shape.periodo,
    }),
    writeOutput,
    "write",
    async ({
      tipo,
      nombre,
      monto,
      moneda,
      inicio,
      limite,
      cuentas,
      categoria,
      periodo,
    }) => {
      const input = {
        name: nombre,
        amount: monto,
        currency: moneda,
        startDate: inicio,
        endDate: limite,
      };
      if (tipo === "ahorro") {
        if (!cuentas || categoria || periodo)
          throw new Error("Indica las cuentas de la meta de ahorro.");
        return confirm(
          await ledger.createGoal({
            ...input,
            type: "savings",
            accountIds: cuentas,
          }),
          "creada",
        );
      }
      if (!categoria || cuentas)
        throw new Error("Indica la categoría del tope de gastos.");
      if (
        (periodo === "mensual" && (inicio || limite)) ||
        (periodo === "rango" && (!inicio || !limite))
      )
        throw new Error("Indica las dos fechas solo para un tope por rango.");
      return confirm(
        await ledger.createGoal({
          ...input,
          type: "spending",
          categoryId: categoria,
        }),
        "creada",
      );
    },
  );
  registerTool(
    server,
    "modificar_meta",
    "Modifica nombre, monto, fechas, cuentas o categoría. Envía ambas fechas como null para volver a un tope mensual.",
    z.strictObject({
      ...fields,
      id: rowId,
      nombre: update.name,
      monto: update.amount,
    }),
    writeOutput,
    "destructive",
    async ({ id, nombre, monto, inicio, limite, cuentas, categoria }) =>
      confirm(
        await ledger.updateGoal({
          id,
          name: nombre,
          amount: monto,
          startDate: inicio,
          endDate: limite,
          accountIds: cuentas,
          categoryId: categoria,
        }),
        "actualizada",
      ),
  );
  registerTool(
    server,
    "archivar_meta",
    "Archiva una meta activa por ID. La operación se puede deshacer.",
    ledgerInputs.archiveGoal,
    writeOutput,
    "destructive",
    async (input) => confirm(await ledger.archiveGoal(input), "archivada"),
  );
  registerTool(
    server,
    "ver_metas",
    "Muestra el avance de todas las metas activas o de una meta por ID. El avance de ahorro es el saldo neto de las cuentas elegidas (activos menos pasivos).",
    ledgerInputs.listGoals,
    z.object({ metas: z.array(goalOutput) }),
    "read",
    async (input) => {
      const { results, scales } = await ledger.listGoals(input);
      const lines: string[] = [];
      const metas = results.map((result): z.output<typeof goalOutput> => {
        const { goal, progress, remaining, percentage, missingCurrencies } =
          result;
        const show = (units: bigint | null) =>
          units === null ? null : amount(units, goal.currency, scales);
        const objetivo = amount(
          BigInt(goal.target_amount),
          goal.currency,
          scales,
        );
        const current = show(progress);
        const rest = show(remaining);
        const heading = `«${goal.name.replace(/\s+/g, " ")}»`;
        const status = current
          ? `${current.texto} de ${objetivo.texto} (${percentage} %)`
          : `sin tipo de cambio de ${missingCurrencies.join(", ")} a ${goal.currency}`;
        const common = {
          id: goal.id,
          nombre: goal.name,
          objetivo,
          archivada: goal.archived_at !== null,
          porcentaje: percentage,
          monedas_sin_tipo: missingCurrencies,
        };
        if (result.type === "savings") {
          const monthly = show(result.monthly);
          const deadline = result.expired
            ? ", vencida"
            : result.days === undefined
              ? ""
              : `, ${result.days} días restantes`;
          lines.push(
            heading +
              ": " +
              status +
              (rest ? `, faltan ${rest.texto}` : "") +
              deadline +
              (result.days !== undefined && monthly
                ? `, ${monthly.texto} por mes`
                : "") +
              ".",
          );
          return {
            ...common,
            tipo: "ahorro",
            inicio: goal.start_date,
            limite: goal.end_date,
            cuentas: result.accountIds,
            saldo: current,
            falta: rest,
            ...(result.days === undefined
              ? {}
              : {
                  dias_restantes: result.days,
                  vencida: result.expired,
                  ahorro_mensual: monthly,
                }),
          };
        }
        lines.push(
          `${heading} (${result.from} a ${result.to}): ${status}` +
            (rest ? `, quedan ${rest.texto}` : "") +
            (result.exceeded ? ", tope superado." : "."),
        );
        return {
          ...common,
          tipo: "tope",
          inicio: result.from,
          limite: result.to,
          categoria: goal.category_id!,
          periodo: goal.start_date === null ? "mensual" : "rango",
          gastado: current,
          queda: rest,
          superado: result.exceeded,
        };
      });
      return [{ metas }, lines.join("\n") || "No hay metas activas."];
    },
  );
}
