import { useEntidades, useSectors } from "../api/queries";
import { useUiStore } from "../store";

interface Props {
  /** Render the SCIAN sector picker too (Map mode wants both). */
  showSector?: boolean;
  /**
   * Override the "limpiar" button behavior. Default sets entidad+sector
   * to null. Map mode supplies a custom callback that re-seeds defaults
   * instead so the canvas can't land in an unfiltered state.
   */
  onClear?: () => void;
}

/**
 * Compact entidad picker (and optionally a SCIAN sector picker).
 *
 * Two consumers:
 *   - LocustMode embeds <FilterControls> directly inside its sticky top
 *     toolbar (no bar wrapper).
 *   - MapMode renders <FilterPanel> as a full-width bar above the canvas.
 *
 * Selecting cascades through Zustand into every per-entidad chart and
 * the Map mode tile-source URL.
 */
export function FilterPanel({ showSector = false, onClear }: Props = {}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
      <FilterControls showSector={showSector} onClear={onClear} />
    </div>
  );
}

/**
 * Bare picker controls. Renders the entidad dropdown (and optionally the
 * SCIAN sector picker) plus a "limpiar" button when any filter is set.
 * No outer chrome — caller supplies the surrounding toolbar.
 */
export function FilterControls({ showSector = false, onClear }: Props = {}) {
  const entidad = useUiStore((s) => s.entidad);
  const setEntidad = useUiStore((s) => s.setEntidad);
  const sector = useUiStore((s) => s.sector);
  const setSector = useUiStore((s) => s.setSector);
  const { data: ents, isLoading, isError } = useEntidades();
  const { data: secs } = useSectors();

  return (
    <>
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
            if (onClear) {
              onClear();
              return;
            }
            setEntidad(null);
            if (showSector) setSector(null);
          }}
          className="rounded border border-slate-700 px-2 py-1 font-mono text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          limpiar
        </button>
      )}
    </>
  );
}
