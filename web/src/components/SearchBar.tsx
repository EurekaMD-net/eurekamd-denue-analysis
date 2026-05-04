import { useEffect, useState } from "react";
import { useSearch } from "../api/queries";

/**
 * Debounced text search across DENUE establishments. Hits /search?q=
 * after 300ms of typing rest, only when q has ≥3 chars (matches the
 * useSearch hook's gate). Renders top-20 results in a dropdown panel.
 */
export function SearchBar() {
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw), 300);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isFetching, isError } = useSearch(debounced);

  return (
    <div className="relative flex-1 max-w-md">
      <input
        type="search"
        placeholder="Buscar establecimiento (≥3 chars)…"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
      />
      {open && debounced.length >= 3 && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded border border-slate-700 bg-slate-950 shadow-xl">
          {isFetching && (
            <div className="px-3 py-2 font-mono text-xs text-slate-500">
              buscando…
            </div>
          )}
          {isError && (
            <div className="px-3 py-2 font-mono text-xs text-rose-400">
              error de búsqueda
            </div>
          )}
          {data && data.rows.length === 0 && !isFetching && (
            <div className="px-3 py-2 font-mono text-xs text-slate-500">
              sin resultados
            </div>
          )}
          {data &&
            data.rows.map((r, i) => (
              <SearchRow key={`${i}-${r["clee"] as string}`} row={r} />
            ))}
        </div>
      )}
    </div>
  );
}

function SearchRow({ row }: { row: Record<string, unknown> }) {
  const nombre = (row["nombre"] as string) ?? "(sin nombre)";
  const clee = row["clee"] as string;
  const claseAct =
    (row["clase_actividad"] as string) ?? (row["clase_actividad_id"] as string);
  const entidad = row["entidad"] as string;
  return (
    <div className="border-b border-slate-800 px-3 py-2 last:border-b-0 hover:bg-slate-900">
      <div className="font-mono text-xs text-slate-200">{nombre}</div>
      <div className="font-mono text-[10px] text-slate-500">
        {clee} · ent {entidad} · {claseAct ?? "?"}
      </div>
    </div>
  );
}
