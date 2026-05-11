import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useUiStore } from "../store";
import { FieldPicker } from "../components/FieldPicker";
import { FilterControls } from "../components/FilterPanel";
import { deriveChartType, findField, type FieldDef } from "../lib/fields";
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
 * Locust mode — single configurable chart with X/Y/Z axes, auto-derived
 * chart type, drill on whichever axis is categorical, and 6 preset
 * starter configurations.
 */
export function LocustMode() {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
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

  const setAxis = (slot: AxisSlot, next: AxisState) => {
    if (slot === "x") {
      // RH-1 audit W2: clearing or changing the X-axis field invalidates
      // all pinned values (the chips reference x-category labels). Same
      // for drilling X (the category set changes). Auto-clear so the
      // user doesn't end up with stale chips that match nothing.
      const fieldChanged = next.field?.id !== xAxis.field?.id;
      const drillChanged =
        next.geoLevel !== xAxis.geoLevel ||
        next.scianLevel !== xAxis.scianLevel;
      if (fieldChanged || drillChanged) {
        setFilterPins([]);
      }
      setXAxis(next);
    } else if (slot === "y") setYAxis(next);
    else setZAxis(next);
  };
  const getAxis = (slot: AxisSlot): AxisState =>
    slot === "x" ? xAxis : slot === "y" ? yAxis : zAxis;

  // Default-derived chart type from axis field types, with manual override.
  const derivedChartType = useMemo(
    () => deriveChartType(xAxis.field?.type ?? null, yAxis.field?.type ?? null),
    [xAxis.field?.type, yAxis.field?.type],
  );
  const chartType = chartOverride ?? derivedChartType;

  const dataset = useLocustDataset(xAxis, yAxis, zAxis, accessToken);

  const onFieldPicked = (field: FieldDef) => {
    if (!pickerOpen) return;
    const slot = pickerOpen;
    setAxis(slot, { ...getAxis(slot), field });
  };

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
          onOpen={() => setPickerOpen("y")}
          onDrill={(dir) => setAxis("y", drill(yAxis, dir))}
          onClear={() => setAxis("y", INITIAL_AXIS)}
        />
        <AxisRow
          slot="z"
          axis={zAxis}
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
          14 fuentes joineables · grano:{" "}
          {xAxis.field?.grain ?? yAxis.field?.grain ?? "—"}
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
          <EmptyState onPreset={applyPreset} />
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
                // Dedupe by value: clicking the same cell twice should
                // not stack duplicate chips.
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
      />
    </div>
  );
}

function drill(axis: AxisState, dir: "down" | "up"): AxisState {
  const field = axis.field;
  if (!field) return axis;
  // Drill axis depends on field grain — geographic grains use geoLevel,
  // SCIAN-family fields use scianLevel.
  const isGeo =
    field.grain === "estado" ||
    field.grain === "muni" ||
    field.grain === "ageb";
  if (isGeo) {
    const cur = axis.geoLevel;
    const next = dir === "down" ? Math.min(2, cur + 1) : Math.max(0, cur - 1);
    return { ...axis, geoLevel: next as 0 | 1 | 2 };
  }
  // For SCIAN sectors (categorical_nominal under DENUE)
  const cur = axis.scianLevel;
  const next = dir === "down" ? Math.min(6, cur + 1) : Math.max(2, cur - 1);
  return { ...axis, scianLevel: next as 2 | 3 | 4 | 5 | 6 };
}

interface AxisRowProps {
  slot: AxisSlot;
  axis: AxisState;
  onOpen: () => void;
  onDrill: (dir: "down" | "up") => void;
  onClear: () => void;
}

