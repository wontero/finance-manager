import { useState, type FormEvent } from "react";
import { errorText, type Api } from "./api";
import { Button } from "./components/ui/button";
import { Alert } from "./dashboard-ui";

export function Account({
  api,
  onDeleted,
}: {
  api: Api;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [reauth, setReauth] = useState(false);

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== "BORRAR" || pending) return;
    setPending(true);
    setError(undefined);
    setReauth(false);
    try {
      await api<void>("/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      onDeleted();
    } catch (error) {
      setError(errorText(error));
      setReauth(
        error instanceof Error && "status" in error && error.status === 428,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section className="panel" aria-label="Exportar mis datos">
        <Button asChild variant="outline">
          <a href="/api/account/export" download>
            Exportar mis datos (JSON)
          </a>
        </Button>
      </section>
      <section className="panel" aria-labelledby="delete-account">
        <h2 id="delete-account">Borrar mi cuenta</h2>
        <p>
          Se borrará tu cuenta y sus datos de forma permanente. Escribe BORRAR
          para confirmar.
        </p>
        {new URLSearchParams(location.search).has("reauth") && (
          <p role="status">Escribe BORRAR de nuevo para continuar.</p>
        )}
        <form className="toolbar" onSubmit={remove}>
          <label htmlFor="confirmation">Confirmación</label>
          <input
            id="confirmation"
            value={confirmation}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <Button
            type="submit"
            variant="destructive"
            disabled={confirmation !== "BORRAR" || pending}
          >
            Borrar mi cuenta
          </Button>
        </form>
        <Alert error={error} />
        {reauth && (
          <form action="/auth/google/reauth" method="post">
            <Button type="submit" variant="outline">
              Volver a iniciar sesión con Google
            </Button>
          </form>
        )}
      </section>
    </>
  );
}
