import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useUiStore } from "../store";
import { supabase } from "../lib/supabase";
import type { Session } from "@supabase/supabase-js";

interface Props {
  children: ReactNode;
}

/**
 * Email + password sign-in gate backed by Supabase Auth (self-hosted
 * GoTrue at db.mycommit.net). Replaces the legacy single-shared-key
 * gate. Sessions persist via supabase-js localStorage with auto-refresh
 * so a tab survives the JWT exp boundary (~1 hour).
 *
 * Sign-up is invite-only: this UI offers no register form. Operator
 * pre-creates accounts via Supabase Studio or
 * `POST /auth/v1/admin/users` with the service-role key.
 */
// supabase-js v2 stores its session under a key matching `sb-<ref>-auth-token`.
// We match the family so we don't have to hardcode the project ref (it
// changes per Supabase instance for sell-time deployments). Exported so
// tests can pin the exact pattern (Phase 2 audit R5).
export const SUPABASE_TOKEN_KEY_RE = /^sb-.+-auth-token$/;

export function LoginGate({ children }: Props) {
  const session = useUiStore((s) => s.session);
  const setSession = useUiStore((s) => s.setSession);
  const hydrated = useUiStore((s) => s.hydrated);
  const setHydrated = useUiStore((s) => s.setHydrated);
  const cleanupLocal = useUiStore((s) => s.cleanupLocal);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  // RH-16: focus the email field exactly once, after hydration and only
  // when there's no error to read. The prior `autoFocus` prop was
  // mount-only; useEffect + ref lets us actually wait for the hydration
  // signal (the form swap-in is what mounts the input).
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (focusedOnceRef.current) return;
    if (!hydrated || session || error) return;
    emailInputRef.current?.focus();
    focusedOnceRef.current = true;
  }, [hydrated, session, error]);

  // Hydrate from supabase-js on mount, then subscribe so token refresh
  // pushes the new access_token into the Zustand store automatically.
  // RH-12: SIGNED_OUT events may originate in another tab via supabase-js's
  // built-in cross-tab broadcast (it listens on storage events itself).
  // When that happens we must run the SAME teardown locally — cancel
  // TanStack queries + abort Sage SSE streams — not just clear the
  // session. cleanupLocal does that without re-calling
  // supabase.auth.signOut (which already ran in the originating tab).
  // RH-13: As belt-and-suspenders, we also listen for raw storage events
  // and run cleanupLocal if the supabase-token key disappeared but our
  // store still thinks we have a session.
  useEffect(() => {
    let canceled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (canceled) return;
      setSession(data.session as Session | null);
      setHydrated(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_OUT") {
        // Could be from another tab. Run full teardown idempotently —
        // cleanupLocal early-returns if there's nothing to clean.
        void cleanupLocal();
        return;
      }
      setSession(s as Session | null);
    });
    const onStorage = (e: StorageEvent) => {
      // Only react to changes touching the supabase auth-token family.
      if (!e.key || !SUPABASE_TOKEN_KEY_RE.test(e.key)) return;
      // Note: storage events fire on this listener every time ANOTHER
      // tab writes the token key — that includes the hourly token
      // refresh (autoRefreshToken: true). The getSession() round-trip
      // below is the cost. It's a localStorage read + a Promise tick,
      // negligible at N-tab scale. We don't dedupe; double cleanupLocal
      // calls are idempotent. (Phase 2 audit W4.)
      void supabase.auth.getSession().then(({ data }) => {
        if (canceled) return;
        if (!data.session && useUiStore.getState().session) {
          void cleanupLocal();
        }
      });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      canceled = true;
      sub.subscription.unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, [setSession, setHydrated, cleanupLocal]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950">
        <span className="font-mono text-xs text-slate-500">
          cargando sesión…
        </span>
      </div>
    );
  }

  if (session) return <>{children}</>;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { data, error: signInError } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
      if (signInError) {
        setError(translateAuthError(signInError.message));
        return;
      }
      if (data.session) {
        setSession(data.session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-4 rounded-lg border border-slate-700 bg-slate-800 p-6 shadow-xl"
      >
        <header>
          <h1 className="text-xl font-semibold text-slate-100">
            DENUE Analyzer
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Inicia sesión con tu correo y contraseña.
          </p>
        </header>
        <input
          ref={emailInputRef}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="correo@dominio.com"
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="contraseña"
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
        />
        {error && (
          <div className="rounded border border-red-700 bg-red-950 px-3 py-2 font-mono text-xs text-red-300">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          className="w-full rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-slate-50 hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          {busy ? "..." : "Entrar"}
        </button>
        <p className="text-center font-mono text-[10px] text-slate-500">
          Cuentas creadas por invitación. Solicita acceso al operador.
        </p>
      </form>
    </div>
  );
}

function translateAuthError(raw: string): string {
  if (/invalid login credentials/i.test(raw)) {
    return "Correo o contraseña incorrectos.";
  }
  if (/email not confirmed/i.test(raw)) {
    return "El correo aún no está confirmado.";
  }
  // Supabase rate-limit shapes vary across versions (audit C R4).
  if (
    /rate limit|too many requests|security purposes|too many login/i.test(raw)
  ) {
    return "Demasiados intentos. Espera unos segundos.";
  }
  // Network failures (Supabase down, CORS misconfig, offline). Audit C W4.
  if (/failed to fetch|network|networkerror/i.test(raw)) {
    return "No se pudo contactar al servidor. Revisa tu conexión.";
  }
  return raw;
}
