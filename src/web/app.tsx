import type { DashboardSession } from "@finance-manager/core";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
} from "react";
import { Activity } from "./activity";
import { Accounts } from "./accounts";
import { errorText, type Api } from "./api";
import { Button } from "./components/ui/button";
import { Alert, Loading } from "./dashboard-ui";
import { Summary } from "./summary";
import { Transactions } from "./transactions";

const Reports = lazy(() =>
  import("./reports").then(({ Reports }) => ({ default: Reports })),
);

const pages = [
  {
    path: "/",
    label: "Resumen",
    title: "Resumen",
    icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    Screen: Summary,
  },
  {
    path: "/cuentas",
    label: "Cuentas",
    title: "Cuentas",
    icon: "M3 6h18v13H3zM3 9h18M16 15h2",
    Screen: Accounts,
  },
  {
    path: "/movimientos",
    label: "Movimientos",
    title: "Movimientos",
    icon: "M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4",
    Screen: Transactions,
  },
  {
    path: "/informes",
    label: "Informes",
    title: "Informes",
    icon: "M4 4v16h17M8 15v-4m5 4V8m5 7V5",
    Screen: Reports,
  },
  {
    path: "/actividad",
    label: "Actividad",
    title: "Actividad de Claude",
    icon: "M12 7v5l3 2M4 4v5h5M4 9a9 9 0 1 1-.2 5",
    Screen: Activity,
  },
] as const;

function currentPage() {
  return pages.find(({ path }) => path === location.pathname) ?? pages[0];
}

type Theme = "system" | "light" | "dark";
function readTheme(): Theme {
  try {
    const value = localStorage.getItem("fm-theme");
    if (value === "light" || value === "dark") return value;
  } catch {
    /* El almacenamiento puede estar deshabilitado. */
  }
  return "system";
}

function ThemePicker() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <label className="theme-picker">
      <span className="sr-only">Tema</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <path d="M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8Zm0 0v16" />
      </svg>
      <select
        value={theme}
        onChange={(event) => {
          const value = event.target.value as Theme;
          setTheme(value);
          try {
            localStorage.setItem("fm-theme", value);
          } catch {
            /* El tema sigue funcionando en esta sesión. */
          }
        }}
      >
        <option value="system">Sistema</option>
        <option value="light">Claro</option>
        <option value="dark">Oscuro</option>
      </select>
    </label>
  );
}

function Brand() {
  return (
    <span className="brand">
      <span className="brandmark" aria-hidden="true">
        F
      </span>
      Finance Manager
    </span>
  );
}

export function App() {
  const [session, setSession] = useState<"checking" | "anonymous" | "active">(
    "checking",
  );
  const [page, setPage] = useState(currentPage);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const api = useCallback<Api>(
    async <T,>(path: string, options?: RequestInit): Promise<T> => {
      const response = await fetch("/api" + path, options);
      if (response.status === 401 && !options?.signal?.aborted)
        setSession("anonymous");
      if (response.status === 204) return undefined as T;
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "No se pudo completar la solicitud.");
      return data as T;
    },
    [],
  );

  useEffect(() => {
    const abort = new AbortController();
    api<DashboardSession>("/session", { signal: abort.signal }).then(
      () => {
        if (!abort.signal.aborted) setSession("active");
      },
      () => {
        if (!abort.signal.aborted) setSession("anonymous");
      },
    );
    return () => abort.abort();
  }, [api]);

  useEffect(() => {
    const update = () => setPage(currentPage());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function navigate(event: MouseEvent<HTMLAnchorElement>, target: typeof page) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (location.pathname !== target.path)
      history.pushState(null, "", target.path);
    setPage(target);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("#page-title")
        ?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }

  async function logout() {
    setPending(true);
    setError(undefined);
    try {
      await api<void>("/session", { method: "DELETE" });
      setSession("anonymous");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }

  if (session !== "active")
    return (
      <main className="login">
        <section className="panel login-panel">
          <div className="toolbar between">
            <Brand />
            <ThemePicker />
          </div>
          {session === "checking" ? (
            <Loading />
          ) : (
            <>
              <Button asChild>
                <a href="/auth/google/start">Iniciar sesión con Google</a>
              </Button>
            </>
          )}
        </section>
      </main>
    );

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Principal">
          {pages.map((item) => (
            <a
              key={item.path}
              href={item.path}
              aria-current={page === item ? "page" : undefined}
              onClick={(event) => navigate(event, item)}
            >
              <svg
                aria-hidden="true"
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={item.icon} />
              </svg>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <h1 id="page-title" tabIndex={-1}>
            {page.title}
          </h1>
          <div className="toolbar">
            <ThemePicker />
            <Button variant="outline" disabled={pending} onClick={logout}>
              Cerrar sesión
            </Button>
          </div>
        </header>
        <main className="content">
          <Alert error={error} />
          <Suspense fallback={<Loading />}>
            <page.Screen api={api} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
