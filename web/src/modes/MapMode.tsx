import { useState } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { MapShell } from "../map/MapShell";
import { ClusterOverlay, clusterOverlayActive } from "../map/ClusterOverlay";
import { EstablishmentCard } from "../map/EstablishmentCard";
import { FilterPanel } from "../components/FilterPanel";
import { useUiStore } from "../store";
import { DEFAULT_BASEMAP, type BasemapStyle } from "../map/style";

/**
 * Map mode — geographic lens over the same DENUE dataset Locust mode
 * shows analytically. MapLibre canvas + heatmap (zoom <14) + circles
 * (zoom ≥11) + cluster centroids overlay (when both entidad + sector
 * filters set) + click-to-detail side panel.
 *
 * Data path: /tiles/:z/:x/:y.mvt (PostGIS ST_AsMVT, rate-limited 5/s/IP),
 * filters via querystring entidad/sector. X-Api-Key injected in
 * MapShell's transformRequest. /clusters and /establishment fetched via
 * the standard apiFetch wrapper through TanStack Query.
 */
export function MapMode() {
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
        {clusterOverlayActive(entidad, sector) ? (
          <span className="font-mono text-[10px] text-rose-400">
            ● clusters k=10 visibles
          </span>
        ) : (
          <span className="font-mono text-[10px] text-slate-600">
            elige entidad + sector para ver clusters
          </span>
        )}
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-slate-600">
          zoom &lt;14 = heatmap · zoom ≥11 = puntos · click → detalle
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
