import type { Actor, DashboardTransaction, Money } from "@finance-manager/core";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./components/ui/button";
import { displayMoney } from "./format";

export const typeLabel = {
  gasto: "Gasto",
  ingreso: "Ingreso",
  transferencia: "Transferencia",
  ajuste: "Ajuste",
};

export function ActorBadge({ actor }: { actor: Actor }) {
  return (
    <span className={"badge " + (actor === "claude" ? "claude" : "")}>
      {actor === "claude" ? "Claude" : actor === "web" ? "Web" : "Sistema"}
    </span>
  );
}

export function Amounts({
  values,
  flow,
}: {
  values: Money[];
  flow?: "income" | "expense";
}) {
  const amounts = values.length ? values : [{ moneda: "BOB", monto: "0.00" }];
  return (
    <span className={flow ? "money " + flow : "money"}>
      {amounts.map((value, index) => (
        <span key={value.moneda + index}>{displayMoney(value, flow)}</span>
      ))}
    </span>
  );
}

export function movementAmounts(row: DashboardTransaction) {
  if (row.type === "gasto" || row.type === "ingreso") {
    const flow = row.type === "gasto" ? "expense" : "income";
    return (
      <Amounts
        values={row.categories
          .filter(({ kind }) => kind === flow)
          .map(({ money }) => money)}
        flow={flow}
      />
    );
  }
  return <Amounts values={row.postings.map(({ money }) => money)} />;
}

export function Alert({ error }: { error?: string }) {
  return error ? (
    <p className="alert" role="alert">
      {error}
    </p>
  ) : null;
}

export function Loading() {
  return (
    <p role="status" className="loading">
      Cargando…
    </p>
  );
}

export function More({
  hasMore,
  more,
  moreError,
  pending,
}: {
  hasMore: boolean;
  more: () => void;
  moreError?: string;
  pending: boolean;
}) {
  return (
    <>
      <Alert error={moreError} />
      {hasMore && (
        <Button variant="outline" disabled={pending} onClick={more}>
          {pending ? "Cargando…" : "Cargar más"}
        </Button>
      )}
    </>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="panel"
    >
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
