import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";

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
  /** Convenience accessor for the access_token header. */
  accessToken: () => string | null;
  /** Sign out via Supabase + clear session locally. */
  signOut: () => Promise<void>;

  entidad: string | null;
  setEntidad: (clave: string | null) => void;

  sector: string | null;
  setSector: (scian: string | null) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  session: null,
  setSession: (s) => set({ session: s }),
  accessToken: () => get().session?.access_token ?? null,
  signOut: async () => {
    // Lazy import to avoid a circular dependency: supabase client
    // depends on env, which Vite resolves before the store mounts.
    const { supabase } = await import("./lib/supabase");
    await supabase.auth.signOut();
    set({ session: null });
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
