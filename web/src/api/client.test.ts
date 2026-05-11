import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, validateApiPath } from "./client";
import { useUiStore } from "../store";

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
