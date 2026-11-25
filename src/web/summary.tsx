import type { DashboardSummary, PeriodTotals } from "@finance-manager/core";
import { useState } from "react";
import { useResource, type Api } from "./api";
import { Alert, Amounts, Loading, movementAmounts } from "./dashboard-ui";
import { displayDate, displayMoney, displayMonth } from "./format";

function MonthComparison({
  months,
}: {
  months: { month: string; totals: PeriodTotals }[];
}) {
  const currencies = [
    ...new Set(
      months.flatMap(({ totals }) => totals.map(({ income }) => income.moneda)),
    ),
  ];
  return (
    <section className="panel">
      <h2>Ingresos y gastos</h2>
      <div className="comparison">
        {currencies.map((moneda) => {
          const values = months.map(({ month, totals }) => ({
            month,
            ...totals.find(({ income }) => income.moneda === moneda),
          }));
          const max = Math.max(
            1,
            ...values.flatMap(({ income, expense }) => [
              Math.abs(Number(income?.monto ?? 0)),
              Math.abs(Number(expense?.monto ?? 0)),
            ]),
          );
          return (
            <div className="comparison-currency" key={moneda}>
              {values.map(({ month, ...value }) => (
                <div key={month}>
                  <h3>{displayMonth(month)}</h3>
                  {(["income", "expense"] as const).map((flow) => {
                    const money = value[flow] ?? { moneda, monto: "0.00" };
                    const label = flow === "income" ? "Ingresos" : "Gastos";
                    return (
                      <div className="comparison-item" key={flow}>
                        <span>{label}</span>
                        <b className={flow}>{displayMoney(money, flow)}</b>
                        <span className="comparison-track" aria-hidden="true">
                          <span
                            className={flow}
                            style={{
                              width:
                                (Math.abs(Number(money.monto)) / max) * 100 +
                                "%",
                            }}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Summary({ api }: { api: Api }) {
  const [month, setMonth] = useState("");
  const [usd, setUsd] = useState(false);
  const { data, error } = useResource<DashboardSummary>(
    api,
    "/summary" + (month ? "?month=" + month : ""),
  );
  if (!data && !month) return error ? <Alert error={error} /> : <Loading />;
  const flows = (period: PeriodTotals, kind: "income" | "expense") => (
    <Amounts values={period.map((row) => row[kind])} flow={kind} />
  );

  return (
    <>
      <div className="section-heading">
        <h2>{data ? displayMonth(data.month) : "Resumen del mes"}</h2>
        <label className="toolbar">
          <span>Mes</span>
          <input
            type="month"
            min="1000-01"
            max="9999-12"
            value={month || data?.month || ""}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
      </div>
      <Alert error={error} />
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="metrics">
            <section className="panel metric">
              <div className="toolbar between">
                <h3>Patrimonio total</h3>
                <div
                  className="segments"
                  role="group"
                  aria-label="Moneda del patrimonio"
                >
                  <button
                    aria-pressed={!usd || !data.netWorth.usd}
                    onClick={() => setUsd(false)}
                  >
                    Bs
                  </button>
                  <button
                    aria-pressed={usd && !!data.netWorth.usd}
                    disabled={!data.netWorth.usd}
                    aria-describedby={data.netWorth.usd ? undefined : "no-fx"}
                    onClick={() => setUsd(true)}
                  >
                    US$
                  </button>
                </div>
              </div>
              <strong>
                <Amounts
                  values={[
                    usd && data.netWorth.usd
                      ? data.netWorth.usd
                      : data.netWorth.bob,
                  ]}
                />
              </strong>
              {!data.netWorth.usd && (
                <p id="no-fx" className="hint">
                  Sin tipo de cambio para mostrar US$.
                </p>
              )}
              {!!data.netWorth.unvalued.length && (
                <p className="hint">
                  Patrimonio parcial. Sin cotización para{" "}
                  {data.netWorth.unvalued.join(", ")}.
                </p>
              )}
            </section>
            <section className="panel metric">
              <h3>Disponible líquido</h3>
              <strong>
                <Amounts values={data.liquid} />
              </strong>
              <p className="hint">Efectivo y bancos</p>
            </section>
            <section className="panel metric">
              <h3>Ingresos del mes</h3>
              <strong>{flows(data.current, "income")}</strong>
              <p className="hint">
                Mes anterior {flows(data.previous, "income")}
              </p>
            </section>
            <section className="panel metric">
              <h3>Gastos del mes</h3>
              <strong>{flows(data.current, "expense")}</strong>
              <p className="hint">
                Mes anterior {flows(data.previous, "expense")}
              </p>
            </section>
          </div>
          <div className="summary-grid">
            <MonthComparison
              months={[
                { month: data.previousMonth, totals: data.previous },
                { month: data.month, totals: data.current },
              ]}
            />
            <section className="panel recent">
              <h2>Últimos movimientos</h2>
              {data.recent.length ? (
                <ul className="rows">
                  {data.recent.map((row) => (
                    <li key={row.id} className="line">
                      <div>
                        <b>{row.description}</b>
                        <small>
                          {displayDate(row.date)}
                          {row.categories.length
                            ? " · " +
                              row.categories.map(({ name }) => name).join(", ")
                            : ""}
                        </small>
                      </div>
                      {movementAmounts(row)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">Sin movimientos en el mes.</p>
              )}
            </section>
            <section className="panel">
              <h2>Principales gastos</h2>
              {data.topCategories.length ? (
                <ul className="rows">
                  {data.topCategories.map(({ id, name, amounts }) => (
                    <li className="line" key={id}>
                      <b>{name}</b>
                      <Amounts values={amounts} flow="expense" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">Sin gastos en el mes.</p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
