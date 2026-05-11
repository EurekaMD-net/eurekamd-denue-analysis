import ReactECharts from "../lib/echarts-core";
import { useTopSectorsByEntidad } from "../api/queries";
import { ChartCard } from "./ChartCard";
import { COLOR, ECHARTS_BASE, ECHARTS_AXIS_DARK } from "./theme";

interface Props {
  entidad: string | null;
  entidadNombre?: string;
}

/**
 * Top 10 SCIAN sectors in the selected entidad. Horizontal bars, sorted
 * by count DESC, with sector NAME on the y-axis (truncated). Bypasses the
 * never-applied mv_sector_summary mat-view by hitting /analytics/top-sectors
 * which aggregates directly via the indexed sector_actividad_id column.
 */
export function TopSectoresBar({ entidad, entidadNombre }: Props) {
  const { data, isLoading, isError, error } = useTopSectorsByEntidad(
    entidad,
    10,
  );

  const sectors = data?.sectors ?? [];
  // ECharts bars render bottom-to-top; reverse so #1 is at top
  const labels = sectors.map((s) => `${s.scian} · ${s.name}`).reverse();
  const values = sectors.map((s) => s.count).reverse();

  const option = {
    ...ECHARTS_BASE,
    grid: { left: 220, right: 32, top: 8, bottom: 24 },
    tooltip: {
      ...ECHARTS_BASE.tooltip,
      formatter: (p: { name: string; value: number }) =>
        `<b>${p.name}</b><br/>${p.value.toLocaleString("es-MX")} establecimientos`,
    },
    xAxis: {
      type: "value",
      ...ECHARTS_AXIS_DARK,
      axisLabel: {
        ...ECHARTS_AXIS_DARK.axisLabel,
        formatter: (v: number) =>
          v >= 1_000_000
            ? `${(v / 1_000_000).toFixed(1)}M`
            : v >= 1_000
              ? `${(v / 1_000).toFixed(0)}k`
              : String(v),
      },
    },
    yAxis: {
      type: "category",
      data: labels,
      ...ECHARTS_AXIS_DARK,
      axisLabel: {
        ...ECHARTS_AXIS_DARK.axisLabel,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 10,
        width: 200,
        overflow: "truncate",
      },
    },
    series: [
      {
        type: "bar",
        data: values,
        itemStyle: { color: COLOR.accent, borderRadius: [0, 2, 2, 0] },
        emphasis: { itemStyle: { color: "#67e8f9" } }, // cyan-300
        barMaxWidth: 18,
      },
    ],
  };

  const subtitle = entidadNombre
    ? `entidad: ${entidadNombre}`
    : "selecciona una entidad arriba";

  return (
    <ChartCard
      title="Top 10 sectores SCIAN"
      subtitle={subtitle}
      isLoading={isLoading}
      isError={isError}
      errorMessage={error instanceof Error ? error.message : undefined}
      isEmpty={entidad === null || !data || data.sectors.length === 0}
      emptyMessage={
        entidad === null
          ? "Click en una entidad del mosaico para ver sectores"
          : "Sin sectores"
      }
    >
      <ReactECharts
        option={option}
        notMerge
        style={{ height: "100%", width: "100%" }}
      />
    </ChartCard>
  );
}