function AxisRow({ slot, axis, onOpen, onDrill, onClear }: AxisRowProps) {
  return (
    <div className="border-b border-slate-800 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-500">
          {slot.toUpperCase()}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 truncate rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left font-mono text-xs text-slate-200 hover:border-cyan-700"
        >
          {axis.field ? axis.field.label : "+ elegir campo"}
        </button>
        {axis.field && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] text-slate-500 hover:text-red-400"
          >
            ×
          </button>
        )}
      </div>
      {axis.field && (
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

function EmptyState({ onPreset }: { onPreset: (p: LocustPreset) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <p className="mb-4 font-mono text-sm text-slate-400">
          Elige una preset o configura los ejes X y Y desde el panel.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LOCUST_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p)}
              className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-left hover:border-cyan-700 hover:bg-slate-800"
            >
              <div className="font-mono text-xs text-cyan-300">{p.title}</div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                {p.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Fetches whichever joined dataset can satisfy the current X×Y×Z axis
 * selection. Today the implementation falls back to two endpoints:
 *   - /analytics/national-treemap (entidad-grain rows)
 *   - /analytics/municipios?entidad=XX (muni-grain rows)
 * The field id is mapped to the column name returned by the endpoint;
 * if no mapping exists, the chart shows "Sin datos para esta combinación."
 */
function useLocustDataset(
  xAxis: AxisState,
  yAxis: AxisState,
  _zAxis: AxisState,
  accessToken: string | null,
) {
  const grain = xAxis.field?.grain ?? yAxis.field?.grain ?? "estado";
  const entidad = useUiStore((s) => s.entidad);
  const needsEntidad = grain === "muni";
  return useQuery({
    queryKey: ["locust", grain, entidad, xAxis.field?.id, yAxis.field?.id],
    queryFn: async () => {
      const path =
        grain === "muni" && entidad
          ? `/analytics/municipios?entidad=${entidad}`
          : "/analytics/national-treemap";
      const res = await apiFetch(path, {}, accessToken);
      return res.json() as Promise<unknown>;
    },
    enabled:
      accessToken !== null &&
      xAxis.field !== null &&
      yAxis.field !== null &&
      (!needsEntidad || entidad !== null),
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
  // RH-1: filter pins on the x-axis act as an inclusion set — show only
  // the rows whose x value matches one of the pinned values. With no
  // pins, all rows pass through unchanged.
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
 * the input unchanged. With pins, returns only rows whose `x` value
 * matches one of the pinned values (compared as strings to bridge the
 * numeric/categorical mismatch from echarts click events).
 * Exported for unit tests.
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

function extractRows(
  raw: unknown,
  xAxis: AxisState,
  yAxis: AxisState,
  zAxis: AxisState,
): DataPoint[] {
  // Endpoint payloads are either { rows: [...] } or a top-level array.
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    rows = raw as Record<string, unknown>[];
  } else if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r["rows"])) rows = r["rows"] as Record<string, unknown>[];
    else if (Array.isArray(r["entidades"]))
      rows = r["entidades"] as Record<string, unknown>[];
    else if (Array.isArray(r["municipios"]))
      rows = r["municipios"] as Record<string, unknown>[];
  }
  if (rows.length === 0 || !xAxis.field || !yAxis.field) return [];

  // Map field id to row column. Lossy for the demo — only a handful of
  // ids are wired to /national-treemap and /municipios shapes.
  const xCol = mapFieldToColumn(xAxis.field.id);
  const yCol = mapFieldToColumn(yAxis.field.id);
  const zCol = zAxis.field ? mapFieldToColumn(zAxis.field.id) : null;
  if (!xCol || !yCol) return [];
  return rows
    .map((r) => {
      const xv = r[xCol];
      const yv = r[yCol];
      const zv = zCol ? r[zCol] : null;
      return {
        x:
          typeof xv === "string" || typeof xv === "number"
            ? xv
            : String(xv ?? ""),
        y: typeof yv === "number" ? yv : Number(yv ?? NaN),
        z: typeof zv === "number" ? zv : zv != null ? Number(zv) : null,
      };
    })
    .filter((p) => Number.isFinite(p.y));
}

function mapFieldToColumn(id: string): string | null {
  // Subset wiring for the demo. /national-treemap rows have
  // { entidad, establecimientos, modal_irs_grado, pobreza_pct_promedio }.
  // /municipios rows have { cve_mun, municipio, poblacion, pobreza_pct,
  // grado_rezago_social, establecimientos, farmacias, clues }.
  const m: Record<string, string> = {
    "denue.entidad_nombre": "entidad",
    "denue.total_establecimientos": "establecimientos",
    "coneval.pobreza_pct": "pobreza_pct_promedio", // estado fallback; muni column also "pobreza_pct"
    "coneval.irs_grado": "modal_irs_grado",
    "censo.pobtot": "poblacion",
  };
  return m[id] ?? null;
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

  const baseAxisLabel = {
    color: "#94a3b8",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 10,
  };

  if (chartType === "bar") {
    const data = rows.map((p) => ({
      name: String(p.x),
      value: p.y,
      itemStyle: zAxis.field ? { color: colorForZ(p.z, rows) } : undefined,
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
            itemStyle: zAxis.field
              ? { color: colorForZ(p.z, rows) }
              : undefined,
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
            itemStyle: zAxis.field
              ? { color: colorForZ(p.z, rows) }
              : undefined,
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

function colorForZ(z: number | null, rows: DataPoint[]): string {
  if (z === null || !Number.isFinite(z)) return "#475569";
  const zs = rows.map((r) => r.z).filter((v): v is number => v !== null);
  if (zs.length === 0) return "#475569";
  const min = Math.min(...zs);
  const max = Math.max(...zs);
  const t = max === min ? 0.5 : (z - min) / (max - min);
  // Linear interpolation green (low) → amber → red (high).
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
