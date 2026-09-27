import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  apiFetch,
  ApiError,
  shouldRetryQuery,
  validateApiPath,
} from "./client";
import { useUiStore } from "../store";
import { fetchJson } from "./queries";
import { sageQueryStream } from "./sage-client";
import { SEARCH_RESULT } from "./types";

describe("validateApiPath (RH-10)", () => {
  it("accepts plain paths", () => {
    expect(validateApiPath("/sage/health").ok).toBe(true);
    expect(validateApiPath("/analytics/national-treemap").ok).toBe(true);
    expect(validateApiPath("/establishment/0123ESTRRA0010001").ok).toBe(true);
  });

  it("accepts paths with a single querystring", () => {
    expect(validateApiPath("/clusters?entidad=09&scian=46&k=10").ok).toBe(true);
    expect(
      validateApiPath(
        "/analytics/layers/values?layers=foo&entidad=09&grain=muni",
      ).ok,
    ).toBe(true);
  });

  it("rejects a literal comma in querystring (URLSearchParams users get %2C)", () => {
    expect(
      validateApiPath("/analytics/layers/values?layers=a,b&grain=muni").ok,
    ).toBe(false);
  });

  // Phase 2 audit C1 regression: encodeURIComponent leaves the
  // RFC 3986 unreserved set (`! ~ * ' ( )`) un-encoded. The first-pass
  // SAFE_QUERY rejected those characters and would 400 any /search?q=
  // request whose input contained an apostrophe (very common in
  // Spanish-language business names — Domino's, L'Oréal, etc.).
  it("accepts encodeURIComponent passthrough chars in querystring (audit C1)", () => {
    const samples = [
      "Domino's",
      "L'Oréal",
      "Levi's",
      "(Sucursal)",
      "tilde~thing",
      "asterisk*here",
      "bang!yes",
    ];
    for (const raw of samples) {
      const path = `/search?q=${encodeURIComponent(raw)}&limit=20`;
      const v = validateApiPath(path);
      if (!v.ok)
        throw new Error(
          `expected accept for "${raw}" → "${path}", got ${v.reason}`,
        );
      expect(v.ok).toBe(true);
    }
  });

  it("rejects protocol-relative paths", () => {
    expect(validateApiPath("//evil.example.com/api/x")).toMatchObject({
      ok: false,
      reason: "protocol-relative",
    });
  });

  it("rejects path traversal in literal and encoded forms", () => {
    expect(validateApiPath("/../etc/passwd")).toMatchObject({
      ok: false,
      reason: "traversal",
    });
    expect(validateApiPath("/foo/%2e%2e/bar")).toMatchObject({
      ok: false,
      reason: "traversal",
    });
    expect(validateApiPath("/foo/%2E%2E/bar")).toMatchObject({
      ok: false,
      reason: "traversal",
    });
  });

  it("rejects multiple `?` separators", () => {
    expect(validateApiPath("/foo?bar?baz")).toMatchObject({
      ok: false,
      reason: "extra-question",
    });
  });

  it("rejects querystring metachars in path-only portion", () => {
    // No `?` in path-only allowed; if the regex below ever sees an `&`
    // before the `?` it should fail.
    expect(validateApiPath("/foo&bar")).toMatchObject({
      ok: false,
      reason: "bad-path",
    });
    expect(validateApiPath("/foo=baz/path")).toMatchObject({
      ok: false,
      reason: "bad-path",
    });
  });

  it("rejects slashes inside the querystring", () => {
    expect(validateApiPath("/foo?bar=baz/qux")).toMatchObject({
      ok: false,
      reason: "bad-query",
    });
  });

  it("rejects empty and non-leading-slash paths", () => {
    expect(validateApiPath("").ok).toBe(false);
    expect(validateApiPath("relative/path").ok).toBe(false);
    expect(validateApiPath("/").ok).toBe(false); // no path char after leading slash
  });

  // Audit #199: `..` in the querystring cannot traverse (SAFE_QUERY
  // forbids `/`), so a search for "S.A.." or "Abarrotes..." must pass.
  it("accepts `..` inside the querystring (audit #199)", () => {
    for (const raw of ["S.A..", "Abarrotes...", "..%2e%2e"]) {
      const path = `/search?q=${encodeURIComponent(raw)}&limit=20`;
      expect(validateApiPath(path)).toEqual({ ok: true });
    }
    // The path portion is still checked.
    expect(validateApiPath("/foo/..?q=S.A.")).toMatchObject({
      ok: false,
      reason: "traversal",
    });
  });

  it("accepts URL-encoded segments", () => {
    expect(validateApiPath("/establishment/foo%20bar").ok).toBe(true);
    expect(validateApiPath("/items?name=hello%20world").ok).toBe(true);
  });
});

