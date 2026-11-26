import type {
  DashboardAccounts,
  DashboardMovements,
  DashboardTransaction,
} from "@finance-manager/core";
import { useState, type FormEvent } from "react";
import { usePage, useResource, type Api } from "./api";
import { Button } from "./components/ui/button";
import {
  ActorBadge,
  Alert,
  Amounts,
  Loading,
  Modal,
  More,
  movementAmounts,
  typeLabel,
} from "./dashboard-ui";
import { displayDate } from "./format";

function MovementDetail({
  row,
  close,
}: {
  row: DashboardTransaction;
  close: () => void;
}) {
  return (
    <Modal title={row.description} onClose={close}>
      <div className="toolbar">
        <span className="badge">{typeLabel[row.type]}</span>
        <ActorBadge actor={row.actor} />
        <time dateTime={row.date}>{displayDate(row.date)}</time>
      </div>
      {row.note && <p className="note">{row.note}</p>}
      <dl className="rows">
        {[...row.postings, ...row.categories].map(({ name, money }, index) => (
          <div className="line" key={index}>
            <dt>{name}</dt>
            <dd>
              <Amounts values={[money]} />
            </dd>
          </div>
        ))}
        {row.tags.length > 0 && (
          <div className="line">
            <dt>Etiquetas</dt>
            <dd>{row.tags.map((tag) => "#" + tag).join(", ")}</dd>
          </div>
        )}
        {Object.entries(row.custom ?? {}).map(([field, value]) => (
          <div className="line" key={field}>
            <dt>{field}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="dialog-actions">
        <Button variant="outline" onClick={close} autoFocus>
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}

export function Transactions({ api }: { api: Api }) {
  const [account, setAccount] = useState(
    () => new URLSearchParams(location.search).get("cuenta") ?? "",
  );
  const [filters, setFilters] = useState(() =>
    account ? new URLSearchParams({ account }).toString() : "",
  );
  const [selected, select] = useState<DashboardTransaction>();
  const accounts = useResource<DashboardAccounts>(api, "/accounts");
  const page = usePage<DashboardTransaction, DashboardMovements>(
    api,
    "/transactions" + (filters ? "?" + filters : ""),
    "cursor",
  );
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value.trim())
        params.set(key, value.trim());
    }
    setFilters(params.toString());
  }
  const groups = new Map<string, DashboardTransaction[]>();
  const totals = Object.assign(
    {},
    ...(page.pages?.map(({ dayTotals }) => dayTotals) ?? []),
  ) as DashboardMovements["dayTotals"];
  for (const row of page.data ?? []) {
    const group = groups.get(row.date) ?? [];
    group.push(row);
    groups.set(row.date, group);
  }

  return (
    <>
      <form
        className="panel filters"
        onSubmit={apply}
        onReset={() => {
          setFilters("");
          setAccount("");
        }}
      >
        <label className="search">
          Buscar
          <input
            name="q"
            type="search"
            placeholder="Descripción o nota"
            maxLength={255}
          />
        </label>
        <label>
          Desde
          <input name="from" type="date" min="1000-01-01" max="9999-12-31" />
        </label>
        <label>
          Hasta
          <input name="to" type="date" min="1000-01-01" max="9999-12-31" />
        </label>
        <label>
          Cuenta
          <select
            name="account"
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          >
            <option value="">Todas</option>
            {accounts.data?.accounts
              .filter(({ kind }) => kind === "asset" || kind === "liability")
              .map(({ id, path, archived }) => (
                <option key={id} value={id}>
                  {path}
                  {archived ? " (archivada)" : ""}
                </option>
              ))}
          </select>
        </label>
        <label>
          Categoría
          <select name="category">
            <option value="">Todas</option>
            {accounts.data?.accounts
              .filter(({ kind }) => kind === "income" || kind === "expense")
              .map(({ id, path }) => (
                <option key={id} value={id}>
                  {path}
                </option>
              ))}
          </select>
        </label>
        <label>
          Etiqueta
          <input name="tag" placeholder="Etiqueta" maxLength={120} />
        </label>
        <label>
          Tipo
          <select name="type">
            <option value="">Todos</option>
            <option value="gasto">Gasto</option>
            <option value="ingreso">Ingreso</option>
            <option value="transferencia">Transferencia</option>
          </select>
        </label>
        <div className="toolbar filter-actions">
          <Button type="submit">Filtrar</Button>
          <Button variant="outline" type="reset">
            Limpiar
          </Button>
        </div>
      </form>
      <Alert error={accounts.error} />
      <Alert error={page.error} />
      {!page.data && !page.error && <Loading />}
      {page.data && !page.data.length && (
        <p className="panel hint">Sin movimientos para estos filtros.</p>
      )}
      {page.data?.length ? (
        <section
          className="panel movement-list"
          aria-label="Movimientos por día"
        >
          {[...groups].map(([date, rows]) => {
            const { income = [], expense = [] } = totals[date] ?? {};
            return (
              <section key={date}>
                <div className="day-heading">
                  <h2>
                    <time dateTime={date}>{displayDate(date)}</time>
                  </h2>
                  <div className="day-totals">
                    <span>
                      Ingresos <Amounts values={income} flow="income" />
                    </span>
                    <span>
                      Gastos <Amounts values={expense} flow="expense" />
                    </span>
                  </div>
                </div>
                <ul>
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        className="line movement"
                        onClick={() => select(row)}
                      >
                        <span
                          className={"movement-icon " + row.type}
                          aria-hidden="true"
                        >
                          {
                            {
                              gasto: "↗",
                              ingreso: "↙",
                              transferencia: "⇄",
                              ajuste: "·",
                            }[row.type]
                          }
                        </span>
                        <span className="movement-description">
                          <b>{row.description}</b>
                          <small>
                            {[
                              typeLabel[row.type],
                              ...row.postings.map(({ name }) => name),
                              ...row.categories.map(({ name }) => name),
                              ...row.tags.map((tag) => "#" + tag),
                            ].join(" · ")}
                          </small>
                        </span>
                        {movementAmounts(row)}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </section>
      ) : null}
      <More {...page} />
      {selected && (
        <MovementDetail row={selected} close={() => select(undefined)} />
      )}
    </>
  );
}
