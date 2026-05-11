import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "./lib/supabase";

export type Mode = "map" | "locust";

export interface UiState {
  /**
   * Supabase auth session (access_token + refresh_token + user). When
   * non-null, the app is signed in. supabase-js owns the source of
   * truth in localStorage; LoginGate mirrors it into this store so
   * components can read synchronously without awaiting getSession().
   */
  session: Session | null;
  setSession: (s: Session | null) => void;
  /**
   * Hydration latch. `false` from app boot until LoginGate finishes its
   * first `supabase.auth.getSession()` await. apiFetch reads this to
   * distinguish "session_loading" (retryable — caller raced the hydrate
   * step) from "no_session" (terminal — user is signed out).
   * RH-11.
   */
  hydrated: boolean;
  setHydrated: (b: boolean) => void;
  /**
   * QueryClient handle, set once at App mount so signOut can call
   * cancelQueries + clear before the new sign-in lands. Without this
   * the previous user's cached data would survive the gate and a
   * different account would briefly see their predecessor's results.
   * Audit C C3.
   */
  queryClient: QueryClient | null;
  setQueryClient: (qc: QueryClient) => void;
  /**
   * Sign-out abort surface. Long-lived consumers (Sage SSE stream,
   * in-flight fetches) register their AbortController; signOut() walks
   * the set and aborts each. Without this, an in-flight Sage stream
   * keeps consuming bytes using the previous JWT after the user clicks
   * Sign out. Audit C C2.
   */
  abortRegistry: Set<AbortController>;
  registerAbort: (ctrl: AbortController) => () => void;

  /**
   * Local cleanup: cancel TanStack queries, abort registered streams,
   * drop session. Idempotent. Does NOT call `supabase.auth.signOut()`.
   * Used by `signOut()` (which adds the supabase RPC) AND by LoginGate's
   * cross-tab handler (which must NOT call signOut again — it already
   * ran in the other tab). RH-12.
   */
  cleanupLocal: () => Promise<void>;

  /** Sign out: local cleanup + supabase.auth.signOut() RPC. */
  signOut: () => Promise<void>;

  entidad: string | null;
  setEntidad: (clave: string | null) => void;

  sector: string | null;
  setSector: (scian: string | null) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  session: null,
  setSession: (s) => set({ session: s }),

  hydrated: false,
  setHydrated: (b) => set({ hydrated: b }),

  queryClient: null,
  setQueryClient: (qc) => set({ queryClient: qc }),

  abortRegistry: new Set<AbortController>(),
  registerAbort: (ctrl) => {
    const reg = get().abortRegistry;
    reg.add(ctrl);
    return () => reg.delete(ctrl);
  },

  cleanupLocal: async () => {
    // 1. Cancel in-flight TanStack queries so they don't write stale
    //    results into the new user's cache.
    const qc = get().queryClient;
    if (qc) {
      await qc.cancelQueries();
      qc.clear();
    }
    // 2. Abort long-lived consumers (Sage SSE, etc.).
    for (const ctrl of get().abortRegistry) {
      try {
        ctrl.abort();
      } catch {
        // already aborted
      }
    }
    get().abortRegistry.clear();
    // 3. Drop the session in the store so LoginGate re-shows.
    set({ session: null });
  },

  signOut: async () => {
    await get().cleanupLocal();
    // Tell Supabase to invalidate the refresh token + clear local storage.
    // RH-12: this call also fires a SIGNED_OUT auth event, which our
    // own onAuthStateChange listener observes and calls cleanupLocal()
    // a second time. That's safe — cleanupLocal is idempotent (the
    // abort registry is already empty, the cache is already cleared,
    // session is already null). Cheaper than gating the listener.
    await supabase.auth.signOut();
  },

  entidad: null,
  // Normalize empty strings to null so downstream queries gated on
  // `entidad !== null` don't fire with `?entidad=` and 400 the backend.
  // Audit Locust-W2 (2026-05-04) — defense for future call sites that
  // might forward a select's empty value verbatim.
  setEntidad: (clave) => set({ entidad: clave === "" ? null : clave }),

  sector: null,
  setSector: (scian) => set({ sector: scian === "" ? null : scian }),
}));
