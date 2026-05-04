import { useState } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { MapShell } from "../map/MapShell";
import { ClusterOverlay } from "../map/ClusterOverlay";
import { EstablishmentCard } from "../map/EstablishmentCard";
import { FilterPanel } from "../components/FilterPanel";
import { useUiStore } from "../store";
import { useUrlSync } from "../useUrlSync";
import { DEFAULT_BASEMAP, type BasemapStyle } from "../map/style";

/**
 * Map mode — geographic lens over the same DENUE dataset Locust mode
 * shows analytically. MapLibre canvas + heatmap (zoom <14) + circles
 * (zoom ≥11) + cluster centroids overlay (when both entidad + sector
 * filters set) + click-to-detail side panel.
 *
 * No seeded defaults — landing on /map shows the unfiltered country-
 * wide heatmap. Canvas safety comes from the tile feature cap
 * (TILE_FEATURE_CAP=50k per tile) and the circle layer's filter-aware
 * minzoom (11 unfiltered, 5 filtered). Tiles complete in ~400ms
 * unfiltered thanks to LIMIT-without-ORDER-BY in the SQL.
 *
 * Data path: /tiles/:z/:x/:y.mvt (PostGIS ST_AsMVT, rate-limited 60/s/IP),
 * filters via querystring entidad/sector. X-Api-Key injected in
 * MapShell's transformRequest. /clusters and /establishment fetched via
 * the standard apiFetch wrapper through TanStack Query.
 */
export function MapMode() {
  useUrlSync();

  const [basemap, setBasemap] = useState<BasemapStyle>(DEFAULT_BASEMAP);
  const [map, setMap] = useState<MapInstance | null>(null);
  const [selectedClee, setSelectedClee] = useState<string | null>(null);
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <FilterPanel showSector />
      <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          Basemap
        </span>
        <BasemapToggle current={basemap} set={setBasemap} />
        <span className="h-4 w-px bg-slate-800" />
        <FilterStatus entidad={entidad} sector={sector} />
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-slate-600">
          {entidad || sector
            ? "puntos visibles desde zoom 5 · click → detalle"
            : "filtra por entidad o sector para ver puntos · click → detalle"}
        </span>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <MapShell
          basemap={basemap}
          onMapLoad={setMap}
          onPointClick={setSelectedClee}
        />
        <ClusterOverlay map={map} />
        <EstablishmentCard
          clee={selectedClee}
          onClose={() => setSelectedClee(null)}
        />
      </div>
    </div>
  );
}

/**
 * Compact pill summary of the active filter state. Replaces the old
 * "elige entidad + sector para ver clusters" hint, which only mentioned
 * the cluster overlay (and was misleading when sector-only was selected,
 * because cluster centroids require both filters but circles now work
 * with one).
 */
function FilterStatus({
  entidad,
  sector,
}: {
  entidad: string | null;
  sector: string | null;
}) {
  const both = entidad !== null && sector !== null;
  const any = entidad !== null || sector !== null;
  if (!any) {
    return (
      <span className="font-mono text-[10px] text-slate-600">
        sin filtros — vista nacional (heatmap)
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 font-mono text-[10px]">
      <span className="text-cyan-400">● filtro activo</span>
      {entidad && (
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">
          ent {entidad}
        </span>
      )}
      {sector && (
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">
          scian {sector}
        </span>
      )}
      {both && <span className="text-rose-400">+ clusters k=10</span>}
    </span>
  );
}

function BasemapToggle({
  current,
  set,
}: {
  current: BasemapStyle;
  set: (b: BasemapStyle) => void;
}) {
  const opts: Array<{ id: BasemapStyle; label: string }> = [
    { id: "dark", label: "Dark Matter" },
    { id: "positron", label: "Positron" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded border border-slate-700 font-mono text-[10px]">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => set(o.id)}
          className={`px-2 py-1 ${
            current === o.id
              ? "bg-cyan-600 text-slate-50"
              : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
