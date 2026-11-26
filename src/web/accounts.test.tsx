// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app";

const accounts = [
  {
    id: "1",
    parentId: null,
    name: "Caja",
    path: "Caja",
    kind: "asset",
    currency: "BOB",
    archived: false,
    balances: [{ moneda: "BOB", monto: "0.10" }],
  },
  {
    id: "2",
    parentId: "1",
    name: "Banco",
    path: "Caja / Banco",
    kind: "asset",
    currency: "BOB",
    archived: false,
    balances: [
      { moneda: "BOB", monto: "0.20" },
      { moneda: "USD", monto: "1234.56" },
    ],
  },
  {
    id: "3",
    parentId: null,
    name: "Deuda",
    path: "Deuda",
    kind: "liability",
    currency: "USD",
    archived: false,
    balances: [{ moneda: "USD", monto: "-10.50" }],
  },
  {
    id: "4",
    parentId: null,
    name: "Sueldo",
    path: "Sueldo",
    kind: "income",
    currency: "BOB",
    archived: false,
    balances: [{ moneda: "BOB", monto: "100.00" }],
  },
  {
    id: "5",
    parentId: null,
    name: "Antigua",
    path: "Antigua",
    kind: "asset",
    currency: "BOB",
    archived: true,
    balances: [{ moneda: "BOB", monto: "9.00" }],
  },
];

function setup(path = "/cuentas") {
  history.replaceState(null, "", path);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const fetchApi = vi.fn(async (url: string) => {
    if (url === "/api/session") return Response.json({ authenticated: true });
    if (url === "/api/accounts") return Response.json({ accounts });
    if (url.startsWith("/api/transactions"))
      return Response.json({ rows: [], cursor: null, dayTotals: {} });
    if (url === "/api/summary")
      return Response.json({
        month: "2026-11",
        previousMonth: "2026-10",
        current: [],
        previous: [],
        liquid: [],
        netWorth: {
          bob: { moneda: "BOB", monto: "0.00" },
          usd: null,
          unvalued: [],
        },
        topCategories: [],
        recent: [],
      });
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetchApi);
  render(<App />);
  return fetchApi;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  localStorage.clear();
});

test("M-020 S1: muestra activos y pasivos con saldos y excluye ingresos", async () => {
  setup();
  expect(await screen.findByRole("heading", { name: "Activos" })).toBeDefined();
  expect(screen.getByRole("heading", { name: "Pasivos" })).toBeDefined();
  expect(screen.getByText("Caja / Banco")).toBeDefined();
  expect(screen.getAllByText("US$ 1.234,56").length).toBeGreaterThan(0);
  expect(screen.getAllByText("−US$ 10,50").length).toBeGreaterThan(0);
  expect(screen.queryByText("Sueldo")).toBeNull();
});

test("M-020 S2: suma exactamente por grupo y moneda", async () => {
  setup();
  const active = await screen.findByRole("region", { name: "Activos" });
  const passive = screen.getByRole("region", { name: "Pasivos" });
  expect(within(active).getByText("Bs 0,30")).toBeDefined();
  expect(within(active).getAllByText("US$ 1.234,56").length).toBeGreaterThan(0);
  expect(within(passive).getAllByText("−US$ 10,50").length).toBeGreaterThan(0);
  expect(within(passive).queryByText("Bs 0,30")).toBeNull();
  const summary = screen.getByRole("region", { name: "Totales por moneda" });
  expect(within(summary).getByText("Bs 0,30")).toBeDefined();
  expect(within(summary).getByText("−US$ 10,50")).toBeDefined();
});

test("M-020 S3: muestra archivadas solo al activar el interruptor", async () => {
  setup();
  await screen.findByRole("heading", { name: "Activos" });
  expect(screen.queryByText("Antigua")).toBeNull();
  fireEvent.click(screen.getByLabelText("Mostrar archivadas"));
  expect(screen.getByText("Antigua")).toBeDefined();
  expect(screen.getByText("Archivada")).toBeDefined();
});

test("M-020 S4: navega a cuentas y abre movimientos filtrados", async () => {
  const fetchApi = setup("/");
  fireEvent.click(await screen.findByRole("link", { name: "Cuentas" }));
  expect(location.pathname).toBe("/cuentas");
  fireEvent.click(await screen.findByRole("link", { name: /Banco/ }));
  expect(location.pathname + location.search).toBe("/movimientos?cuenta=2");
  await waitFor(() =>
    expect(fetchApi).toHaveBeenCalledWith(
      "/api/transactions?account=2",
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Cuenta") as HTMLSelectElement).value).toBe(
      "2",
    ),
  );
});
