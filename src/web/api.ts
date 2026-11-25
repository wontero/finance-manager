import type { Page } from "@finance-manager/core";
import { useEffect, useState } from "react";

export type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Result<T> = { data?: T; error?: string };

export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo completar la solicitud.";
}

export function useResource<T>(api: Api, path: string, revision = 0) {
  const [result, setResult] = useState<
    Result<T> & { path?: string; revision?: number }
  >({});
  useEffect(() => {
    const abort = new AbortController();
    api<T>(path, { signal: abort.signal }).then(
      (data) => {
        if (!abort.signal.aborted) setResult({ path, revision, data });
      },
      (error: unknown) => {
        if (!abort.signal.aborted)
          setResult({ path, revision, error: errorText(error) });
      },
    );
    return () => abort.abort();
  }, [api, path, revision]);
  return result.path === path && result.revision === revision ? result : {};
}

export function usePage<T, Response extends Page<T> = Page<T>>(
  api: Api,
  path: string,
  cursorKey: "cursor" | "before",
  revision = 0,
) {
  const first = useResource<Response>(api, path, revision);
  const [extra, setExtra] = useState<{
    first?: Response;
    pages: Response[];
    pending: boolean;
    error?: string;
  }>({ pages: [], pending: false });
  const current =
    extra.first === first.data ? extra : { pages: [], pending: false };
  const cursor =
    current.pages.at(-1)?.cursor ??
    (current.pages.length ? null : first.data?.cursor);
  const more = async () => {
    if (!cursor || current.pending) return;
    const base = first.data;
    setExtra({ first: base, pages: current.pages, pending: true });
    try {
      const page = await api<Response>(
        path +
          (path.includes("?") ? "&" : "?") +
          cursorKey +
          "=" +
          encodeURIComponent(cursor),
      );
      setExtra((state) =>
        state.first === base
          ? { first: base, pages: [...state.pages, page], pending: false }
          : state,
      );
    } catch (error) {
      setExtra((state) =>
        state.first === base
          ? { ...state, pending: false, error: errorText(error) }
          : state,
      );
    }
  };
  const pages = first.data ? [first.data, ...current.pages] : undefined;
  return {
    data: pages?.flatMap(({ rows }) => rows),
    pages,
    error: first.error,
    moreError: current.error,
    pending: current.pending,
    hasMore: Boolean(cursor),
    more,
  };
}
