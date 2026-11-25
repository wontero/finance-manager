import type { DashboardReports } from "@finance-manager/core";
import { useState, type FormEvent } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useResource, type Api } from "./api";
import { Button } from "./components/ui/button";
import { Alert, Amounts, Loading } from "./dashboard-ui";
import { displayMoney, displayMonth } from "./format";

export function Reports({ api }: { api: Api }) {
  const [range, setRange] = useState("");
  const [currency, setCurrency] = useState("BOB");
  const { data, error } = useResource<DashboardReports>(
    api,
    "/reports" + (range ? "?" + range : ""),
  );
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value) params.set(key, value);
    }
    setRange(params.toString());
  }
  const currencies = [
    ...new Set([
      "BOB",
      ...(data?.months.flatMap(({ totals }) =>
        totals.map(({ income }) => income.moneda),
      ) ?? []),
      ...(data?.categories.flatMap(({ amounts }) =>
        amounts.map(({ moneda }) => moneda),
      ) ?? []),
    ]),
  ];
  const activeCurrency = currencies.includes(currency) ? currency : "BOB";
  const chartMonths =
    data?.months.map(({ month, totals, netWorth }) => {
      const flow = totals.find(
        ({ income }) => income.moneda === activeCurrency,
      );
      return {
        month,
        label: month.slice(5) + "/" + month.slice(2, 4),
        income: flow?.income.monto ?? "0.00",
        expense: flow?.expense.monto ?? "0.00",
        worth: netWorth.bob.monto,
        partial: !!netWorth.unvalued.length,
      };
    }) ?? [];
  const flowChart = chartMonths.map((value) => ({
    ...value,
    income: Number(value.income),
    expense: Number(value.expense),
  }));
  const worthChart = chartMonths.map((value) => ({
    ...value,
    worth: Number(value.worth),
  }));

  return (
    <>
      <form
        className="panel filters report-filters"
        onSubmit={apply}
        onReset={() => setRange("")}
      >
        <label>
          Desde
          <input name="from" type="date" min="1000-01-01" max="9999-12-31" />
        </label>
        <label>
          Hasta
          <input name="to" type="date" min="1000-01-01" max="9999-12-31" />
        </label>
        <div className="toolbar filter-actions">
          <Button type="submit">Aplicar período</Button>
          <Button variant="outline" type="reset">
            Últimos 12 meses
          </Button>
        </div>
      </form>
      <Alert error={error} />
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="report-grid">
            <section className="panel">
              <div className="toolbar between">
                <h2>Ingresos y gastos</h2>
                <label className="toolbar">
                  Moneda
                  <select
                    value={activeCurrency}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    {currencies.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="chart">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 320, height: 260 }}
                >
                  <BarChart data={flowChart} accessibilityLayer>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--muted)" }}
                      minTickGap={16}
                    />
                    <YAxis width={58} tick={{ fill: "var(--muted)" }} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        borderColor: "var(--border)",
                        color: "var(--text)",
                      }}
                      formatter={(_value, _name, item) => {
                        const point = chartMonths.find(
                          ({ label }) => label === item.payload.label,
                        );
                        return point
                          ? displayMoney({
                              moneda: activeCurrency,
                              monto:
                                item.dataKey === "income"
                                  ? point.income
                                  : point.expense,
                            })
                          : "";
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="income"
                      name="Ingresos"
                      fill="var(--chart-in)"
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="expense"
                      name="Gastos"
                      fill="var(--chart-out)"
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <h2>Gastos por categoría</h2>
              <ul className="rows">
                {data.categories.map(({ id, name, amounts }) => (
                  <li className="line" key={id}>
                    <b>{name}</b>
                    <Amounts values={amounts} flow="expense" />
                  </li>
                ))}
              </ul>
              {!data.categories.length && (
                <p className="hint">Sin gastos en el período.</p>
              )}
            </section>
            <section className="panel full">
              <h2>Evolución del patrimonio</h2>
              <p className="hint">Patrimonio al cierre de cada mes, en Bs.</p>
              {chartMonths.some(({ partial }) => partial) && (
                <p className="hint">
                  Algunos meses tienen saldos sin cotización. Su patrimonio es
                  parcial.
                </p>
              )}
              <div className="chart">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 320, height: 260 }}
                >
                  <AreaChart data={worthChart} accessibilityLayer>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--muted)" }}
                      minTickGap={18}
                    />
                    <YAxis width={58} tick={{ fill: "var(--muted)" }} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        borderColor: "var(--border)",
                        color: "var(--text)",
                      }}
                      formatter={(_value, _name, item) => {
                        const point = chartMonths.find(
                          ({ label }) => label === item.payload.label,
                        );
                        return point
                          ? displayMoney({ moneda: "BOB", monto: point.worth })
                          : "";
                      }}
                    />
                    <Area
                      dataKey="worth"
                      name="Patrimonio"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      fill="var(--accent-soft)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <details>
                <summary>Ver cifras mensuales</summary>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Cifras mensuales"
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Mes</th>
                        <th scope="col">Ingresos</th>
                        <th scope="col">Gastos</th>
                        <th scope="col">Patrimonio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chartMonths.map(
                        ({ month, income, expense, worth, partial }) => (
                          <tr key={month}>
                            <th scope="row">{displayMonth(month)}</th>
                            <td>
                              <Amounts
                                values={[
                                  { moneda: activeCurrency, monto: income },
                                ]}
                                flow="income"
                              />
                            </td>
                            <td>
                              <Amounts
                                values={[
                                  { moneda: activeCurrency, monto: expense },
                                ]}
                                flow="expense"
                              />
                            </td>
                            <td>
                              <Amounts
                                values={[{ moneda: "BOB", monto: worth }]}
                              />
                              {partial && <small>Parcial</small>}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          </div>
        </>
      )}
    </>
  );
}
