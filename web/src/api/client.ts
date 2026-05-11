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

// RH-10: split path + query at the first `?`. The path portion may not
// itself contain `?=&` (those belong on the query string only); the
// query portion may not contain `/` or path traversal sequences. The
// pre-split single-regex approach allowed `/foo?bar?baz` and any
// querystring-shaped junk *inside* the path, which made callers easy
// to misuse.
//
// Allows: /a, /a/b, /a/b?c=d&e=f, /sage/query
// Rejects: //evil, /../foo, ?query-only, /a?b/c (slashes in query),
// /a?b?c (multiple ?), /a%5C../b (encoded traversal).
const SAFE_PATH_ONLY = /^\/[A-Za-z0-9][A-Za-z0-9/_.%-]*$/;
// Allow the full `encodeURIComponent` passthrough set in querystrings:
// RFC 3986 leaves `! ~ * ' ( )` unreserved (encodeURIComponent does NOT
// percent-encode them). A user searching "Domino's" or "(Sucursal)"
// would otherwise be 400'd by SAFE_QUERY. Caught by Phase 2 audit C1.
const SAFE_QUERY = /^[A-Za-z0-9._=&%~!*'()-]*$/;

export function validateApiPath(path: string): {
  ok: boolean;
  reason?: string;
} {
  if (typeof path !== "string" || path.length === 0)
    return { ok: false, reason: "empty" };
  // Defense against encoded traversal slipping through length-limited regexes.
  const lower = path.toLowerCase();
  if (lower.includes("..") || lower.includes("%2e%2e"))
    return { ok: false, reason: "traversal" };
  if (path.startsWith("//")) return { ok: false, reason: "protocol-relative" };
  const qIdx = path.indexOf("?");
  const pathOnly = qIdx === -1 ? path : path.slice(0, qIdx);
  const queryOnly = qIdx === -1 ? "" : path.slice(qIdx + 1);
  // Reject paths with a second `?` (the only legal `?` is the separator).
  if (queryOnly.includes("?")) return { ok: false, reason: "extra-question" };
  if (!SAFE_PATH_ONLY.test(pathOnly)) return { ok: false, reason: "bad-path" };
  if (!SAFE_QUERY.test(queryOnly)) return { ok: false, reason: "bad-query" };
  return { ok: true };
}

/**
 * Backward-compatible signature: callers may pass a token string as the
 * third arg (legacy path), or omit it to pull from the Zustand store.
 * The legacy positional value is interpreted as a JWT.
 *
 * RH-11: when no token is available, the error code distinguishes two
 * causes:
 *   - `session_loading` — LoginGate hasn't completed its first
 *     getSession() round-trip. Retry once hydration finishes.
 *   - `no_session`     — Hydration finished and there is no session.
 *     Caller should redirect to login (which LoginGate does anyway
 *     by gating its children).
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  tokenOverride?: string | null,
): Promise<Response> {
  const state = useUiStore.getState();
  const token =
    tokenOverride !== undefined
      ? tokenOverride
      : (state.session?.access_token ?? null);
  if (!token) {
    // Caller explicitly passed null OR store has no session.
    // If the override is explicit, trust the caller's intent (terminal).
    const hydrating = tokenOverride === undefined && !state.hydrated;
    if (hydrating) {
      throw new ApiError(
        "Session hydration in progress",
        401,
        "session_loading",
      );
    }
    throw new ApiError("No active session", 401, "no_session");
  }
  const v = validateApiPath(path);
  if (!v.ok) {
    throw new ApiError(`Invalid path: ${path} (${v.reason})`, 400, "bad_path");
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
