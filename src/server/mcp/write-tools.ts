import {
  ledgerInputs,
  parseRate,
  rowId,
  todayLaPaz,
  transactionInput,
} from "@finance-manager/core";
import { z } from "zod";
import { accountLookup, accountRef, type Ledger } from "./accounts.js";
import { getOfficialRate } from "./official-rate.js";
import { registerTool, type ToolServer } from "./tool.js";

const input = ledgerInputs;
const shared = transactionInput.shape;
const fields = {
  fecha: shared.date,
  descripcion: shared.description,
  nota: shared.note,
  etiquetas: shared.tags,
  campos: shared.custom,
};
const entry = z.strictObject(fields);
const expense = input.recordExpense.shape;
const transfer = input.transfer.shape;
const line = shared.lines.element.shape;
const lines = z
  .array(
    z.strictObject({
      cuenta: accountRef,
      moneda: line.currency,
      lado: line.side,
      monto: line.amount,
      nota: line.memo,
    }),
  )
  .min(2);
const draft = entry.extend({ lineas: lines });
type Resolve = Awaited<ReturnType<typeof accountLookup>>;

const toEntry = (value: Partial<z.output<typeof entry>>) => ({
  date: value.fecha,
  description: value.descripcion,
  note: value.nota,
  tags: value.etiquetas,
  custom: value.campos,
});
const toLines = (rows: z.output<typeof lines>, resolve: Resolve) =>
  rows.map(({ cuenta, moneda, lado, monto, nota }) => ({
    accountId: resolve(cuenta),
    currency: moneda,
    side: lado,
    amount: monto,
    memo: nota,
  }));
const toDraft = (value: z.output<typeof draft>, resolve: Resolve) => ({
  ...toEntry(value),
  description: value.descripcion,
  lines: toLines(value.lineas, resolve),
});

const operation = z.object({
  operationId: z.uuid().nullable(),
  deshacer: z
    .object({
      herramienta: z.literal("deshacer_operacion"),
      operationId: z.uuid(),
    })
    .nullable(),
});
export const operationWithId = operation.extend({ id: rowId.nullable() });

export function done<T extends { operationId: string | null }>(
  data: T,
  summary: string,
): [T & Pick<z.output<typeof operation>, "deshacer">, string] {
  const { operationId } = data;
  const deshacer = operationId
    ? { herramienta: "deshacer_operacion" as const, operationId }
    : null;
  return [
    { ...data, deshacer },
    operationId
      ? `${summary} Puedes deshacerla con deshacer_operacion y el ID ${operationId}.`
      : `${summary} No hay cambios que deshacer.`,
  ];
}

const pair = input.getExchangeRate.shape;
export const rateInput = z.strictObject({
  origen: pair.from,
  destino: pair.to,
  fecha: pair.date,
});
export const rateOutput = z.object({
  origen: z.string(),
  destino: z.string(),
  fecha: z.string(),
  tipo: z.string(),
  fuente: z.string(),
});
export const showRate = (rate: {
  from_currency: string;
  to_currency: string;
  date: string;
  rate: string;
  source: string;
}) => ({
  origen: rate.from_currency,
  destino: rate.to_currency,
  fecha: rate.date,
  tipo: rate.rate,
  fuente: rate.source,
});

