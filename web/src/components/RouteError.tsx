import { useEffect } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { reloadPage } from "../lib/reload";

// Chrome/Edge, Safari and Firefox wording for a rejected `import()`.
// After a redeploy the hashed chunk names change, so a tab still running
// the old index asks for a chunk that no longer exists.
const CHUNK_LOAD_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/;

export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return CHUNK_LOAD_ERROR_RE.test(msg);
}

const RELOAD_KEY = "denue:chunk-reload-at";
const RELOAD_WINDOW_MS = 10_000;

/**
 * Reload to pick up the new index + chunks. Returns false without
 * reloading when we already reloaded in the last few seconds (the chunk
 * is really missing, not stale) or storage is blocked, so a broken
 * deploy shows the error instead of looping.
 */
export function reloadForStaleChunk(now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reloadPage();
  return true;
}

/**
 * Route-level errorElement (audit #178). Without one, react-router's
 * default "Unexpected Application Error!" page replaced the whole app.
 * Set on every child route so the Layout header and nav stay up.
 */
export function RouteError() {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  useEffect(() => {
    if (chunk) reloadForStaleChunk();
  }, [chunk]);

  const message = chunk
    ? "Hay una versión nueva de la aplicación. Recargando…"
    : isRouteErrorResponse(error)
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-6">
      <div className="max-w-md rounded border border-red-700 bg-red-950 p-4 font-mono text-sm text-red-200">
        <div className="mb-2 font-semibold">Algo se rompió.</div>
        <pre className="whitespace-pre-wrap break-words text-xs text-red-300">
          {message}
        </pre>
        <button
          type="button"
          onClick={reloadPage}
          className="mt-3 rounded bg-red-700 px-3 py-1 text-xs hover:bg-red-600"
        >
          Recargar
        </button>
      </div>
    </div>
  );
}
