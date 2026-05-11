import { useMemo, useState } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { MapShell } from "../map/MapShell";
import { ClusterOverlay } from "../map/ClusterOverlay";
import { EstablishmentCard } from "../map/EstablishmentCard";
import { FilterPanel } from "../components/FilterPanel";
import { BivariateLegend } from "../components/BivariateLegend";
import { useUiStore } from "../store";
import { DEFAULT_BASEMAP, type BasemapStyle } from "../map/style";
import { SCIAN_BUNDLES, type ScianBundle } from "../lib/scian-bundles";
import {
  findLayer,
  layersForGrain,
  type MapLayerGrain,
  type MapLayerSpec,
} from "../lib/map-layers";
import { useLayerValues } from "../api/layers-client";

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
 * filters via querystring entidad/sector. Authorization: Bearer <jwt>
 * injected in MapShell's transformRequest. /clusters and /establishment
 * fetched via the standard apiFetch wrapper through TanStack Query.
 */
export function MapMode() {
  // useUrlSync now lives in Layout.tsx so all routes hydrate URL state.
  const [basemap, setBasemap] = useState<BasemapStyle>(DEFAULT_BASEMAP);
  const [map, setMap] = useState<MapInstance | null>(null);
  const [selectedClee, setSelectedClee] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [grain, setGrain] = useState<MapLayerGrain>("muni");
  const [pickedLayers, setPickedLayers] = useState<string[]>([]);
  const [grainDroppedCount, setGrainDroppedCount] = useState<number>(0);
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);
  const setSector = useUiStore((s) => s.setSector);

  const selectedBundle = useMemo<ScianBundle | null>(
    () =>
      bundleId ? (SCIAN_BUNDLES.find((b) => b.id === bundleId) ?? null) : null,
    [bundleId],
  );

  // Bundle → tile filter. The current /tiles endpoint accepts a single
  // 2-digit SCIAN; map each bundle to the broadest shared prefix so the
  // canvas at least narrows to a coherent universe. Full multi-SCIAN
  // bundle filtering on tiles is a v0.3.1 backend extension (R2 audit C1).
  const handleBundlePick = (b: ScianBundle | null) => {
    if (!b) {
      setBundleId(null);
      setSector(null);
      return;
    }
    setBundleId(b.id);
    const prefixes = new Set(b.codes.map((c) => c.slice(0, 2)));
    const broadestSector =
      prefixes.size === 1 ? Array.from(prefixes)[0]! : null;
    if (broadestSector) setSector(broadestSector);
  };

  // Up to 3 layers, filtered by grain. When grain toggles, drop incompatible
  // picks (RH-8: count the dropped ones so we can surface a hint instead
  // of dropping them silently).
  const grainLayers = useMemo(() => layersForGrain(grain), [grain]);
  const activePickedLayers: MapLayerSpec[] = useMemo(
    () =>
      pickedLayers
        .map((id) => findLayer(id))
        .filter((l): l is MapLayerSpec => l !== undefined && l.grain === grain),
    [pickedLayers, grain],
  );

  const handleGrainChange = (next: MapLayerGrain) => {
    if (next === grain) return;
    const dropped = pickedLayers.filter((id) => {
      const layer = findLayer(id);
      return layer !== undefined && layer.grain !== next;
    });
    if (dropped.length > 0) {
      setPickedLayers((cur) =>
        cur.filter((id) => {
          const layer = findLayer(id);
          return layer !== undefined && layer.grain === next;
        }),
      );
      setGrainDroppedCount(dropped.length);
    } else {
      setGrainDroppedCount(0);
    }
    setGrain(next);
  };

  // Fire the layers/values request when 1–3 layers are picked. The data
  // joins client-side onto the visible polygon set in MapShell (or, in
  // the demo's current scaffold, populates the legend tally only).
  const layerValues = useLayerValues(
    grain,
    activePickedLayers.map((l) => l.id),
    entidad,
  );

  const togglePicked = (id: string) => {
    setPickedLayers((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= 3) return cur; // cap at 3
      return [...cur, id];
    });
    // Clear the grain-change hint once the user manipulates layers again.
    setGrainDroppedCount(0);
  };

  return (
    <div className="flex h-full bg-slate-950">
      {/* Left rail: bundle + grain + layers */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900 overflow-y-auto">
        <div className="border-b border-slate-800 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Bundle SCIAN
          </span>
        </div>
        <div className="flex flex-wrap gap-1 px-3 py-2">
          {SCIAN_BUNDLES.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => handleBundlePick(bundleId === b.id ? null : b)}
              title={b.description}
              className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                bundleId === b.id
                  ? "bg-cyan-700 text-cyan-50"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        {selectedBundle && (
          <div className="border-b border-slate-800 px-3 pb-2 font-mono text-[9px] text-amber-400">
            filtro vigente sector {sector ?? "—"} (v0.3.1 extenderá a SCIAN 4–6
            dígitos)
          </div>
        )}

        <div className="border-y border-slate-800 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
              Grano
            </span>
            <div className="inline-flex overflow-hidden rounded border border-slate-700 font-mono text-[10px]">
              {(["muni", "ageb"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => handleGrainChange(g)}
                  className={`px-2 py-0.5 ${
                    grain === g
                      ? "bg-cyan-600 text-slate-50"
                      : "text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          {grainDroppedCount > 0 && (
            <div
              className="mt-1 font-mono text-[9px] text-amber-400"
              role="status"
            >
              {grainDroppedCount}{" "}
              {grainDroppedCount === 1 ? "capa oculta" : "capas ocultas"} por
              cambio de grano
            </div>
          )}
        </div>

        <div className="border-b border-slate-800 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Capas ({pickedLayers.length}/3)
          </span>
        </div>
        <div className="flex flex-col gap-0.5 px-2 py-2">
          {grainLayers.map((l) => {
            const picked = pickedLayers.includes(l.id);
            const atCap = pickedLayers.length >= 3;
            // RH-7: when 3 are picked, disable the unpicked rest so the
            // 4th click doesn't silently no-op. Picked rows stay clickable
            // (toggle to deselect).
            const disabled = atCap && !picked;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => togglePicked(l.id)}
                disabled={disabled}
                title={
                  disabled
                    ? "Máximo 3 capas — deselecciona una antes de añadir otra"
                    : l.description
                }
                className={`flex items-center justify-between rounded px-2 py-1 text-left font-mono text-[10px] ${
                  picked
                    ? "bg-cyan-900 text-cyan-100"
                    : disabled
                      ? "cursor-not-allowed text-slate-600"
                      : "text-slate-400 hover:bg-slate-800"
                }`}
              >
                <span className="truncate">{l.label}</span>
                <span className="ml-2 text-[8px] text-slate-500">
                  {l.units}
                </span>
              </button>
            );
          })}
        </div>

        {activePickedLayers.length > 0 && (
          <div className="border-t border-slate-800 px-3 py-2">
            <BivariateLegend
              layers={activePickedLayers}
              values={layerValues.data?.values}
            />
          </div>
        )}

        <div className="flex-1" />
        <div className="border-t border-slate-800 px-3 py-2 font-mono text-[9px] text-slate-600">
          {selectedBundle ? (
            <>SCIAN: {selectedBundle.codes.join(", ")}</>
          ) : (
            <>sin bundle SCIAN — todas las UEs</>
          )}
          {layerValues.isLoading && (
            <div className="text-cyan-400">cargando layer-values…</div>
          )}
          {layerValues.data && (
            <div className="text-slate-500">
              {Object.keys(layerValues.data.values).length} polígonos con datos
            </div>
          )}
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
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
      </main>
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