export function registerWrites(server: ToolServer, ledger: Ledger) {
  const lookup = () => accountLookup(ledger);
  const categorized = entry.extend({
    cuenta: accountRef,
    categoria: accountRef,
    monto: expense.amount,
  });
  for (const [name, description, record, summary] of [
    [
      "registrar_gasto",
      "Registra un gasto desde una cuenta en una categoría de gastos.",
      ledger.recordExpense,
      "Gasto registrado.",
    ],
    [
      "registrar_ingreso",
      "Registra un ingreso en una cuenta y su categoría.",
      ledger.recordIncome,
      "Ingreso registrado.",
    ],
  ] as const) {
    registerTool(
      server,
      name,
      description,
      categorized,
      operationWithId,
      "write",
      async (value) => {
        const resolve = await lookup();
        return done(
          await record({
            ...toEntry(value),
            description: value.descripcion,
            accountId: resolve(value.cuenta),
            categoryId: resolve(value.categoria),
            amount: value.monto,
          }),
          summary,
        );
      },
    );
  }
  registerTool(
    server,
    "registrar_transferencia",
    "Transfiere entre cuentas. Si tienen monedas distintas, indica ambos montos.",
    entry.extend({
      origen: accountRef,
      destino: accountRef,
      monto: transfer.amount,
      monto_recibido: transfer.receivedAmount,
    }),
    operationWithId,
    "write",
    async (value) => {
      const resolve = await lookup();
      return done(
        await ledger.transfer({
          ...toEntry(value),
          description: value.descripcion,
          fromAccountId: resolve(value.origen),
          toAccountId: resolve(value.destino),
          amount: value.monto,
          receivedAmount: value.monto_recibido,
        }),
        "Transferencia registrada.",
      );
    },
  );
  registerTool(
    server,
    "registrar_asiento",
    "Registra un asiento de partida doble con sus líneas de débito y crédito.",
    draft,
    operationWithId,
    "write",
    async (value) =>
      done(
        await ledger.createTransaction(toDraft(value, await lookup())),
        "Asiento registrado.",
      ),
  );
  registerTool(
    server,
    "importar_lote",
    "Importa un historial o capturas en una sola operación. Omite duplicados por defecto.",
    z.strictObject({
      asientos: z.array(draft).min(1),
      incluir_duplicados: z.boolean().optional(),
    }),
    operation.extend({
      creados: z.array(rowId),
      omitidos: z.array(z.object({ indice: z.number().int(), id: rowId })),
    }),
    "write",
    async ({ asientos, incluir_duplicados }) => {
      const resolve = await lookup();
      const { created, skipped, operationId } = await ledger.importBatch(
        asientos.map((item) => toDraft(item, resolve)),
        { duplicates: incluir_duplicados ? "include" : "skip" },
      );
      return done(
        {
          creados: created,
          omitidos: skipped.map(({ index, existingId }) => ({
            indice: index,
            id: existingId,
          })),
          operationId,
        },
        `Asientos creados: ${created.length}. Duplicados omitidos: ${skipped.length}.`,
      );
    },
  );
  registerTool(
    server,
    "editar_movimiento",
    "Corrige un movimiento por ID. Si envías líneas, reemplaza todas las anteriores.",
    draft.partial().extend({ id: rowId }),
    operationWithId,
    "destructive",
    async (value) =>
      done(
        await ledger.editTransaction({
          ...toEntry(value),
          id: value.id,
          lines: value.lineas && toLines(value.lineas, await lookup()),
        }),
        "Edición procesada.",
      ),
  );
  registerTool(
    server,
    "borrar_movimiento",
    "Marca como borrado un movimiento por ID.",
    z.strictObject({ id: rowId }),
    operationWithId,
    "destructive",
    async (value) =>
      done(
        await ledger.deleteTransaction(value),
        "Movimiento marcado como borrado.",
      ),
  );
  const [asset, liability] = input.createAccount.options.map(
    ({ shape }) => shape,
  );
  registerTool(
    server,
    "crear_cuenta",
    "Crea una cuenta de activo o pasivo, con saldo de apertura opcional.",
    z.strictObject({
      nombre: asset.name,
      tipo: z.enum(["asset", "liability"]),
      subtipo: z.union([asset.subtype, liability.subtype]),
      moneda: asset.currency,
      padre: accountRef.nullable().optional(),
      campos: asset.custom,
      apertura: z
        .strictObject({
          monto: asset.opening.unwrap().shape.amount,
          fecha: shared.date,
        })
        .optional(),
    }),
    operationWithId,
    "write",
    async (value) => {
      const opening = value.apertura && {
        amount: value.apertura.monto,
        date: value.apertura.fecha ?? todayLaPaz(),
      };
      const data = {
        name: value.nombre,
        currency: value.moneda,
        custom: value.campos,
        opening,
        parentId: value.padre ? (await lookup())(value.padre) : value.padre,
      };
      const account = input.createAccount.safeParse({
        ...data,
        kind: value.tipo,
        subtype: value.subtipo,
      });
      if (!account.success)
        throw new Error("El subtipo debe corresponder al tipo de cuenta.");
      return done(await ledger.createAccount(account.data), "Cuenta creada.");
    },
  );
  registerTool(
    server,
    "crear_categoria",
    "Crea una categoría bajo la rama de ingresos o gastos que indiques.",
    z.strictObject({
      nombre: input.createCategory.shape.name,
      padre: accountRef,
      campos: shared.custom,
    }),
    operationWithId,
    "write",
    async ({ nombre, padre, campos }) =>
      done(
        await ledger.createCategory({
          name: nombre,
          parentId: (await lookup())(padre),
          custom: campos,
        }),
        "Categoría creada.",
      ),
  );
  registerTool(
    server,
    "modificar_cuenta",
    "Renombra, mueve, archiva o actualiza los campos de una cuenta o categoría.",
    z.strictObject({
      cuenta: accountRef,
      accion: z.enum(["renombrar", "mover", "campos", "archivar"]),
      nombre: input.renameAccount.shape.name.optional(),
      padre: accountRef.nullable().optional(),
      campos: shared.custom,
    }),
    operationWithId,
    "destructive",
    async (value) => {
      const resolve = await lookup();
      const id = resolve(value.cuenta);
      switch (value.accion) {
        case "renombrar":
          if (
            value.nombre !== undefined &&
            value.padre === undefined &&
            value.campos === undefined
          )
            return done(
              await ledger.renameAccount({ id, name: value.nombre }),
              "Cuenta renombrada.",
            );
          break;
        case "mover":
          if (
            value.padre !== undefined &&
            value.nombre === undefined &&
            value.campos === undefined
          )
            return done(
              await ledger.moveAccount({
                id,
                parentId: value.padre === null ? null : resolve(value.padre),
              }),
              "Cuenta movida.",
            );
          break;
        case "campos":
          if (
            value.campos !== undefined &&
            value.nombre === undefined &&
            value.padre === undefined
          )
            return done(
              await ledger.setAccountCustom({ id, custom: value.campos }),
              "Campos actualizados.",
            );
          break;
        case "archivar":
          if (
            value.nombre === undefined &&
            value.padre === undefined &&
            value.campos === undefined
          )
            return done(
              await ledger.archiveAccount({ id }),
              "Cuenta archivada.",
            );
          break;
      }
      throw new Error(
        "Indica solo el dato de la acción: nombre para renombrar, padre para mover o campos; archivar solo requiere la cuenta.",
      );
    },
  );
  registerTool(
    server,
    "fusionar_categorias",
    "Fusiona una categoría de origen en otra del mismo tipo.",
    z.strictObject({ origen: accountRef, destino: accountRef }),
    operationWithId,
    "destructive",
    async ({ origen, destino }) => {
      const resolve = await lookup();
      return done(
        await ledger.mergeCategories({
          sourceId: resolve(origen),
          targetId: resolve(destino),
        }),
        "Categorías fusionadas.",
      );
    },
  );
  registerTool(
    server,
    "conciliar_cuenta",
    "Calcula y registra el ajuste necesario para igualar el saldo real de una cuenta.",
    z.strictObject({
      cuenta: accountRef,
      saldo_real: input.reconcile.shape.actualBalance,
      fecha: shared.date,
    }),
    operationWithId,
    "write",
    async ({ cuenta, saldo_real, fecha }) => {
      const result = await ledger.reconcile(
        (await lookup())(cuenta),
        saldo_real,
        fecha,
      );
      return done(
        result ?? { id: null, operationId: null },
        result ? "Cuenta conciliada con un ajuste." : "El saldo ya coincide.",
      );
    },
  );
  registerTool(
    server,
    "registrar_tipo_de_cambio",
    "Registra el tipo de cambio de una fecha y su fuente para valorar monedas.",
    rateInput.extend({
      tipo: input.recordExchangeRate.shape.rate,
      fuente: input.recordExchangeRate.shape.source,
    }),
    operation.extend(rateOutput.shape),
    "write",
    async ({ origen, destino, fecha, tipo, fuente }) => {
      const result = await ledger.recordExchangeRate({
        from: origen,
        to: destino,
        date: fecha,
        rate: tipo,
        source: fuente,
      });
      return done(
        { ...showRate(result.rate), operationId: result.operationId },
        "Tipo de cambio registrado.",
      );
    },
  );
  registerTool(
    server,
    "actualizar_tipo_de_cambio_oficial",
    "Consulta el tipo oficial del BCB vigente vía CUCU y lo registra si la fecha aún no tiene uno.",
    z.strictObject({}),
    operation.extend({
      ...rateOutput.shape,
      estado: z.enum(["creado", "existente", "valor_distinto"]),
    }),
    "write",
    async () => {
      const quote = await getOfficialRate();
      const { rate, operationId } = await ledger.recordExchangeRate({
        ...quote,
        from: "USD",
        to: "BOB",
        ifAbsent: true,
      });
      const data = { ...showRate(rate), operationId };
      if (operationId)
        return done(
          { ...data, estado: "creado" as const },
          "Tipo de cambio oficial registrado.",
        );
      if (parseRate(rate.rate) === parseRate(quote.rate))
        return done(
          { ...data, estado: "existente" as const },
          "El tipo de cambio ya estaba registrado.",
        );
      return done(
        { ...data, estado: "valor_distinto" as const },
        `El tipo de cambio registrado (${rate.rate}) difiere del publicado por CUCU (${quote.rate}). Se conservó el valor registrado.`,
      );
    },
  );
  const definition = input.defineCustomField.options[1].shape;
  registerTool(
    server,
    "definir_campo_personalizado",
    "Define un campo para cuentas o movimientos, o archívalo por ID.",
    z.strictObject({
      definicion: z
        .strictObject({
          entidad: definition.entity,
          clave: definition.key,
          etiqueta: definition.label,
          tipo: z.enum(["text", "number", "date", "option"]),
          opciones: definition.options.optional(),
        })
        .optional(),
      archivar: rowId.optional(),
    }),
    operationWithId,
    "destructive",
    async ({ definicion, archivar }) => {
      if (archivar && !definicion)
        return done(
          await ledger.archiveCustomField({ id: archivar }),
          "Campo archivado.",
        );
      if (!definicion || archivar)
        throw new Error("Indica una definición o un ID para archivar.");
      const { entidad, clave, etiqueta, tipo, opciones } = definicion;
      const field = input.defineCustomField.safeParse({
        entity: entidad,
        key: clave,
        label: etiqueta,
        type: tipo,
        ...(opciones === undefined ? {} : { options: opciones }),
      });
      if (!field.success)
        throw new Error(
          "Revisa la definición. Solo los campos de opción requieren una lista de opciones distintas.",
        );
      return done(
        await ledger.defineCustomField(field.data),
        "Campo definido.",
      );
    },
  );
  registerTool(
    server,
    "deshacer_operacion",
    "Revierte una operación auditada, incluido un lote completo.",
    z.strictObject({ operationId: z.uuid() }),
    operation.extend({ etiquetas_conservadas: z.array(rowId) }),
    "destructive",
    async ({ operationId }) => {
      const result = await ledger.undoOperation(operationId);
      return done(
        {
          operationId: result.operationId,
          etiquetas_conservadas: result.retainedTags.map(({ id }) => id),
        },
        "Operación revertida.",
      );
    },
  );
}
