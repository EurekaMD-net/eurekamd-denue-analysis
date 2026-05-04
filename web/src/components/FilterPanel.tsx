import { useEntidades } from "../api/queries";
import { useUiStore } from "../store";

/**
 * Compact entidad picker. Reads from /entidades dropdown source so the
 * label includes loaded count + INEGI status (green/yellow/red/unverified).
 * Selecting cascades through Zustand into every per-entidad chart.
 */
export function FilterPanel() {
  const entidad = useUiStore((s) => s.entidad);
  const setEntidad = useUiStore((s) => s.setEntidad);
  const { data, isLoading, isError } = useEntidades();

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
      <label className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
        Entidad
      </label>
      {isLoading && (
        <span className="font-mono text-xs text-slate-500">cargando…</span>
      )}
      {isError && (
        <span className="font-mono text-xs text-rose-400">
          error cargando entidades
        </span>
      )}
      {data && (
        <select
          value={entidad ?? ""}
          onChange={(e) => setEntidad(e.target.value || null)}
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
        >
          <option value="">— Nacional —</option>
          {data.entidades.map((e) => (
            <option key={e.clave} value={e.clave}>
              {e.clave} · {e.nombre} ({e.loaded.toLocaleString("es-MX")})
            </option>
          ))}
        </select>
      )}
      {entidad && (
        <button
          type="button"
          onClick={() => setEntidad(null)}
          className="rounded border border-slate-700 px-2 py-1 font-mono text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          limpiar
        </button>
      )}
    </div>
  );
}
