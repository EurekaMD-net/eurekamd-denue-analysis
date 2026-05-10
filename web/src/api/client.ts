/**
 * Thin fetch wrapper that injects Authorization: Bearer <jwt> from the
 * current Supabase session. Replaces the legacy X-Api-Key path.
 *
 * Token-refresh: supabase-js refreshes the access_token automatically
 * (autoRefreshToken: true). LoginGate subscribes via onAuthStateChange
 * and pushes the new session into the Zustand store, so the next
 * apiFetch picks up the fresh token. On 401 we don't retry here —
 * supabase-js's refresh is preemptive and the LoginGate will catch a
 * subsequent SIGNED_OUT event.
 */

import { useUiStore } from "../store";

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
// Allows: /a, /a/b, /a/b?c=d&e=f.
// Rejects: //evil, /../foo, absolute URLs, query-only paths.
const SAFE_PATH = /^\/[A-Za-z0-9][A-Za-z0-9/_.:?=&%-]*$/;

/**
 * Backward-compatible signature: callers may pass a token string as the
 * third arg (legacy path), or omit it to pull from the Zustand store.
 * The legacy positional value is interpreted as a JWT.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  tokenOverride?: string | null,
): Promise<Response> {
  const token =
    tokenOverride !== undefined
      ? tokenOverride
      : (useUiStore.getState().session?.access_token ?? null);
  if (!token) {
    throw new ApiError("No active session", 401, "no_session");
  }
  if (!SAFE_PATH.test(path) || path.includes("..") || path.startsWith("//")) {
    throw new ApiError(`Invalid path: ${path}`, 400, "bad_path");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
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
