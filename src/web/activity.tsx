import type { DashboardOperation, DashboardUndo } from "@finance-manager/core";
import { useState } from "react";
import { errorText, usePage, type Api } from "./api";
import { Button } from "./components/ui/button";
import { ActorBadge, Alert, Loading, Modal, More } from "./dashboard-ui";
import { displayDate, displayTime } from "./format";

export function Activity({ api }: { api: Api }) {
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<DashboardOperation>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const page = usePage<DashboardOperation>(
    api,
    "/operations",
    "before",
    revision,
  );
  const groups = new Map<string, DashboardOperation[]>();
  for (const operation of page.data ?? []) {
    const date = displayDate(operation.date);
    const group = groups.get(date) ?? [];
    group.push(operation);
    groups.set(date, group);
  }

  async function undo() {
    if (!target || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await api<DashboardUndo>(
        "/operations/" + encodeURIComponent(target.id) + "/undo",
        { method: "POST" },
      );
      setTarget(undefined);
      setNotice("Operación deshecha.");
      setRevision(revision + 1);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  function ask(operation: DashboardOperation) {
    setError(undefined);
    setNotice(undefined);
    setTarget(operation);
  }

  return (
    <>
      <p role="status">{notice}</p>
      <Alert error={page.error} />
      {!page.data && !page.error && <Loading />}
      {page.data && !page.data.length && (
        <p className="panel hint">Todavía no hay operaciones.</p>
      )}
      <div className="timeline">
        {[...groups].map(([date, rows]) => (
          <section key={date} className="timeline-day">
            <h2>{date}</h2>
            <ol>
              {rows.map((operation) => (
                <li key={operation.id} className="panel operation">
                  <div className="toolbar">
                    <ActorBadge actor={operation.actor} />
                    <time className="hint" dateTime={operation.date}>
                      {displayTime(operation.date)}
                    </time>
                    {operation.undone && (
                      <span className="badge">Deshecha</span>
                    )}
                    <span className="badge count">
                      {operation.changes.length}{" "}
                      {operation.changes.length === 1 ? "cambio" : "cambios"}
                    </span>
                  </div>
                  <h3>{operation.description}</h3>
                  {operation.changes.length > 0 && (
                    <details>
                      <summary>Ver cambios</summary>
                      <ul className="changes">
                        {operation.changes.map(
                          ({ entity, before, after }, index) => (
                            <li key={index}>
                              <strong>{entity}</strong>
                              <div className="change-values">
                                <div>
                                  <small>Antes</small>
                                  <p>{before ?? "Sin registro"}</p>
                                </div>
                                <span aria-hidden="true">→</span>
                                <div>
                                  <small>Después</small>
                                  <p>{after ?? "Sin registro"}</p>
                                </div>
                              </div>
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  )}
                  {operation.canUndo && (
                    <Button
                      variant="outline"
                      className="undo"
                      onClick={() => ask(operation)}
                    >
                      Deshacer
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <More {...page} />
      {target && (
        <Modal
          title="¿Deshacer operación?"
          onClose={() => {
            if (!pending) setTarget(undefined);
          }}
        >
          <p className="note">
            Se revertirán los cambios de «{target.description}».
          </p>
          <Alert error={error} />
          <div className="dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              autoFocus
              onClick={() => setTarget(undefined)}
            >
              Cancelar
            </Button>
            <Button variant="destructive" disabled={pending} onClick={undo}>
              {pending ? "Deshaciendo…" : "Confirmar deshacer"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
