import { NavLink, Outlet } from "react-router-dom";
import { useUiStore } from "../store";
import { useUrlSync } from "../useUrlSync";

export function Layout() {
  const session = useUiStore((s) => s.session);
  const signOut = useUiStore((s) => s.signOut);
  // Single URL ⇄ Zustand binding for the whole app so deep-link
  // hydration works on every route (R2 audit W1).
  useUrlSync();
  const userLabel = session?.user.email ?? session?.user.id?.slice(0, 8) ?? "";

  // RH-9: confirm before signing out. The flow tears down in-flight
  // queries + Sage streams + supabase session; an accidental click in
  // the middle of a Sage turn would lose the user's work and they'd
  // have to start over.
  //
  // Test note: jsdom's default window.confirm returns false. Future
  // tests that exercise this path must
  //   vi.spyOn(window, "confirm").mockReturnValue(true)
  // or the test will silently green without ever calling signOut().
  const onSignOutClick = () => {
    const ok = window.confirm(
      "¿Cerrar sesión? Se cancelarán las consultas en curso.",
    );
    if (ok) void signOut();
  };
  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-2">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm font-semibold text-cyan-400">
            DENUE Analyzer
          </h1>
          <nav className="flex items-center gap-1 text-xs">
            <ModeLink to="/locust" label="Locust" />
            <ModeLink to="/map" label="Map" />
            <ModeLink to="/sage" label="Sage" />
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {userLabel && (
            <span className="font-mono text-[10px] text-slate-500">
              {userLabel}
            </span>
          )}
          <button
            type="button"
            onClick={onSignOutClick}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

function ModeLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded px-3 py-1 font-mono ${
          isActive
            ? "bg-cyan-600 text-slate-50"
            : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        }`
      }
    >
      {label}
    </NavLink>
  );
}
