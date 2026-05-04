import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { useMunicipiosAnalytics } from "../api/queries";
import { ChartCard } from "./ChartCard";
import { COLOR, ECHARTS_AXIS_DARK, ECHARTS_BASE } from "./theme";

interface Props {
  entidad: string | null;
  entidadNombre?: string;
}

/**
 * Cobertura de salud per 100k habitantes — top 10 municipios in entidad
 * by population. Dual horizontal bar: CLUES (public health units, DGIS)
 * vs Farmacias (DENUE SCIAN 4659*). Reads at a glance:
 *
 *   - Long both bars   → mature health corridor
 *   - Long farma, short CLUES → privatized, public-coverage gap
 *   - Long CLUES, short farma → public-only zone, low private demand
 *   - Both short        → desierto de salud
 */
export function SaludCobertura({ entidad, entidadNombre }: Props) {
  const { data, isLoading, isError, error } = useMunicipiosAnalytics(entidad);

  const { labels, clues_per_100k, farmacias_per_100k } = useMemo(() => {
    const muns = (data?.municipios ?? [])
      .filter((m) => m.poblacion !== null && m.poblacion > 10_000)
      .sort((a, b) => (b.poblacion ?? 0) - (a.poblacion ?? 0))
      .slice(0, 10)
      .reverse(); // ECharts paints bottom→top
    // Filter above gates `poblacion > 10_000` so non-null assertions
    // below are sound. Audit Locust-W3 (2026-05-04): dropped `?? 1`
    // fallbacks to prevent silent rate inflation if the filter ever
    // loosens.
    return {
      labels: muns.map((m) => m.municipio ?? m.cve_mun),
      clues_per_100k: muns.map((m) =>
        Number(((m.unidades_clues / m.poblacion!) * 100_000).toFixed(2)),
      ),
      farmacias_per_100k: muns.map((m) =>
        Number(((m.farmacias / m.poblacion!) * 100_000).toFixed(2)),
      ),
    };
  }, [data]);

  const option = {
    ...ECHARTS_BASE,
    legend: {
      data: ["Unidades CLUES", "Farmacias DENUE"],
      textStyle: { color: COLOR.textMuted, fontSize: 11 },
      top: 0,
      itemWidth: 12,
      itemHeight: 10,
    },
    tooltip: {
      ...ECHARTS_BASE.tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (v: number) => `${v.toFixed(1)} / 100k hab`,
    },
    grid: { left: 140, right: 16, top: 28, bottom: 24 },
    xAxis: {
      type: "value",
      ...ECHARTS_AXIS_DARK,
      axisLabel: { ...ECHARTS_AXIS_DARK.axisLabel },
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
        width: 130,
        overflow: "truncate",
      },
    },
    series: [
      {
        name: "Unidades CLUES",
        type: "bar",
        data: clues_per_100k,
        itemStyle: { color: COLOR.grado["Muy bajo"] }, // emerald
        barMaxWidth: 14,
      },
      {
        name: "Farmacias DENUE",
        type: "bar",
        data: farmacias_per_100k,
        itemStyle: { color: COLOR.accent }, // cyan
        barMaxWidth: 14,
      },
    ],
  };

  return (
    <ChartCard
      title="Cobertura de salud (top 10 mun. por población)"
      subtitle={
        entidadNombre
          ? `${entidadNombre} · CLUES públicas vs farmacias por 100k hab`
          : "selecciona una entidad arriba"
      }
      isLoading={isLoading}
      isError={isError}
      errorMessage={error instanceof Error ? error.message : undefined}
      isEmpty={
        entidad === null ||
        !data ||
        data.municipios.length === 0 ||
        labels.length === 0
      }
      emptyMessage={
        entidad === null
          ? "Click en una entidad del mosaico"
          : "Sin municipios joinables (>10k hab)"
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
