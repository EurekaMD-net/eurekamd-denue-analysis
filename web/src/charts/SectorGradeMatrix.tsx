import { useMemo } from "react";
import ReactECharts from "../lib/echarts-core";
import { useSectorGradeMatrix, useSectors } from "../api/queries";
import type { IrsGrado } from "../api/types";
import { ChartCard } from "./ChartCard";
import {
  COLOR,
  ECHARTS_BASE,
  ECHARTS_AXIS_DARK,
  IRS_GRADO_ORDER,
} from "./theme";

/**
 * SCIAN sector × IRS grade heatmap. Rows are SCIAN 2-digit sectors
 * (sorted by national_count DESC). Columns are IRS grades in canonical
 * order. Cell color = log-scaled count. Reads at a glance which sectors
 * structurally live in higher-rezago municipios.
 */
export function SectorGradeMatrix() {
  const { data, isLoading, isError, error } = useSectorGradeMatrix();
  const { data: sectors } = useSectors();

  const { grid, sectorList, max } = useMemo(() => {
    if (!data) return { grid: [] as number[][], sectorList: [], max: 1 };
    // Index by sector + grade
    const counts = new Map<string, number>();
    for (const c of data.cells)
      counts.set(`${c.scian}|${c.irs_grado}`, c.count);

    // SCIAN ordering: by national_count DESC (from /sectors response if present),
    // else by appearance order in matrix data. Audit W1: union both so a
    // SCIAN present in the matrix but missing from /sectors is still rendered
    // (drift defense — /sectors caches catalog labels, matrix is fresh data).
    const inMatrix = new Set(data.cells.map((c) => c.scian));
    const orderedFromCatalog = sectors
      ? sectors.sectors.map((s) => s.scian).filter((s) => inMatrix.has(s))
      : [];
    const orphans = Array.from(inMatrix)
      .filter((s) => !orderedFromCatalog.includes(s))
      .sort();
    const knownScians = [...orderedFromCatalog, ...orphans];

    let mx = 1;
    const matrix = knownScians.map((scian) =>
      IRS_GRADO_ORDER.map((g) => {
        const v = counts.get(`${scian}|${g}`) ?? 0;
        if (v > mx) mx = v;
        return v;
      }),
    );
    return { grid: matrix, sectorList: knownScians, max: mx };
  }, [data, sectors]);

  // ECharts heatmap data: [xIdx, yIdx, value]
  const heatData: Array<[number, number, number]> = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) {
      heatData.push([x, y, row[x]!]);
    }
  }

  const option = {
    ...ECHARTS_BASE,
    grid: { left: 36, right: 8, top: 24, bottom: 60 },
    tooltip: {
      ...ECHARTS_BASE.tooltip,
      formatter: (p: { data: [number, number, number] }) => {
        const [x, y, v] = p.data;
        const grado = IRS_GRADO_ORDER[x] as IrsGrado;
        const scian = sectorList[y];
        return (
          `<b>SCIAN ${scian}</b> · <b>${grado}</b><br/>` +
          `${v.toLocaleString("es-MX")} establecimientos`
        );
      },
    },
    xAxis: {
      type: "category",
      data: IRS_GRADO_ORDER,
      ...ECHARTS_AXIS_DARK,
      axisLabel: {
        ...ECHARTS_AXIS_DARK.axisLabel,
        rotate: 30,
        formatter: (v: string) => (v === "sin_dato" ? "s/d" : v),
      },
      splitArea: { show: false },
    },
    yAxis: {
      type: "category",
      data: sectorList,
      ...ECHARTS_AXIS_DARK,
      axisLabel: {
        ...ECHARTS_AXIS_DARK.axisLabel,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      },
    },
    visualMap: {
      type: "continuous",
      min: 0,
      max,
      // Log-ish scaling so 1.5M doesn't drown 5k cells
      inRange: {
        color: [
          COLOR.panelMuted,
          "#0e7490", // cyan-700
          "#22d3ee", // cyan-400
          "#facc15", // yellow-400
          "#fb7185", // rose-400
        ],
      },
      text: ["alta", "baja"],
      textStyle: { color: COLOR.textMuted, fontSize: 10 },
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 100,
    },
    series: [
      {
        type: "heatmap",
        data: heatData,
        progressive: 200,
        progressiveThreshold: 200,
        emphasis: { itemStyle: { borderColor: COLOR.accent, borderWidth: 1 } },
      },
    ],
  };

  return (
    <ChartCard
      title="Sector SCIAN × IRS grado"
      subtitle="cuántos establecimientos por sector caen en cada grado de rezago"
      isLoading={isLoading}
      isError={isError}
      errorMessage={error instanceof Error ? error.message : undefined}
      isEmpty={!data || data.cells.length === 0}
      height="h-96"
    >
      <ReactECharts
        option={option}
        notMerge
        style={{ height: "100%", width: "100%" }}
      />
    </ChartCard>
  );
}
