import type { DashboardAccounts, Money } from "@finance-manager/core";
import { useState, type MouseEvent } from "react";
import { useResource, type Api } from "./api";
import { Alert, Amounts, Loading } from "./dashboard-ui";

function totals(accounts: DashboardAccounts["accounts"]): Money[] {
  const currencies = new Map<string, string[]>();
  for (const { balances } of accounts)
    for (const { moneda, monto } of balances)
      currencies.set(moneda, [...(currencies.get(moneda) ?? []), monto]);
  return [...currencies].map(([moneda, amounts]) => {
    const scale = Math.max(
      ...amounts.map((amount) => (amount.split(".")[1] ?? "").length),
    );
    const total = amounts.reduce((sum, amount) => {
      const negative = amount.startsWith("-");
      const [integer, fraction = ""] = amount.replace(/^-/, "").split(".");
      const units = BigInt(integer + fraction.padEnd(scale, "0"));
      return sum + (negative ? -units : units);
    }, 0n);
    const digits = (total < 0n ? -total : total)
      .toString()
      .padStart(scale + 1, "0");
    return {
      moneda,
      monto:
        (total < 0n ? "-" : "") +
        (scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits),
    };
  });
}

export function Accounts({ api }: { api: Api }) {
  const [showArchived, setShowArchived] = useState(false);
  const result = useResource<DashboardAccounts>(api, "/accounts");
  const visible =
    result.data?.accounts.filter(
      ({ kind, archived }) =>
        (kind === "asset" || kind === "liability") &&
        (showArchived || !archived),
    ) ?? [];
  const groups = [
    {
      label: "Activos",
      accounts: visible.filter(({ kind }) => kind === "asset"),
    },
    {
      label: "Pasivos",
      accounts: visible.filter(({ kind }) => kind === "liability"),
    },
  ];
  function openAccount(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    history.pushState(null, "", event.currentTarget.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("#page-title")
        ?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }
  return (
    <>
      <Alert error={result.error} />
      {!result.data && !result.error && <Loading />}
      {result.data && (
        <>
          <section className="panel" aria-label="Totales por moneda">
            <h2>Totales por moneda</h2>
            {groups.map(({ label, accounts }) => (
              <div className="line" key={label}>
                <b>{label}</b>
                {accounts.some(({ balances }) => balances.length) ? (
                  <Amounts values={totals(accounts)} />
                ) : (
                  <span className="hint">Sin saldos</span>
                )}
              </div>
            ))}
          </section>
          <label className="toolbar account-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Mostrar archivadas
          </label>
          {groups.map(({ label, accounts }) => (
            <section className="panel" aria-label={label} key={label}>
              <div className="line">
                <h2>{label}</h2>
                {accounts.some(({ balances }) => balances.length) ? (
                  <Amounts values={totals(accounts)} />
                ) : (
                  <span className="hint">Sin saldos</span>
                )}
              </div>
              {!accounts.length && <p className="hint">Sin cuentas.</p>}
              {accounts.map(({ id, name, path, archived, balances }) => (
                <a
                  className={"line account-row" + (archived ? " archived" : "")}
                  key={id}
                  href={"/movimientos?cuenta=" + encodeURIComponent(id)}
                  onClick={openAccount}
                >
                  <span>
                    <b>{name}</b>
                    <small>{path === name ? label : path}</small>
                    {archived && <span className="badge">Archivada</span>}
                  </span>
                  {balances.length ? (
                    <Amounts values={balances} />
                  ) : (
                    <span className="hint">Sin saldo</span>
                  )}
                </a>
              ))}
            </section>
          ))}
        </>
      )}
    </>
  );
}
