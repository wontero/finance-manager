// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app";
import { displayDate, displayMoney } from "./format";

const bob = { moneda: "BOB", monto: "1234.56" };
const row = {
  id: "1",
  date: "2026-11-24",
  description: "Almuerzo",
  note: "Para llevar",
  custom: null,
  actor: "claude",
  type: "gasto",
  tags: ["trabajo"],
  postings: [],
  categories: [],
};
const operation = {
  id: "1",
  date: "2026-11-24T16:00:00Z",
  description: "Registrar almuerzo",
  actor: "claude",
  changes: [{ entity: "Movimiento", before: null, after: "Almuerzo" }],
  canUndo: true,
  undone: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  localStorage.clear();
});

test("M-015 S7: login, cuatro pantallas con datos, confirmar undo y volver al login ante 401", async () => {
  let active = false;
  let undone = false;
  const fetchApi = vi.fn(async (url: string, options?: RequestInit) => {
    const route = url.split("?")[0];
    if (!active)
      return Response.json({ error: "Inicia sesión." }, { status: 401 });
    switch (route) {
      case "/api/session":
        return Response.json({ authenticated: true });
      case "/api/summary":
        return Response.json({
          month: "2026-11",
          previousMonth: "2026-10",
          current: [],
          previous: [],
          liquid: [],
          netWorth: { bob, usd: null, unvalued: [] },
          topCategories: [],
          recent: [row],
        });
      case "/api/accounts":
        return Response.json({ accounts: [] });
      case "/api/transactions":
        return Response.json({ rows: [row], cursor: null, dayTotals: {} });
      case "/api/reports":
        return Response.json({
          categories: [{ id: "1", name: "Comida", amounts: [bob] }],
          months: [
            {
              month: "2026-11",
              totals: [],
              netWorth: { bob, usd: null, unvalued: [] },
            },
          ],
        });
      case "/api/operations":
        return Response.json({
          rows: [{ ...operation, undone, canUndo: !undone }],
          cursor: null,
        });
      case "/api/operations/1/undo":
        expect(options?.method).toBe("POST");
        undone = true;
        return Response.json({ operationId: "2" });
      default:
        throw new Error("Ruta inesperada: " + url);
    }
  });
  vi.stubGlobal("fetch", fetchApi);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    },
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<App />);
  expect(
    (
      await screen.findByRole("link", { name: "Iniciar sesión con Google" })
    ).getAttribute("href"),
  ).toBe("/auth/google/start");
  cleanup();
  active = true;
  render(<App />);
  expect(await screen.findByText("Bs 1.234,56")).toBeDefined();
  fireEvent.click(screen.getByRole("link", { name: "Movimientos" }));
  fireEvent.click(await screen.findByText("Almuerzo"));
  expect(await screen.findByText("Para llevar")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  fireEvent.click(screen.getByRole("link", { name: "Informes" }));
  expect(
    await screen.findByText("Comida", undefined, { timeout: 5_000 }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("link", { name: "Actividad" }));
  expect(await screen.findByText("Registrar almuerzo")).toBeDefined();
  fireEvent.click(await screen.findByRole("button", { name: "Deshacer" }));
  expect(screen.getByRole("dialog")).toBeDefined();
  expect(undone).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirmar deshacer" }));
  expect(await screen.findByText("Deshecha")).toBeDefined();
  active = false;
  fireEvent.click(screen.getByRole("link", { name: "Resumen" }));
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "Iniciar sesión con Google" }),
    ).toBeDefined(),
  );
});

test("M-015 S7: los formatos es-BO conservan decimales y fechas contables", () => {
  expect(displayMoney(bob)).toBe("Bs 1.234,56");
  expect(displayMoney({ monto: "-12345678901234567.89", moneda: "USD" })).toBe(
    "−US$ 12.345.678.901.234.567,89",
  );
  expect(displayDate("2026-11-24")).toBe("24/11/2026");
});
