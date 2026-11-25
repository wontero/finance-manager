import {
  accountingDate,
  ledgerInputs,
  rowId,
  todayLaPaz,
  type DashboardSession,
  type DashboardUndo,
} from "@finance-manager/core";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { AuthConfig } from "./auth-provider.js";
import type { AuthDb } from "./auth-store.js";
import { UndoConflict } from "./ledger/audit.js";
import { shiftMonth } from "./ledger/dashboard.js";
import { createLedger } from "./ledger/index.js";
import { webSession } from "./web-session.js";

const limit = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .transform(Number)
  .pipe(z.number().max(100));
const cursor = z
  .string()
  .max(31)
  .transform((value, ctx) => {
    const [date, id, extra] = value.split(":");
    if (
      extra !== undefined ||
      !accountingDate.safeParse(date).success ||
      !rowId.safeParse(id).success
    ) {
      ctx.addIssue({ code: "custom", message: "Cursor inválido." });
      return z.NEVER;
    }
    return { date, id };
  });
const monthInput = z
  .string()
  .refine((value) => accountingDate.safeParse(value + "-01").success);
const period = {
  from: accountingDate.optional(),
  to: accountingDate.optional(),
};
const queryPeriod = z.strictObject(period).refine(ordered);
const transactionQuery = z
  .strictObject({
    ...period,
    account: rowId.optional(),
    category: rowId.optional(),
    tag: z.string().trim().min(1).max(120).optional(),
    q: z.string().trim().min(1).max(255).optional(),
    type: z.enum(["gasto", "ingreso", "transferencia"]).optional(),
    cursor: cursor.optional(),
    limit: limit.prefault("50"),
  })
  .refine(ordered);
const operationsQuery = z.strictObject({
  before: rowId.optional(),
  limit: limit.prefault("20"),
});

function ordered({ from, to }: { from?: string; to?: string }) {
  return !from || !to || from <= to;
}

export function dashboardApi(config: AuthConfig, db?: AuthDb) {
  const router = express.Router({ strict: true });
  const session = webSession(config.issuer.protocol === "https:");
  const ledger = db && createLedger(db, "web");
  const authenticated: DashboardSession = { authenticated: true };

  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.get("Origin") !== config.issuer.origin
    ) {
      response
        .status(403)
        .json({ error: "Origen de la solicitud no autorizado." });
      return;
    }
    next();
  });

  router.post("/session", express.json({ limit: "4kb" }), (request, response) =>
    session.login(db, request, response),
  );

  router.use(async (request, response, next) => {
    const hash = db && (await session.find(db, request));
    if (!db || !hash) {
      response.status(401).json({ error: "Inicia sesión para continuar." });
      return;
    }
    if (
      request.method === "DELETE" &&
      request.path.toLowerCase() === "/session"
    ) {
      await session.logout(db, hash, response);
      return;
    }
    next();
  });

  router.get("/session", (_request, response) => response.json(authenticated));
  router.get("/summary", async (request, response) => {
    const { month = todayLaPaz().slice(0, 7) } = z
      .strictObject({ month: monthInput.optional() })
      .parse(request.query);
    response.json(await ledger!.dashboardSummary(month));
  });
  router.get("/accounts", async (_request, response) =>
    response.json(await ledger!.dashboardAccounts()),
  );
  router.get("/transactions", async (request, response) => {
    const {
      account,
      category,
      q,
      cursor: before,
      ...input
    } = transactionQuery.parse(request.query);
    response.json(
      await ledger!.dashboardTransactions({
        ...input,
        accountId: account,
        categoryId: category,
        text: q,
        before,
        includeDayTotals: true,
      }),
    );
  });
  router.get("/reports", async (request, response) => {
    const { from, to = todayLaPaz() } = queryPeriod.parse(request.query);
    const start = from ?? shiftMonth(to.slice(0, 7), -11) + "-01";
    const monthIndex = (date: string) =>
      Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
    if (start > to || monthIndex(to) - monthIndex(start) >= 60) {
      response
        .status(400)
        .json({ error: "Selecciona un rango ordenado de hasta 60 meses." });
      return;
    }
    response.json(await ledger!.dashboardReports(start, to));
  });
  router.get("/operations", async (request, response) => {
    const { before, limit } = operationsQuery.parse(request.query);
    response.json(await ledger!.dashboardOperations(limit, before));
  });
  router.post("/operations/:id/undo", async (request, response) => {
    const { id } = ledgerInputs.undoOperation.parse(request.params);
    const result = await ledger!.undoOperation(id);
    const payload: DashboardUndo = { operationId: result.operationId };
    response.json(payload);
  });
  router.use((_request, response) =>
    response.status(404).json({ error: "Ruta de la API desconocida." }),
  );
  router.use(apiError);
  return router;
}

const apiError: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) return next(error);
  if (
    error instanceof z.ZodError ||
    error?.type === "entity.parse.failed" ||
    error?.status === 400
  ) {
    response.status(400).json({ error: "Revisa los datos de la solicitud." });
  } else if (error?.type === "entity.too.large") {
    response.status(413).json({ error: "La solicitud es demasiado grande." });
  } else if (error instanceof UndoConflict) {
    response.status(409).json({ error: error.message });
  } else {
    console.error(
      "Error de la API del dashboard",
      error instanceof Error ? error.name : "desconocido",
    );
    response.status(500).json({ error: "No se pudo completar la solicitud." });
  }
};
