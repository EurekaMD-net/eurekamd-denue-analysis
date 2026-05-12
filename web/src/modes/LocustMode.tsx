import { useEffect, useMemo, useState } from "react";
import ReactECharts from "../lib/echarts-core";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useUiStore } from "../store";
import { FieldPicker } from "../components/FieldPicker";
import { FilterControls } from "../components/FilterPanel";
import {
  deriveChartType,
  findField,
  GRAIN_ENDPOINTS,
  isFieldGraphableAt,
  isFieldReachable,
  type FieldDef,
} from "../lib/fields";
import { LOCUST_PRESETS, type LocustPreset } from "../lib/presets";

type AxisSlot = "x" | "y" | "z";

interface AxisState {
  field: FieldDef | null;
  /** Drill breadcrumb (geo or SCIAN). Each click descends one level. */
  geoLevel: 0 | 1 | 2; // 0 = nacional, 1 = estado, 2 = muni
  scianLevel: 2 | 3 | 4 | 5 | 6;
}

const INITIAL_AXIS: AxisState = {
  field: null,
  geoLevel: 1,
  scianLevel: 2,
};

/**
 * Locust mode — single configurable chart.
 *
 * Invariant: X is the join key. The X field's `grain` selects which
 * backend endpoint is fetched (via GRAIN_ENDPOINTS). Y and Z are values
 * read off the same row by name — `field.columns[xField.grain]`.
 *
 * The picker enforces this invariant pre-pick:
 *   - X slot accepts only fields with xEligible=true.
 *   - Y slot (after X set) accepts only fields whose columns map has X.grain.
 *   - Z slot is gated until X+Y both set; then constrained to Y's rule.
 */
