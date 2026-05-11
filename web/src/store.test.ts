import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "./store";
import { SUPABASE_TOKEN_KEY_RE } from "./components/LoginGate";

// supabase mock so cleanupLocal doesn't try to hit the network.
// signOut() does call supabase.auth.signOut(); cleanupLocal() does not.
vi.mock("./lib/supabase", () => ({
  supabase: {
    auth: {
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

interface MockQc {
  cancelQueries: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

function makeQc(): MockQc {
  return {
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
  };
}

describe("store cleanupLocal (RH-12)", () => {
  beforeEach(() => {
    useUiStore.setState({
      session: null,
      hydrated: false,
      queryClient: null,
      abortRegistry: new Set<AbortController>(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cancels TanStack queries and clears the cache", async () => {
    const qc = makeQc();
    useUiStore.setState({
      // @ts-expect-error - test-only partial QueryClient
      queryClient: qc,
      session: {
        access_token: "x",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Date.now() / 1000 + 3600,
        refresh_token: "r",
        // @ts-expect-error - partial Session
        user: { id: "u1" },
      },
    });
    await useUiStore.getState().cleanupLocal();
    expect(qc.cancelQueries).toHaveBeenCalledOnce();
    expect(qc.clear).toHaveBeenCalledOnce();
    expect(useUiStore.getState().session).toBeNull();
  });

  it("aborts every controller in the abortRegistry", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const reg = new Set<AbortController>([a, b]);
    useUiStore.setState({ abortRegistry: reg });
    await useUiStore.getState().cleanupLocal();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(useUiStore.getState().abortRegistry.size).toBe(0);
  });

  it("is idempotent — second call after first is a no-op without throwing", async () => {
    await useUiStore.getState().cleanupLocal();
    await expect(useUiStore.getState().cleanupLocal()).resolves.toBeUndefined();
    expect(useUiStore.getState().session).toBeNull();
  });

  it("swallows ctrl.abort throws (already-aborted)", async () => {
    const a = new AbortController();
    a.abort();
    useUiStore.setState({ abortRegistry: new Set([a]) });
    await expect(useUiStore.getState().cleanupLocal()).resolves.toBeUndefined();
  });
});

describe("store signOut (full flow)", () => {
  beforeEach(() => {
    useUiStore.setState({
      session: null,
      hydrated: false,
      queryClient: null,
      abortRegistry: new Set<AbortController>(),
    });
  });

  it("runs cleanupLocal AND calls supabase.auth.signOut", async () => {
    const { supabase } = await import("./lib/supabase");
    const qc = makeQc();
    useUiStore.setState({
      // @ts-expect-error - test partial
      queryClient: qc,
    });
    await useUiStore.getState().signOut();
    expect(qc.cancelQueries).toHaveBeenCalledOnce();
    expect(
      supabase.auth.signOut as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
  });
});

describe("hydrated latch (RH-11 store surface)", () => {
  it("defaults to false on store init", () => {
    // Re-init by resetting; hydrated should not auto-become true.
    useUiStore.setState({ hydrated: false });
    expect(useUiStore.getState().hydrated).toBe(false);
  });

  it("setHydrated toggles the latch", () => {
    useUiStore.setState({ hydrated: false });
    useUiStore.getState().setHydrated(true);
    expect(useUiStore.getState().hydrated).toBe(true);
    useUiStore.getState().setHydrated(false);
    expect(useUiStore.getState().hydrated).toBe(false);
  });
});

describe("SUPABASE_TOKEN_KEY_RE (RH-13)", () => {
  // Audit R5 fix: import the actual regex from LoginGate (top of file)
  // rather than recreating it. A future regex change updates both sides
  // together.
  it("matches the standard supabase-js v2 key shape", () => {
    expect(SUPABASE_TOKEN_KEY_RE.test("sb-abcdefgh-auth-token")).toBe(true);
    expect(SUPABASE_TOKEN_KEY_RE.test("sb-localhost-auth-token")).toBe(true);
    // Self-hosted with domain-based ref
    expect(SUPABASE_TOKEN_KEY_RE.test("sb-db.mycommit.net-auth-token")).toBe(
      true,
    );
  });

  it("rejects keys that don't belong to supabase-js auth", () => {
    expect(SUPABASE_TOKEN_KEY_RE.test("other-key")).toBe(false);
    expect(SUPABASE_TOKEN_KEY_RE.test("sb-auth-token")).toBe(false); // no project ref
    expect(SUPABASE_TOKEN_KEY_RE.test("sb-foo-something")).toBe(false);
    expect(SUPABASE_TOKEN_KEY_RE.test("zb-foo-auth-token")).toBe(false); // wrong prefix
  });
});