describe("apiFetch token-state error codes (RH-11)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    // Reset store to a clean slate per test.
    useUiStore.setState({ session: null, hydrated: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
    useUiStore.setState({ session: null, hydrated: false });
  });

  it("throws session_loading when store is not yet hydrated", async () => {
    useUiStore.setState({ session: null, hydrated: false });
    const err = await apiFetch("/sage/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("session_loading");
    expect((err as ApiError).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws no_session when store is hydrated but session is null", async () => {
    useUiStore.setState({ session: null, hydrated: true });
    const err = await apiFetch("/sage/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("no_session");
  });

  it("throws no_session when caller explicitly passes null (intent is terminal)", async () => {
    useUiStore.setState({ session: null, hydrated: false });
    const err = await apiFetch("/sage/health", {}, null).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe("no_session");
  });

  it("uses tokenOverride when provided as a non-null string", async () => {
    useUiStore.setState({ session: null, hydrated: true });
    await apiFetch("/sage/health", {}, "explicit-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(callInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer explicit-token-123");
  });

  it("uses store session.access_token when override is omitted", async () => {
    useUiStore.setState({
      session: {
        access_token: "store-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Date.now() / 1000 + 3600,
        refresh_token: "refresh",
        // @ts-expect-error - partial Session shape for test only
        user: { id: "u1", email: "x@y.z" },
      },
      hydrated: true,
    });
    await apiFetch("/sage/health");
    const callInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(callInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer store-token");
  });

  it("throws bad_path for traversal attempts even with valid token", async () => {
    useUiStore.setState({ session: null, hydrated: true });
    const err = await apiFetch("/../etc/passwd", {}, "tok").catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe("bad_path");
    expect((err as ApiError).status).toBe(400);
  });
});

describe("shouldRetryQuery (audit #188)", () => {
  it("does not retry deterministic 4xx failures", () => {
    expect(shouldRetryQuery(0, new ApiError("bad", 400, "bad_path"))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("forbidden", 403))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("not found", 404))).toBe(false);
  });

  it("retries session_loading once (it clears after hydration)", () => {
    const err = new ApiError("hydrating", 401, "session_loading");
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(false);
  });

  it("retries 5xx and non-API errors once, like retry: 1", () => {
    expect(shouldRetryQuery(0, new ApiError("boom", 502))).toBe(true);
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError("boom", 502))).toBe(false);
  });
});

describe("abort signal forwarding (audit #176)", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Resolves only when the request signal aborts, like a slow backend.
    fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    useUiStore.setState({ session: null, hydrated: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    useUiStore.setState({ session: null, hydrated: false });
  });

  it("apiFetch combines a caller signal with the 30 s timeout by default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const ctrl = new AbortController();
    const p = apiFetch("/sage/health", { signal: ctrl.signal }, "tok");
    // The timeout still applies when the caller supplies a signal.
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    expect(sent).not.toBe(ctrl.signal);
    expect(sent?.aborted).toBe(false);
    ctrl.abort();
    expect(sent?.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sageQueryStream gets no client timeout, only its own signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const ctrl = new AbortController();
    const p = sageQueryStream("hola", null, "tok", ctrl.signal).next();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A Sage turn can run ~83 s server-side; a 30 s cap would cut it off.
    expect(timeoutSpy).not.toHaveBeenCalled();
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    expect(sent).toBe(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fetchJson forwards the signal; a search with `..` reaches fetch", async () => {
    const ctrl = new AbortController();
    const p = fetchJson(
      `/search?q=${encodeURIComponent("S.A..")}&limit=20`,
      SEARCH_RESULT,
      "tok",
      ctrl.signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancelQueries aborts the in-flight request and does not retry", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } },
    });
    const p = qc.fetchQuery({
      queryKey: ["search", "S.A.."],
      queryFn: ({ signal }) =>
        fetchJson("/search?q=S.A..&limit=20", SEARCH_RESULT, "tok", signal),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    await qc.cancelQueries();
    await expect(p).rejects.toBeDefined();
    expect(sent?.aborted).toBe(true);
    // Give a would-be retry a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    qc.clear();
  });
});