export function LocustMode() {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const entidad = useUiStore((s) => s.entidad);
  const [xAxis, setXAxis] = useState<AxisState>(INITIAL_AXIS);
  const [yAxis, setYAxis] = useState<AxisState>(INITIAL_AXIS);
  const [zAxis, setZAxis] = useState<AxisState>(INITIAL_AXIS);
  const [pickerOpen, setPickerOpen] = useState<AxisSlot | null>(null);
  const [chartOverride, setChartOverride] = useState<string | null>(null);
  const [filterPins, setFilterPins] = useState<
    Array<{ axis: AxisSlot; label: string; value: string }>
  >([]);

  const applyPreset = (preset: LocustPreset) => {
    setXAxis({ ...INITIAL_AXIS, field: findField(preset.x) ?? null });
    setYAxis({ ...INITIAL_AXIS, field: findField(preset.y) ?? null });
    setZAxis({
      ...INITIAL_AXIS,
      field: preset.z ? (findField(preset.z) ?? null) : null,
    });
    setChartOverride(null);
    setFilterPins([]);
  };

  // Setting or changing X invalidates Y/Z if they're not graphable at the
  // new X.grain. Without this, switching X from estado to muni would leave
  // estado-only Y/Z fields in place and produce the same "Sin datos" we're
  // trying to eliminate.
  const setAxis = (slot: AxisSlot, next: AxisState) => {
    if (slot === "x") {
      const prevId = xAxis.field?.id;
      const fieldChanged = next.field?.id !== prevId;
      const drillChanged =
        next.geoLevel !== xAxis.geoLevel ||
        next.scianLevel !== xAxis.scianLevel;
      if (fieldChanged || drillChanged) {
        setFilterPins([]);
      }
      // If X grain changed, clear Y/Z that are not graphable at new grain.
      const newGrain = next.field?.grain ?? null;
      if (
        newGrain &&
        yAxis.field &&
        !isFieldGraphableAt(yAxis.field, newGrain)
      ) {
        setYAxis(INITIAL_AXIS);
      }
      if (
        newGrain &&
        zAxis.field &&
        !isFieldGraphableAt(zAxis.field, newGrain)
      ) {
        setZAxis(INITIAL_AXIS);
      }
      // Removing X entirely → clear Y/Z too (Z is meaningless without X).
      if (!next.field) {
        setYAxis(INITIAL_AXIS);
        setZAxis(INITIAL_AXIS);
      }
      setXAxis(next);
    } else if (slot === "y") {
      setYAxis(next);
      // Removing Y clears Z (Z is a colorant of Y).
      if (!next.field) setZAxis(INITIAL_AXIS);
    } else {
      setZAxis(next);
    }
  };
  const getAxis = (slot: AxisSlot): AxisState =>
    slot === "x" ? xAxis : slot === "y" ? yAxis : zAxis;

  // Z slot is meaningless without X+Y both set.
  const zSlotEnabled = xAxis.field !== null && yAxis.field !== null;

  // W1 audit fix: if X is cleared while Y/Z picker is open, the picker
  // is stale (all rows disabled, context hint references a null field).
  // Auto-close to keep state coherent.
  useEffect(() => {
    if ((pickerOpen === "y" || pickerOpen === "z") && !xAxis.field) {
      setPickerOpen(null);
    }
    if (pickerOpen === "z" && !yAxis.field) {
      setPickerOpen(null);
    }
  }, [pickerOpen, xAxis.field, yAxis.field]);

  // Picker predicate per slot.
  // X: any reachable field (operator directive 2026-05-12 — X drives the
  //    UX, not a restricted anchor set).
  // Y/Z: filtered to fields graphable at X.grain, deduped against
  //    already-picked slots.
  const pickerPredicate = useMemo(() => {
    if (pickerOpen === "x") return (f: FieldDef) => isFieldReachable(f);
    if (pickerOpen === "y") {
      const xg = xAxis.field?.grain;
      if (!xg) return () => false; // shouldn't open Y picker w/o X
      return (f: FieldDef) =>
        isFieldGraphableAt(f, xg) && f.id !== xAxis.field?.id;
    }
    if (pickerOpen === "z") {
      const xg = xAxis.field?.grain;
      if (!xg) return () => false;
      return (f: FieldDef) =>
        isFieldGraphableAt(f, xg) &&
        f.id !== xAxis.field?.id &&
        f.id !== yAxis.field?.id;
    }
    return () => true;
  }, [pickerOpen, xAxis.field, yAxis.field]);

  // Default-derived chart type from axis field types, with manual override.
  const derivedChartType = useMemo(
    () => deriveChartType(xAxis.field?.type ?? null, yAxis.field?.type ?? null),
    [xAxis.field?.type, yAxis.field?.type],
  );
  const chartType = chartOverride ?? derivedChartType;

  const dataset = useLocustDataset(xAxis, yAxis, zAxis, accessToken, entidad);

  const onFieldPicked = (field: FieldDef) => {
    if (!pickerOpen) return;
    const slot = pickerOpen;
    setAxis(slot, { ...getAxis(slot), field });
  };

  // Pre-fetch UX: surface a hint when X's grain requires entidad and none
  // is selected. Endpoint dispatcher would otherwise return early with a
  // generic empty state — this is more actionable.
  const grainEndpoint = xAxis.field
    ? GRAIN_ENDPOINTS[xAxis.field.grain]
    : undefined;
  const needsEntidad = grainEndpoint?.needsEntidad === true && entidad === null;

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      {/* Left rail: axis panel + filter pins */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Ejes
          </span>
        </div>
        <AxisRow
          slot="x"
          axis={xAxis}
          onOpen={() => setPickerOpen("x")}
          onDrill={(dir) => setAxis("x", drill(xAxis, dir))}
          onClear={() => setAxis("x", INITIAL_AXIS)}
        />
        <AxisRow
          slot="y"
          axis={yAxis}
          disabled={!xAxis.field}
          disabledHint="Elige X primero"
          onOpen={() => setPickerOpen("y")}
          onDrill={(dir) => setAxis("y", drill(yAxis, dir))}
          onClear={() => setAxis("y", INITIAL_AXIS)}
        />
        <AxisRow
          slot="z"
          axis={zAxis}
          disabled={!zSlotEnabled}
          disabledHint="Elige X e Y primero"
          onOpen={() => setPickerOpen("z")}
          onDrill={(dir) => setAxis("z", drill(zAxis, dir))}
          onClear={() => setAxis("z", INITIAL_AXIS)}
        />

        <div className="mt-2 border-t border-slate-800 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Filtros
          </span>
        </div>
        <div className="flex flex-wrap gap-1 px-3 py-2">
          {filterPins.length === 0 ? (
            <span className="font-mono text-[10px] text-slate-600">
              clic en una celda para fijar un filtro
            </span>
          ) : (
            <>
              {filterPins.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    setFilterPins(filterPins.filter((_, j) => j !== i))
                  }
                  className="rounded bg-cyan-900 px-2 py-0.5 font-mono text-[10px] text-cyan-100 hover:bg-cyan-800"
                  title="clic para quitar"
                >
                  {p.label}: {p.value} ×
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFilterPins([])}
                className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
                title="quitar todos los filtros"
              >
                limpiar
              </button>
            </>
          )}
        </div>
        <div className="flex-1" />
        <div className="border-t border-slate-800 px-3 py-2 font-mono text-[9px] text-slate-600">
          14 fuentes joineables · grano: {xAxis.field?.grain ?? "—"}
        </div>
      </aside>

      {/* Main: chart */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Locust
          </span>
          <span className="font-mono text-xs text-slate-400">
            {xAxis.field && yAxis.field
              ? `${yAxis.field.label} por ${xAxis.field.label}`
              : "Configura X y Y para empezar"}
          </span>
          {filterPins.length > 0 && (
            <span
              className="rounded bg-cyan-900/60 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200"
              title="Filtros activos sobre el eje X — clic en chips para quitar"
            >
              {filterPins.length}{" "}
              {filterPins.length === 1 ? "filtro" : "filtros"} activo
              {filterPins.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="h-4 w-px bg-slate-800" />
          <FilterControls />
          <div className="flex-1" />
          <ChartTypeToggle
            current={chartType}
            derived={derivedChartType}
            onSet={setChartOverride}
          />
        </div>

        {!xAxis.field || !yAxis.field ? (
          <EmptyState onPreset={applyPreset} entidad={entidad} />
        ) : needsEntidad ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 font-mono text-xs text-slate-400">
            <span>
              Selecciona una entidad arriba para ver datos a grano{" "}
              <span className="text-cyan-400">{xAxis.field.grain}</span>.
            </span>
            <span className="text-[10px] text-slate-600">
              El X-anchor "{xAxis.field.label}" requiere entidad.
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <LocustChart
              chartType={chartType}
              xAxis={xAxis}
              yAxis={yAxis}
              zAxis={zAxis}
              dataset={dataset}
              filterPins={filterPins}
              onCellPin={(label, value) => {
                if (filterPins.some((p) => p.value === value)) return;
                setFilterPins([...filterPins, { axis: "x", label, value }]);
              }}
            />
          </div>
        )}
      </main>

      <FieldPicker
        open={pickerOpen !== null}
        onClose={() => setPickerOpen(null)}
        onPick={onFieldPicked}
        axisLabel={pickerOpen ? `Eje ${pickerOpen.toUpperCase()}` : ""}
        predicate={pickerPredicate}
        contextHint={pickerContextHint(pickerOpen, xAxis.field)}
      />
    </div>
  );
}

function pickerContextHint(
  slot: AxisSlot | null,
  xField: FieldDef | null,
): string | null {
  if (slot === "x")
    return "Elige cualquier campo. Y y Z se filtrarán automáticamente.";
  if (slot === "y" || slot === "z") {
    if (!xField) return null;
    return `Filtrado a campos comparables con "${xField.label}" (grano ${xField.grain}).`;
  }
  return null;
}

function drill(axis: AxisState, dir: "down" | "up"): AxisState {
  const field = axis.field;
  if (!field) return axis;
  const isGeo =
    field.grain === "estado" ||
    field.grain === "muni" ||
    field.grain === "ageb";
  if (isGeo) {
    const cur = axis.geoLevel;
    const next = dir === "down" ? Math.min(2, cur + 1) : Math.max(0, cur - 1);
    return { ...axis, geoLevel: next as 0 | 1 | 2 };
  }
  const cur = axis.scianLevel;
  const next = dir === "down" ? Math.min(6, cur + 1) : Math.max(2, cur - 1);
  return { ...axis, scianLevel: next as 2 | 3 | 4 | 5 | 6 };
}

interface AxisRowProps {
  slot: AxisSlot;
  axis: AxisState;
  disabled?: boolean;
  disabledHint?: string;
  onOpen: () => void;
  onDrill: (dir: "down" | "up") => void;
  onClear: () => void;
}

function AxisRow({
  slot,
  axis,
  disabled = false,
  disabledHint,
  onOpen,
  onDrill,
  onClear,
}: AxisRowProps) {
  return (
    <div
      className={`border-b border-slate-800 px-3 py-2 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-500">
          {slot.toUpperCase()}
        </span>
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          title={disabled ? disabledHint : undefined}
          className={`flex-1 truncate rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left font-mono text-xs text-slate-200 ${
            disabled ? "cursor-not-allowed" : "hover:border-cyan-700"
          }`}
        >
          {axis.field
            ? axis.field.label
            : disabled
              ? (disabledHint ?? "—")
              : "+ elegir campo"}
        </button>
        {axis.field && !disabled && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] text-slate-500 hover:text-red-400"
          >
            ×
          </button>
        )}
      </div>
      {axis.field && !disabled && (
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[9px] text-slate-500">
            {axis.field.source} · {axis.field.grain}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => onDrill("up")}
            className="rounded border border-slate-800 px-1 font-mono text-[10px] text-slate-400 hover:border-slate-600 hover:text-slate-200"
            title="drill up"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onDrill("down")}
            className="rounded border border-slate-800 px-1 font-mono text-[10px] text-slate-400 hover:border-slate-600 hover:text-slate-200"
            title="drill down"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

function ChartTypeToggle({
  current,
  derived,
  onSet,
}: {
  current: string;
  derived: string;
  onSet: (v: string | null) => void;
}) {
  const opts = ["bar", "scatter", "line", "heatmap", "treemap"];
  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[9px] text-slate-500">Chart:</span>
      <select
        value={current}
        onChange={(e) =>
          onSet(e.target.value === derived ? null : e.target.value)
        }
        className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-[10px] text-slate-200"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
            {o === derived ? " ← auto" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function EmptyState({
  onPreset,
  entidad,
}: {
  onPreset: (p: LocustPreset) => void;
  entidad: string | null;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <p className="mb-4 font-mono text-sm text-slate-400">
          Elige una preset o configura los ejes X y Y desde el panel.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LOCUST_PRESETS.map((p) => {
            const blocked = p.needsEntidad && entidad === null;
            return (
              <button
                key={p.id}
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (blocked) return;
                  onPreset(p);
                }}
                className={`rounded border border-slate-800 bg-slate-900 px-3 py-2 text-left ${
                  blocked
                    ? "cursor-not-allowed opacity-60"
                    : "hover:border-cyan-700 hover:bg-slate-800"
                }`}
                title={
                  blocked
                    ? `Selecciona una entidad primero (ej. ${p.exampleEntidad})`
                    : undefined
                }
              >
                <div className="font-mono text-xs text-cyan-300">{p.title}</div>
                <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                  {p.description}
                </div>
                {blocked && (
                  <div className="mt-1 font-mono text-[9px] text-amber-400">
                    requiere entidad
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Dispatch to whichever endpoint serves X.grain. Y/Z column names come
 * off `field.columns[xField.grain]` — we never fall through to a fragile
 * legacy id→column map. If X has no endpoint for its grain (e.g. ageb),
 * the query is disabled and the chart shows "Sin datos".
 */
function useLocustDataset(
  xAxis: AxisState,
  yAxis: AxisState,
  _zAxis: AxisState,
  accessToken: string | null,
  entidad: string | null,
) {
  const xField = xAxis.field;
  const yField = yAxis.field;
  const grain = xField?.grain ?? null;
  const endpoint = grain ? GRAIN_ENDPOINTS[grain] : undefined;
  const path = endpoint ? endpoint.path(entidad) : null;

  return useQuery({
    queryKey: ["locust", grain, entidad, xField?.id, yField?.id],
    queryFn: async () => {
      if (!path) throw new Error("no endpoint for grain");
      const res = await apiFetch(path, {}, accessToken);
      return res.json() as Promise<unknown>;
    },
    enabled:
      accessToken !== null &&
      xField !== null &&
      yField !== null &&
      path !== null,
    staleTime: 5 * 60 * 1000,
  });
}

interface FilterPin {
  axis: AxisSlot;
  label: string;
  value: string;
}

interface ChartProps {
  chartType: string;
  xAxis: AxisState;
  yAxis: AxisState;
  zAxis: AxisState;
  dataset: ReturnType<typeof useLocustDataset>;
  filterPins: FilterPin[];
  onCellPin: (label: string, value: string) => void;
}

function LocustChart({
  chartType,
  xAxis,
  yAxis,
  zAxis,
  dataset,
  filterPins,
  onCellPin,
}: ChartProps) {
  if (dataset.isLoading) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-slate-500">
        cargando…
      </div>
    );
  }
  if (dataset.isError) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-red-400">
        error de carga
      </div>
    );
  }
  const allRows = extractRows(dataset.data, xAxis, yAxis, zAxis);
  if (allRows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-slate-500">
        Sin datos para esta combinación. Prueba otra fuente o cambia el grano.
      </div>
    );
  }
  const rows = applyFilterPins(allRows, filterPins);
  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 font-mono text-xs text-slate-500">
        <span>
          {filterPins.length} {filterPins.length === 1 ? "filtro" : "filtros"}{" "}
          activo{filterPins.length === 1 ? "" : "s"} — ninguna fila coincide.
        </span>
        <span className="text-[10px] text-slate-600">
          Quita un chip arriba o haz clic en otra celda.
        </span>
      </div>
    );
  }

  const option = buildEChartsOption(chartType, rows, xAxis, yAxis, zAxis);
  return (
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={option}
      onEvents={{
        click: (e: { name?: string }) => {
          if (xAxis.field && e?.name) {
            onCellPin(xAxis.field.label, e.name);
          }
        },
      }}
    />
  );
}

/**
 * Apply x-axis filter pins as an inclusion set. With no pins, returns
 * the input unchanged. Exported for unit tests.
 */
export function applyFilterPins(
  rows: DataPoint[],
  pins: ReadonlyArray<FilterPin>,
): DataPoint[] {
  if (pins.length === 0) return rows;
  const include = new Set(pins.map((p) => String(p.value)));
  return rows.filter((r) => include.has(String(r.x)));
}

interface DataPoint {
  x: string | number;
  y: number | null;
  z: number | null;
}

/**
 * Extract data points by reading column names off `field.columns[xGrain]`.
 * Endpoint payloads are either { rows: [...] } / { entidades: [...] } /
 * { municipios: [...] } / { sectors: [...] }; we look up the right key
 * via GRAIN_ENDPOINTS.
 */
export function extractRows(
  raw: unknown,
  xAxis: AxisState,
  yAxis: AxisState,
  zAxis: AxisState,
): DataPoint[] {
  const xField = xAxis.field;
  const yField = yAxis.field;
  if (!xField || !yField) return [];
  const xGrain = xField.grain;
  const endpoint = GRAIN_ENDPOINTS[xGrain];
  if (!endpoint) return [];

  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    rows = raw as Record<string, unknown>[];
  } else if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r[endpoint.rowsKey])) {
      rows = r[endpoint.rowsKey] as Record<string, unknown>[];
    } else if (Array.isArray(r["rows"])) {
      rows = r["rows"] as Record<string, unknown>[];
    }
  }
  if (rows.length === 0) return [];

  const xCol = xField.columns[xGrain];
  const yCol = yField.columns[xGrain];
  const zField = zAxis.field;
  const zCol = zField ? zField.columns[xGrain] : undefined;
  if (!xCol || !yCol) return [];

  // C1 audit fix: categorical_ordinal Z fields (e.g. "Muy bajo" … "Muy alto")
  // need to be projected to a numeric rank via the field's canonical order,
  // not coerced with Number() which yields NaN and collapses all bars to
  // slate. Unknown values (e.g. "sin_dato") fall through to null.
  const zIsOrdinal =
    zField?.type === "categorical_ordinal" && zField.ordinalOrder !== undefined;
  const zOrderIndex: Map<string, number> | null = zIsOrdinal
    ? new Map(zField!.ordinalOrder!.map((v, i) => [v, i]))
    : null;

  return rows
    .map((r) => {
      const xv = r[xCol];
      const yv = r[yCol];
      const zv = zCol ? r[zCol] : null;
      let z: number | null;
      if (zOrderIndex !== null) {
        z =
          typeof zv === "string" && zOrderIndex.has(zv)
            ? zOrderIndex.get(zv)!
            : null;
      } else if (typeof zv === "number") {
        z = zv;
      } else if (zv == null) {
        z = null;
      } else {
        const n = Number(zv);
        z = Number.isFinite(n) ? n : null;
      }
      return {
        x:
          typeof xv === "string" || typeof xv === "number"
            ? xv
            : String(xv ?? ""),
        y: typeof yv === "number" ? yv : Number(yv ?? NaN),
        z,
      };
    })
    .filter((p) => Number.isFinite(p.y));
}

function buildEChartsOption(
  chartType: string,
  rows: DataPoint[],
  xAxis: AxisState,
  yAxis: AxisState,
  zAxis: AxisState,
): Record<string, unknown> {
  const palette = zAxis.field
    ? ["#16a34a", "#65a30d", "#ca8a04", "#dc2626"] // green→red
    : ["#06b6d4"];

  // W3 audit fix: precompute z range once. Previously `colorForZ(p.z, rows)`
  // recomputed `rows.map().filter().Math.min/max` per row → O(n²) on muni
  // charts (~2.5k rows). Now O(n).
  const zRange = zAxis.field ? computeZRange(rows) : null;

  const baseAxisLabel = {
    color: "#94a3b8",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
  };

  if (chartType === "bar") {
    const data = rows.map((p) => ({
      name: String(p.x),
      value: p.y,
      itemStyle: zRange ? { color: colorForZ(p.z, zRange) } : undefined,
    }));
    return {
      backgroundColor: "transparent",
      grid: { left: 60, right: 20, top: 20, bottom: 60 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLabel: { ...baseAxisLabel, rotate: 30 },
      },
      yAxis: {
        type: "value",
        name: yAxis.field?.label ?? "",
        nameTextStyle: baseAxisLabel,
        axisLabel: baseAxisLabel,
      },
      series: [
        {
          type: "bar",
          data,
          itemStyle: { color: palette[0] },
        },
      ],
    };
  }
  if (chartType === "scatter") {
    return {
      backgroundColor: "transparent",
      grid: { left: 60, right: 20, top: 20, bottom: 50 },
      tooltip: { trigger: "item" },
      xAxis: {
        type: "value",
        name: xAxis.field?.label ?? "",
        nameTextStyle: baseAxisLabel,
        axisLabel: baseAxisLabel,
      },
      yAxis: {
        type: "value",
        name: yAxis.field?.label ?? "",
        nameTextStyle: baseAxisLabel,
        axisLabel: baseAxisLabel,
      },
      series: [
        {
          type: "scatter",
          symbolSize: zAxis.field ? 10 : 6,
          data: rows.map((p) => ({
            value: [p.x, p.y],
            itemStyle: zRange ? { color: colorForZ(p.z, zRange) } : undefined,
          })),
          itemStyle: { color: palette[0] },
        },
      ],
    };
  }
  if (chartType === "treemap") {
    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item" },
      series: [
        {
          type: "treemap",
          data: rows.map((p) => ({
            name: String(p.x),
            value: p.y,
            itemStyle: zRange ? { color: colorForZ(p.z, zRange) } : undefined,
          })),
        },
      ],
    };
  }
  // Default: line
  return {
    backgroundColor: "transparent",
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: "category",
      data: rows.map((p) => String(p.x)),
      axisLabel: baseAxisLabel,
    },
    yAxis: { type: "value", axisLabel: baseAxisLabel },
    series: [{ type: "line", data: rows.map((p) => p.y), smooth: true }],
  };
}

interface ZRange {
  min: number;
  max: number;
}

/**
 * One linear pass over the rows to derive {min, max} from finite Z. Returns
 * null when no row has a usable Z (every bar then renders slate). Exported
 * for unit tests.
 */
export function computeZRange(rows: DataPoint[]): ZRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    if (r.z !== null && Number.isFinite(r.z)) {
      if (r.z < min) min = r.z;
      if (r.z > max) max = r.z;
    }
  }
  if (min === Number.POSITIVE_INFINITY) return null;
  return { min, max };
}

function colorForZ(z: number | null, range: ZRange): string {
  if (z === null || !Number.isFinite(z)) return "#475569";
  const { min, max } = range;
  const t = max === min ? 0.5 : (z - min) / (max - min);
  if (t < 0.5) {
    return lerp("#16a34a", "#ca8a04", t * 2);
  }
  return lerp("#ca8a04", "#dc2626", (t - 0.5) * 2);
}

function lerp(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
