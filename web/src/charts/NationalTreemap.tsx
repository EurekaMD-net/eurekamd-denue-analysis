import ReactECharts from "echarts-for-react";
import { useNationalTreemap } from "../api/queries";
import { useUiStore } from "../store";
import { ChartCard } from "./ChartCard";
import { COLOR, ECHARTS_BASE } from "./theme";

/**
 * 32 entidades sized by establecimientos count, colored by modal IRS grade
 * across their municipios. Click a tile → sets the entidad filter, which
 * cascades into the per-entidad charts below.
 */
export function NationalTreemap() {
  const { data, isLoading, isError, error } = useNationalTreemap();
  const setEntidad = useUiStore((s) => s.setEntidad);
  const selected = useUiStore((s) => s.entidad);

  const dataItems = (data?.entidades ?? []).map((e) => ({
    name: `${e.nombre}\n${e.establecimientos.toLocaleString("es-MX")}`,
    value: e.establecimientos,
    entidad: e.entidad,
    nombreCorto: e.nombre,
    irs: e.modal_irs_grado,
    pobreza: e.pobreza_pct_promedio,
    itemStyle: {
      color: COLOR.grado[e.modal_irs_grado],
      borderColor: e.entidad === selected ? COLOR.accent : COLOR.panel,
      borderWidth: e.entidad === selected ? 2 : 1,
    },
  }));

  const option = {
    ...ECHARTS_BASE,
    tooltip: {
      ...ECHARTS_BASE.tooltip,
      formatter: (params: {
        data: {
          nombreCorto?: string;
          value: number;
          irs?: string;
          pobreza?: number | null;
        };
      }) => {
        const d = params.data;
        if (!d.nombreCorto) return "";
        const pob =
          d.pobreza === null || d.pobreza === undefined
            ? "—"
            : `${d.pobreza.toFixed(1)}%`;
        return (
          `<b>${d.nombreCorto}</b><br/>` +
          `Establecimientos: ${d.value.toLocaleString("es-MX")}<br/>` +
          `IRS modal: ${d.irs ?? "—"}<br/>` +
          `Pobreza promedio: ${pob}`
        );
      },
    },
    series: [
      {
        type: "treemap",
        data: dataItems,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          show: true,
          fontSize: 11,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          color: COLOR.bg,
          fontWeight: 600,
          formatter: "{b}",
          overflow: "truncate",
        },
        upperLabel: { show: false },
        itemStyle: { borderRadius: 2, gapWidth: 2 },
        emphasis: {
          itemStyle: { borderColor: COLOR.accent, borderWidth: 2 },
        },
      },
    ],
  };

  return (
    <ChartCard
      title="Mosaico nacional · 32 entidades"
      subtitle="tamaño = establecimientos · color = IRS modal"
      isLoading={isLoading}
      isError={isError}
      errorMessage={error instanceof Error ? error.message : undefined}
      isEmpty={!data || data.entidades.length === 0}
      height="h-96"
    >
      <ReactECharts
        option={option}
        notMerge
        style={{ height: "100%", width: "100%" }}
        onEvents={{
          click: (params: { data?: { entidad?: string } }) => {
            const ent = params.data?.entidad;
            if (typeof ent === "string") {
              setEntidad(selected === ent ? null : ent);
            }
          },
        }}
      />
    </ChartCard>
  );
}
