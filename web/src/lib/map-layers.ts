/**
 * Frontend mirror of the backend `MAP_LAYER_REGISTRY` (see
 * src/api/handlers/layers-values.ts). Each layer id here must exist on
 * the backend; the frontend uses this for picker UI + grain-availability
 * filtering. If you add a backend layer, mirror it here.
 */

export type MapLayerGrain = "muni" | "ageb";

export interface MapLayerSpec {
  id: string;
  label: string;
  grain: MapLayerGrain;
  /** One-line Spanish description. */
  description: string;
  /** Domain hint for the bivariate scale (auto-rebinned per-render). */
  units?: "%" | "count" | "score" | "MXN" | "ordinal";
}

export const MAP_LAYERS: MapLayerSpec[] = [
  // muni-grain
  {
    id: "pobreza_pct",
    label: "% pobreza",
    grain: "muni",
    description: "CONEVAL 2020 % en pobreza.",
    units: "%",
  },
  {
    id: "pobreza_extrema_pct",
    label: "% pobreza extrema",
    grain: "muni",
    description: "CONEVAL 2020 % en pobreza extrema.",
    units: "%",
  },
  {
    id: "carencia_acceso_salud_pct",
    label: "% carencia salud",
    grain: "muni",
    description: "% con carencia por acceso a servicios de salud.",
    units: "%",
  },
  {
    id: "irs_indice",
    label: "Índice rezago social",
    grain: "muni",
    description: "IRS 2020 (mayor = más rezago).",
    units: "score",
  },
  {
    id: "homicidio_doloso_year",
    label: "Homicidio doloso (anual)",
    grain: "muni",
    description: "SESNSP promedio anual 2015–último cierre.",
    units: "count",
  },
  {
    id: "total_delitos_year",
    label: "Delitos totales (anual)",
    grain: "muni",
    description: "SESNSP carpetas totales promedio anual.",
    units: "count",
  },
  {
    id: "defunciones_total",
    label: "Defunciones 2024",
    grain: "muni",
    description: "EDR 2024 defunciones totales en el municipio.",
    units: "count",
  },
  {
    id: "farmacias_licenciadas",
    label: "Farmacias COFEPRIS",
    grain: "muni",
    description: "Farmacias con licencia sanitaria vigente.",
    units: "count",
  },
  {
    id: "farmacias_endorsements_controlados",
    label: "Endosos controlados",
    grain: "muni",
    description:
      "Suma de farmacias autorizadas para sustancias controladas (sobrecuenta si una farmacia tiene varios endosos).",
    units: "count",
  },
  {
    id: "dm2_casos_promedio",
    label: "Casos DM2 SINBA",
    grain: "muni",
    description: "Casos diabetes T2 promedio mensual SUS.",
    units: "count",
  },
  {
    id: "monto_credito_comercial",
    label: "Monto crédito comercial CNBV",
    grain: "muni",
    description: "Monto total crédito comercial 2025.",
    units: "MXN",
  },
  {
    id: "pct_femenino_credito",
    label: "% crédito femenino",
    grain: "muni",
    description: "% de acciones de crédito otorgadas a mujeres.",
    units: "%",
  },
  {
    id: "monto_subsidiado_vivienda",
    label: "Subsidio vivienda SEDATU",
    grain: "muni",
    description: "Monto subsidiado total vivienda 2025.",
    units: "MXN",
  },
  {
    id: "acciones_vivienda_total",
    label: "Acciones SEDATU",
    grain: "muni",
    description: "Acciones de financiamiento SEDATU.",
    units: "count",
  },
  {
    id: "tdpa_total",
    label: "TDPA carretero",
    grain: "muni",
    description: "Tránsito diario promedio anual SICT.",
    units: "count",
  },
  {
    id: "pobtot_muni",
    label: "Población total",
    grain: "muni",
    description: "Censo 2020 pobtot municipal.",
    units: "count",
  },
  // AGEB-grain
  {
    id: "pobtot_ageb",
    label: "Pobtot AGEB",
    grain: "ageb",
    description: "Censo 2020 pobtot a nivel AGEB.",
    units: "count",
  },
  {
    id: "pct_sin_cobertura_salud",
    label: "% sin cobertura salud (AGEB)",
    grain: "ageb",
    description:
      "Personas sin derechohabiencia / pobtot, expresado en porcentaje.",
    units: "%",
  },
  {
    id: "grado_rezago_ageb_ordinal",
    label: "Rezago AGEB (1–5)",
    grain: "ageb",
    description:
      "Grado de rezago CONEVAL 2020 codificado 1=Muy bajo … 5=Muy alto.",
    units: "ordinal",
  },
  {
    id: "farmacias_licenciadas_ageb",
    label: "Farmacias COFEPRIS (AGEB)",
    grain: "ageb",
    description: "Farmacias con licencia sanitaria en la AGEB.",
    units: "count",
  },
];

export function layersForGrain(grain: MapLayerGrain): MapLayerSpec[] {
  return MAP_LAYERS.filter((l) => l.grain === grain);
}

export function findLayer(id: string): MapLayerSpec | undefined {
  return MAP_LAYERS.find((l) => l.id === id);
}
