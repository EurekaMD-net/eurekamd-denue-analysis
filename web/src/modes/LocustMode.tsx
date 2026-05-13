import { useEffect, useMemo, useState } from "react";
import ReactECharts from "../lib/echarts-core";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useUiStore } from "../store";
import { FieldPicker } from "../components/FieldPicker";
import { FilterControls } from "../components/FilterPanel";
import {
  deriveChartType,
  ENDPOINTS,
  fieldSharesAnyEndpoint,
  findField,
  getActiveEndpoint,
  isFieldOnEndpoint,
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
 * Invariant: X is the row source. When X is picked, its
 * `getActiveEndpoint()` selects the backend endpoint to fetch. Y and Z
 * are columns on that same payload — `field.endpoints[X.activeEndpoint]`.
 *
 * The picker enforces this:
 *   - X slot: any reachable field (operator directive 2026-05-12).
 *   - Y/Z slot: filtered to fields with a column on X's active endpoint.
 *   - Z slot is also disabled until X+Y are both set.
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
  const [perCapita, setPerCapita] = useState(false);

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

  // Setting or changing X invalidates Y/Z if they're not on X's new
  // active endpoint. Without this, switching X from one endpoint to
  // another would leave previously-valid Y/Z fields in place and produce
  // "Sin datos."
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
      // Clear Y/Z that don't span any endpoint with the new X.
      if (next.field && yAxis.field) {
        if (!fieldSharesAnyEndpoint(next.field, yAxis.field)) {
          setYAxis(INITIAL_AXIS);
          setZAxis(INITIAL_AXIS);
        } else if (
          zAxis.field &&
          getActiveEndpoint(next.field, yAxis.field, zAxis.field) === null
        ) {
          setZAxis(INITIAL_AXIS);
        }
      }
      if (!next.field) {
        setYAxis(INITIAL_AXIS);
        setZAxis(INITIAL_AXIS);
      }
      setXAxis(next);
    } else if (slot === "y") {
      setYAxis(next);
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
  // X: any reachable field.
  // Y: fields sharing ANY endpoint with X (X may be on multiple; the
  //    active endpoint resolves once Y is picked).
  // Z: fields on the resolved X+Y endpoint (concrete by then).
  const pickerPredicate = useMemo(() => {
    if (pickerOpen === "x") return (f: FieldDef) => isFieldReachable(f);
    const xField = xAxis.field;
    if (!xField) return () => false;
    if (pickerOpen === "y") {
      return (f: FieldDef) =>
        f.id !== xField.id && fieldSharesAnyEndpoint(xField, f);
    }
    if (pickerOpen === "z") {
      const xyEndpoint = getActiveEndpoint(xField, yAxis.field);
      if (!xyEndpoint) return () => false;
      return (f: FieldDef) =>
        isFieldOnEndpoint(f, xyEndpoint) &&
        f.id !== xField.id &&
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

  // Pre-fetch UX: surface a hint when X's active endpoint requires entidad
  // and none is selected. Dispatcher would otherwise return early.
  const xActiveEndpointId = xAxis.field
    ? getActiveEndpoint(xAxis.field, yAxis.field, zAxis.field)
    : null;
  const xEndpoint = xActiveEndpointId ? ENDPOINTS[xActiveEndpointId] : null;
  const needsEntidad = xEndpoint?.needsEntidad === true && entidad === null;

  // Per-capita (× 1,000 inhabitants) is offered only where it makes sense:
  //   - Active endpoint is muni-grain (all four muni endpoints carry pobtot)
  //   - At least one of Y/Z is a count-type field that isn't itself pobtot
  // The toggle stays in state regardless of eligibility, but is hidden /
  // ignored when not applicable so combos that lose eligibility (e.g.
  // changing X to estado grain) don't silently flip back on later.
  // R1 audit note: this is a *UX gate* — extractRows() re-checks
  // endpoint.grain === "muni" AND looks up censo.pobtot.endpoints[epId]
  // before doing any arithmetic, so a future muni-grain endpoint missing
  // a pobtot column would no-op safely there even if the toggle armed
  // here. Two-source-of-truth on purpose: UX hides the affordance;
  // extractRows is authoritative.
  const isPerCapitaCandidate = (f: FieldDef | null) =>
    f !== null && f.type === "numeric_count" && f.id !== "censo.pobtot";
  const perCapitaEligible =
    xEndpoint?.grain === "muni" &&
    (isPerCapitaCandidate(yAxis.field) || isPerCapitaCandidate(zAxis.field));
  const perCapitaActive = perCapita && perCapitaEligible;

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
          {perCapitaEligible && (
            <>
              <span className="h-4 w-px bg-slate-800" />
              <label
                className="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] text-slate-300 hover:text-slate-100"
                title="Normaliza Y y Z por cada 1,000 habitantes del municipio"
              >
                <input
                  type="checkbox"
                  checked={perCapita}
                  onChange={(e) => setPerCapita(e.target.checked)}
                  className="h-3 w-3 cursor-pointer accent-cyan-500"
                />
                <span>por 1,000 hab.</span>
              </label>
            </>
          )}
          {perCapitaActive && (
            <span
              className="rounded bg-cyan-900/60 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200"
              title="Y y Z elegibles se muestran por cada 1,000 habitantes"
            >
              × 1k hab
            </span>
          )}
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
              perCapita={perCapitaActive}
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
  zAxis: AxisState,
  accessToken: string | null,
  entidad: string | null,
) {
  const xField = xAxis.field;
  const yField = yAxis.field;
  const zField = zAxis.field;
  const endpointId = xField ? getActiveEndpoint(xField, yField, zField) : null;
  const endpoint = endpointId ? ENDPOINTS[endpointId] : null;
  const path = endpoint ? endpoint.path(entidad) : null;

  return useQuery({
    queryKey: ["locust", endpointId, entidad, xField?.id, yField?.id],
    queryFn: async () => {
      if (!path) throw new Error("no endpoint for X");
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
  /** When true, Y and Z numeric_count fields are projected per 1,000 hab. */
  perCapita: boolean;
  onCellPin: (label: string, value: string) => void;
}

function LocustChart({
  chartType,
  xAxis,
  yAxis,
  zAxis,
  dataset,
  filterPins,
  perCapita,
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
  const allRows = extractRows(dataset.data, xAxis, yAxis, zAxis, {
    perCapita,
  });
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

  const option = buildEChartsOption(chartType, rows, xAxis, yAxis, zAxis, {
    perCapita,
  });
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
 * Extract data points by reading column names off
 * `field.endpoints[xActiveEndpoint]`. Each ENDPOINTS entry declares its
 * own rowsKey envelope — we look it up rather than guessing.
 */
export function extractRows(
  raw: unknown,
  xAxis: AxisState,
  yAxis: AxisState,
  zAxis: AxisState,
  options: { perCapita?: boolean } = {},
): DataPoint[] {
  const xField = xAxis.field;
  const yField = yAxis.field;
  const zField = zAxis.field;
  if (!xField || !yField) return [];
  // Must resolve against X+Y+Z, not X alone: a field combo like
  // entidad_nombre × enigh.ingreso_p50 has X on national-treemap AND
  // locust-estado, but Y is only on locust-estado. Resolving with X alone
  // picks national-treemap (first key), then the Y column lookup misses
  // and every row is dropped. The upstream fetcher already uses X+Y+Z;
  // the parser must agree or the network fetches the right endpoint and
  // the parser silently throws the rows away.
  const epId = getActiveEndpoint(xField, yField, zField);
  if (!epId) return [];
  const endpoint = ENDPOINTS[epId];

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

  const xCol = xField.endpoints[epId];
  const yCol = yField.endpoints[epId];
  const zCol = zField ? zField.endpoints[epId] : undefined;
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

  // Per-capita projection: only applies on muni-grain endpoints where the
  // censo.pobtot field exposes a column. We look the column up via the
  // field catalog so the SQL alias can change without breaking this. A
  // count field that IS pobtot itself is excluded (normalizing pobtot by
  // pobtot is the constant 1000).
  const popField = findField("censo.pobtot");
  const popCol =
    options.perCapita && endpoint.grain === "muni"
      ? (popField?.endpoints[epId] ?? null)
      : null;
  const yNormalizable =
    popCol !== null &&
    yField.type === "numeric_count" &&
    yField.id !== "censo.pobtot";
  const zNormalizable =
    popCol !== null &&
    zField?.type === "numeric_count" &&
    zField.id !== "censo.pobtot";

  return rows
    .map((r) => {
      const xv = r[xCol];
      const yv = r[yCol];
      const zv = zCol ? r[zCol] : null;
      const popRaw = popCol ? r[popCol] : null;
      const pop =
        popRaw == null
          ? NaN
          : typeof popRaw === "number"
            ? popRaw
            : Number(popRaw);
      const canNormalize = popCol !== null && Number.isFinite(pop) && pop > 0;

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
      if (zNormalizable && canNormalize && z !== null) {
        z = (z * 1000) / pop;
      }

      const yNum = typeof yv === "number" ? yv : Number(yv ?? NaN);
      const yOut =
        yNormalizable && canNormalize && Number.isFinite(yNum)
          ? (yNum * 1000) / pop
          : yNum;

      return {
        x:
          typeof xv === "string" || typeof xv === "number"
            ? xv
            : String(xv ?? ""),
        y: yOut,
        z,
      };
    })
    .filter((p) => Number.isFinite(p.y));
}

export function buildEChartsOption(
  chartType: string,
  rows: DataPoint[],
  xAxis: AxisState,
  yAxis: AxisState,
  zAxis: AxisState,
  options: { perCapita?: boolean } = {},
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

  // Only Y and Z get normalized in extractRows — X is always the row
  // identifier and passes through untouched (audit C1, 3ccef39: scatter
  // X label was wrongly gaining "/ 1k hab" when a count field was put on
  // X, even though the plotted X values were raw).
  const isCountField = (f: FieldDef | null | undefined) =>
    f != null && f.type === "numeric_count" && f.id !== "censo.pobtot";
  const labelWithPerCapita = (f: FieldDef | null | undefined): string => {
    if (!f) return "";
    return options.perCapita && isCountField(f)
      ? `${f.label} / 1k hab`
      : f.label;
  };
  const yAxisName = labelWithPerCapita(yAxis.field);
  const zAxisName = labelWithPerCapita(zAxis.field);
  const xAxisName = xAxis.field?.label ?? "";

  // Tooltip formatter: shows axis name + value with the per-capita
  // suffix already baked in. Without this, hovering a bar shows a bare
  // number and the only "× 1k hab" affordance is the off-screen header
  // chip (audit W2).
  const tooltipFormatter = (
    params:
      | {
          seriesName?: string;
          name?: string;
          value?: unknown;
          data?: { value?: unknown };
        }
      | Array<{ seriesName?: string; name?: string; value?: unknown }>,
  ): string => {
    const fmt = (n: unknown): string => {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      if (Math.abs(n) >= 1000)
        return n.toLocaleString("es-MX", { maximumFractionDigits: 1 });
      return n.toLocaleString("es-MX", { maximumFractionDigits: 2 });
    };
    const single = Array.isArray(params) ? params[0] : params;
    if (!single) return "";
    const name = single.name ?? "";
    const v = Array.isArray(single.value)
      ? single.value[1]
      : (single.value ??
        (single as { data?: { value?: unknown } }).data?.value);
    const zLabel = zAxisName
      ? `<br/>${zAxisName}: ${fmt((single as { value?: unknown[] }).value?.[2])}`
      : "";
    return `<b>${name}</b><br/>${yAxisName}: ${fmt(v)}${zLabel}`;
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
      tooltip: { trigger: "axis", formatter: tooltipFormatter },
      xAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLabel: { ...baseAxisLabel, rotate: 30 },
      },
      yAxis: {
        type: "value",
        name: yAxisName,
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
      tooltip: { trigger: "item", formatter: tooltipFormatter },
      xAxis: {
        type: "value",
        name: xAxisName,
        nameTextStyle: baseAxisLabel,
        axisLabel: baseAxisLabel,
      },
      yAxis: {
        type: "value",
        name: yAxisName,
        nameTextStyle: baseAxisLabel,
        axisLabel: baseAxisLabel,
      },
      series: [
        {
          type: "scatter",
          symbolSize: zAxis.field ? 10 : 6,
          data: rows.map((p) => ({
            value: [p.x, p.y, p.z],
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
      tooltip: { trigger: "item", formatter: tooltipFormatter },
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
  // Default: line. W1 audit fix: yAxis was missing `name`, so per-capita
  // "/ 1k hab" suffix never surfaced on line charts.
  return {
    backgroundColor: "transparent",
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    tooltip: { trigger: "axis", formatter: tooltipFormatter },
    xAxis: {
      type: "category",
      data: rows.map((p) => String(p.x)),
      axisLabel: baseAxisLabel,
    },
    yAxis: {
      type: "value",
      name: yAxisName,
      nameTextStyle: baseAxisLabel,
      axisLabel: baseAxisLabel,
    },
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
