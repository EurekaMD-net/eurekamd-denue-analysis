/**
 * Thin fetch wrapper that injects X-Api-Key from the Zustand store.
 * Endpoints land in src/api/queries.ts (TanStack Query hooks) — added in P1.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Reject anything that could escape the /api/ prefix or hit a different host.
// Allows: /a, /a/b, /a/b?c=d&e=f, /a:b (port-style not used but cheap).
// Rejects: //evil, /../foo, absolute URLs, query-only paths.
const SAFE_PATH = /^\/[A-Za-z0-9][A-Za-z0-9/_.:?=&%-]*$/;

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  apiKey: string | null,
): Promise<Response> {
  if (!apiKey) {
    throw new ApiError("Missing API key", 401, "no_api_key");
  }
  if (!SAFE_PATH.test(path) || path.includes("..") || path.startsWith("//")) {
    throw new ApiError(`Invalid path: ${path}`, 400, "bad_path");
  }
  const headers = new Headers(init.headers);
  headers.set("X-Api-Key", apiKey);
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const res = await fetch(`/api${path}`, { ...init, headers, signal });
  if (!res.ok) {
    let body: { error?: string; code?: string } = {};
    try {
      body = await res.clone().json();
    } catch {
      // non-JSON error body — fall back to statusText
    }
    throw new ApiError(
      body.error ?? res.statusText ?? `HTTP ${res.status}`,
      res.status,
      body.code,
    );
  }
  return res;
}
