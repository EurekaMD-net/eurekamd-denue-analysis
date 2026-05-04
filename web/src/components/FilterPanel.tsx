import { useEntidades, useSectors } from "../api/queries";
import { useUiStore } from "../store";

interface Props {
  /** Render the SCIAN sector picker too (Map mode wants both). */
  showSector?: boolean;
}

/**
 * Compact entidad picker (and optionally a SCIAN sector picker).
 *
 * Reads from /entidades for the entidad dropdown source so the label
 * includes loaded count + INEGI status (green/yellow/red/unverified).
 * Reads from /sectors for the SCIAN dropdown when `showSector` is true.
 *
 * Selecting cascades through Zustand into every per-entidad chart and
 * the Map mode tile-source URL.
 */
export function FilterPanel({ showSector = false }: Props = {}) {
  const entidad = useUiStore((s) => s.entidad);
  const setEntidad = useUiStore((s) => s.setEntidad);
  const sector = useUiStore((s) => s.sector);
  const setSector = useUiStore((s) => s.setSector);
  const { data: ents, isLoading, isError } = useEntidades();
  const { data: secs } = useSectors();

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
      {ents && (
        <select
          value={entidad ?? ""}
          onChange={(e) => setEntidad(e.target.value || null)}
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
        >
          <option value="">— Nacional —</option>
          {ents.entidades.map((e) => (
            <option key={e.clave} value={e.clave}>
              {e.clave} · {e.nombre} ({e.loaded.toLocaleString("es-MX")})
            </option>
          ))}
        </select>
      )}

      {showSector && (
        <>
          <label className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
            Sector
          </label>
          <select
            value={sector ?? ""}
            onChange={(e) => setSector(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            <option value="">— Todos —</option>
            {secs?.sectors.map((s) => (
              <option key={s.scian} value={s.scian}>
                {s.scian} · {s.name}
              </option>
            ))}
          </select>
        </>
      )}

      {(entidad || (showSector && sector)) && (
        <button
          type="button"
          onClick={() => {
            setEntidad(null);
            if (showSector) setSector(null);
          }}
          className="rounded border border-slate-700 px-2 py-1 font-mono text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          limpiar
        </button>
      )}
    </div>
  );
}
