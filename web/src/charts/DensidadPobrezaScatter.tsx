import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { useMunicipiosAnalytics } from "../api/queries";
import type { IrsGrado, MunicipioAnalyticsRow } from "../api/types";
import { ChartCard } from "./ChartCard";
import {
  COLOR,
  ECHARTS_AXIS_DARK,
  ECHARTS_BASE,
  IRS_GRADO_ORDER,
} from "./theme";

interface Props {
  entidad: string | null;
  entidadNombre?: string;
}

/**
 * Per-municipio scatter for the selected entidad.
 *   X = establecimientos por 1k habitantes (commercial density)
 *   Y = % población en pobreza (CONEVAL)
 *   size = población (sqrt-scaled)
 *   color = grado IRS (sin_dato → slate)
 *
 * Reads at a glance: top-left = "alto comercio en pobreza baja"
 * (mature urban centers). Bottom-right = "bajo comercio en pobreza alta"
 * (rural/marginal). Outliers in either quadrant are interesting.
 */
export function DensidadPobrezaScatter({ entidad, entidadNombre }: Props) {
  const { data, isLoading, isError, error } = useMunicipiosAnalytics(entidad);

  const seriesByGrado = useMemo(() => {
    const buckets = new Map<IrsGrado | "sin_dato", MunicipioAnalyticsRow[]>();
    for (const m of data?.municipios ?? []) {
      const grado: IrsGrado = m.irs_grado ?? "sin_dato";
      const arr = buckets.get(grado) ?? [];
      arr.push(m);
      buckets.set(grado, arr);
    }
    return buckets;
  }, [data]);

  const series = IRS_GRADO_ORDER.map((g) => {
    const muns = seriesByGrado.get(g) ?? [];
    const dotData = muns
      .filter(
        (m) =>
          m.poblacion !== null && m.poblacion > 0 && m.pobreza_pct !== null,
      )
      .map((m) => {
        // Filter above gates `m.poblacion !== null && m.poblacion > 0`,
        // so the non-null assertion is sound. Audit Locust-W3 (2026-05-04):
        // dropped the `?? 1` fallback that would have silently inflated
        // densities if the filter were ever loosened.
        const densidad = (m.establecimientos / m.poblacion!) * 1000;
        return {
          name: m.municipio ?? m.cve_mun,
          value: [
            Number(densidad.toFixed(2)),
            m.pobreza_pct,
            m.poblacion,
            m.cve_mun,
            g,
          ],
        };
      });
    return {
      name: g,
      type: "scatter",
      data: dotData,
      itemStyle: { color: COLOR.grado[g], opacity: 0.8 },
      symbolSize: (val: number[]) => {
        const pob = val[2] ?? 0;
        return Math.min(36, Math.max(4, Math.sqrt(pob / 1000)));
      },
      emphasis: { focus: "series" },
    };
  });

  const option = {
    ...ECHARTS_BASE,
    legend: {
      type: "scroll",
      bottom: 0,
      textStyle: { color: COLOR.textMuted, fontSize: 10 },
      itemWidth: 10,
      itemHeight: 10,
      data: IRS_GRADO_ORDER.map((g) => ({ name: g })),
    },
    tooltip: {
      ...ECHARTS_BASE.tooltip,
      formatter: (p: {
        name: string;
        value: [number, number, number, string, string];
      }) => {
        const [d, pob_pct, pob, cve_mun, grado] = p.value;
        return (
          `<b>${p.name}</b> · ${cve_mun}<br/>` +
          `Densidad: ${d.toFixed(2)} estab/1k hab<br/>` +
          `Pobreza: ${pob_pct?.toFixed(1) ?? "—"}%<br/>` +
          `Población: ${pob?.toLocaleString("es-MX") ?? "—"}<br/>` +
          `IRS: ${grado}`
        );
      },
    },
    grid: { left: 56, right: 16, top: 16, bottom: 56 },
    xAxis: {
      type: "value",
      name: "estab / 1k hab",
      nameGap: 28,
      nameTextStyle: { color: COLOR.textMuted, fontSize: 10 },
      ...ECHARTS_AXIS_DARK,
    },
    yAxis: {
      type: "value",
      name: "% pobreza",
      nameGap: 32,
      nameTextStyle: { color: COLOR.textMuted, fontSize: 10 },
      min: 0,
      max: 100,
      ...ECHARTS_AXIS_DARK,
    },
    series,
  };

  return (
    <ChartCard
      title="Densidad comercial vs Pobreza"
      subtitle={
        entidadNombre
          ? `${entidadNombre} · 1 punto = 1 municipio`
          : "selecciona una entidad para ver municipios"
      }
      isLoading={isLoading}
      isError={isError}
      errorMessage={error instanceof Error ? error.message : undefined}
      isEmpty={entidad === null || !data || data.municipios.length === 0}
      emptyMessage={
        entidad === null
          ? "Click en una entidad del mosaico"
          : "Municipios sin datos joinables"
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
