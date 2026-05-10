/**
 * Field catalog for Locust mode's axis pickers.
 *
 * Each entry binds a stable id (used in URL state) to:
 *   - Data source (one of 14 layers; drives the source-facet chips)
 *   - Geographic grain (muni | ageb | estado | nacional)
 *   - Field type (categorical|numeric_continuous|numeric_count|...) which
 *     drives auto-chart-type derivation
 *   - The backend route + JSON path to extract the value
 *
 * The catalog is intentionally read-only at runtime — operator edits
 * here, not via API. This file is also mirrored by tests + the Mapview
 * layer registry's subset.
 */

export type FieldGrain = "muni" | "ageb" | "estado" | "nacional";
export type FieldSource =
  | "DENUE"
  | "Censo"
  | "CONEVAL"
  | "SESNSP"
  | "EDR"
  | "CLUES"
  | "SINBA"
  | "COFEPRIS"
  | "CE2024"
  | "ENIGH"
  | "ENOE"
  | "SICT"
  | "SEDATU"
  | "CNBV";

export type FieldType =
  | "categorical_nominal"
  | "categorical_ordinal"
  | "numeric_continuous"
  | "numeric_count"
  | "numeric_pct"
  | "temporal";

export interface FieldDef {
  id: string;
  label: string;
  source: FieldSource;
  grain: FieldGrain;
  type: FieldType;
  /** Short Spanish description shown in the picker. */
  description: string;
}

export const FIELD_CATALOG: FieldDef[] = [
  // ----- DENUE ---------------------------------------------------------
  {
    id: "denue.total_establecimientos",
    label: "Total establecimientos",
    source: "DENUE",
    grain: "muni",
    type: "numeric_count",
    description: "Conteo de unidades económicas DENUE en el municipio.",
  },
  {
    id: "denue.entidad_nombre",
    label: "Entidad",
    source: "DENUE",
    grain: "estado",
    type: "categorical_nominal",
    description: "Nombre de la entidad federativa.",
  },
  {
    id: "denue.scian_sector",
    label: "Sector SCIAN",
    source: "DENUE",
    grain: "nacional",
    type: "categorical_nominal",
    description: "Sector SCIAN 2-dígito.",
  },

  // ----- Censo 2020 -----------------------------------------------------
  {
    id: "censo.pobtot",
    label: "Población total",
    source: "Censo",
    grain: "muni",
    type: "numeric_count",
    description: "Población total 2020 INEGI ITER.",
  },
  {
    id: "censo.pobtot_ageb",
    label: "Población AGEB",
    source: "Censo",
    grain: "ageb",
    type: "numeric_count",
    description: "Población a nivel AGEB urbana 2020.",
  },
  {
    id: "censo.pct_pea",
    label: "% PEA",
    source: "Censo",
    grain: "muni",
    type: "numeric_pct",
    description: "Población económicamente activa / pob ≥15 años.",
  },
  {
    id: "censo.graproes",
    label: "Escolaridad promedio",
    source: "Censo",
    grain: "muni",
    type: "numeric_continuous",
    description: "Grado promedio de escolaridad ≥15 años.",
  },
  {
    id: "censo.pct_sin_cobertura_salud",
    label: "% sin cobertura salud (AGEB)",
    source: "Censo",
    grain: "ageb",
    type: "numeric_pct",
    description: "Población sin derechohabiencia / pobtot, a nivel AGEB.",
  },

  // ----- CONEVAL -------------------------------------------------------
  {
    id: "coneval.pobreza_pct",
    label: "% pobreza",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% de población en pobreza (CONEVAL 2020).",
  },
  {
    id: "coneval.pobreza_extrema_pct",
    label: "% pobreza extrema",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% en pobreza extrema (CONEVAL 2020).",
  },
  {
    id: "coneval.carencia_acceso_salud_pct",
    label: "% sin acceso salud",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "Carencia por acceso a servicios de salud.",
  },
  {
    id: "coneval.irs_indice",
    label: "Índice rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_continuous",
    description: "IRS 2020 (continuo, mayor=más rezago).",
  },
  {
    id: "coneval.irs_grado",
    label: "Grado rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "categorical_ordinal",
    description: "Muy bajo / Bajo / Medio / Alto / Muy alto.",
  },
  {
    id: "coneval.grado_rezago_ageb",
    label: "Rezago AGEB",
    source: "CONEVAL",
    grain: "ageb",
    type: "categorical_ordinal",
    description: "Grado de rezago social a nivel AGEB urbana.",
  },

  // ----- SESNSP --------------------------------------------------------
  {
    id: "sesnsp.homicidio_doloso",
    label: "Homicidios dolosos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Casos de homicidio doloso reportados, promedio anual.",
  },
  {
    id: "sesnsp.total_delitos",
    label: "Total delitos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Total de carpetas SESNSP por municipio, promedio anual.",
  },
  {
    id: "sesnsp.ano",
    label: "Año (SESNSP)",
    source: "SESNSP",
    grain: "muni",
    type: "temporal",
    description: "Año 2015–2026.",
  },

  // ----- EDR mortalidad -------------------------------------------------
  {
    id: "edr.total_defunciones",
    label: "Defunciones totales",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones registradas en el municipio (EDR 2024).",
  },
  {
    id: "edr.def_circulatorio",
    label: "Defunciones circulatorio",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por enfermedades del sistema circulatorio.",
  },
  {
    id: "edr.def_neoplasias",
    label: "Defunciones neoplasias",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por neoplasias.",
  },

  // ----- CLUES ---------------------------------------------------------
  {
    id: "clues.total",
    label: "CLUES total",
    source: "CLUES",
    grain: "muni",
    type: "numeric_count",
    description: "Establecimientos de salud DGIS en operación.",
  },

  // ----- SINBA --------------------------------------------------------
  {
    id: "sinba.casos_dm2_promedio",
    label: "Casos DM2 promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos diabetes tipo 2 / promedio mensual activos SUS.",
  },
  {
    id: "sinba.casos_hta_promedio",
    label: "Casos HTA promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos hipertensión / promedio mensual activos SUS.",
  },
  {
    id: "sinba.casos_obesidad_promedio",
    label: "Casos obesidad promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos obesidad / promedio mensual activos SUS.",
  },

  // ----- COFEPRIS ------------------------------------------------------
  {
    id: "cofepris.total_licenciadas",
    label: "Farmacias licenciadas",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias con licencia sanitaria vigente COFEPRIS.",
  },
  {
    id: "cofepris.con_estupefacientes",
    label: "Farmacias c/ estupefacientes",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias autorizadas a vender estupefacientes.",
  },
  {
    id: "cofepris.con_controlados_ageb",
    label: "Farmacias controladas (AGEB)",
    source: "COFEPRIS",
    grain: "ageb",
    type: "numeric_count",
    description: "Farmacias con controlados a nivel AGEB.",
  },

  // ----- CE 2024 -------------------------------------------------------
  {
    id: "ce2024.ue",
    label: "Unidades económicas CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Unidades económicas Censo Económico 2024.",
  },
  {
    id: "ce2024.personal_ocupado",
    label: "Personal ocupado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Personal ocupado total (Censo Económico 2024).",
  },
  {
    id: "ce2024.valor_agregado",
    label: "Valor agregado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_continuous",
    description: "Valor agregado censal bruto (CE 2024).",
  },

  // ----- ENIGH ---------------------------------------------------------
  {
    id: "enigh.ingreso_p50",
    label: "Ingreso mediano (ENIGH)",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_continuous",
    description: "Ingreso mediano estatal ponderado, ENIGH 2024.",
  },
  {
    id: "enigh.engel_coefficient",
    label: "Coeficiente Engel",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_pct",
    description: "% gasto en alimentos / gasto total (ENIGH).",
  },

  // ----- ENOE ----------------------------------------------------------
  {
    id: "enoe.pct_informal",
    label: "% informalidad",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de informalidad laboral ENOE 2025.",
  },
  {
    id: "enoe.tasa_desocupacion",
    label: "Tasa desocupación",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de desocupación ENOE 2025.",
  },

  // ----- SICT ----------------------------------------------------------
  {
    id: "sict.tdpa_total",
    label: "TDPA total",
    source: "SICT",
    grain: "muni",
    type: "numeric_count",
    description: "Tránsito diario promedio anual (SICT).",
  },

  // ----- SEDATU --------------------------------------------------------
  {
    id: "sedatu.monto_total",
    label: "Monto subsidiado SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto subsidiado total vivienda 2025.",
  },
  {
    id: "sedatu.acciones_total",
    label: "Acciones SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_count",
    description: "Acciones de financiamiento SEDATU.",
  },

  // ----- CNBV ----------------------------------------------------------
  {
    id: "cnbv.monto_total",
    label: "Monto crédito CNBV",
    source: "CNBV",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto crédito comercial total 2025.",
  },
  {
    id: "cnbv.pct_femenino",
    label: "% crédito femenino",
    source: "CNBV",
    grain: "muni",
    type: "numeric_pct",
    description: "% acciones a mujeres (crédito comercial CNBV).",
  },
];

export const FIELD_SOURCES: FieldSource[] = [
  "DENUE",
  "Censo",
  "CONEVAL",
  "SESNSP",
  "EDR",
  "CLUES",
  "SINBA",
  "COFEPRIS",
  "CE2024",
  "ENIGH",
  "ENOE",
  "SICT",
  "SEDATU",
  "CNBV",
];

export function findField(id: string): FieldDef | undefined {
  return FIELD_CATALOG.find((f) => f.id === id);
}

export function isCategorical(t: FieldType): boolean {
  return t === "categorical_nominal" || t === "categorical_ordinal";
}

export function isNumeric(t: FieldType): boolean {
  return (
    t === "numeric_continuous" || t === "numeric_count" || t === "numeric_pct"
  );
}

/**
 * Pick the chart type given two axes. The Locust override lets the user
 * pick explicitly; this is the auto-derive baseline.
 */
export function deriveChartType(
  x: FieldType | null,
  y: FieldType | null,
): "bar" | "scatter" | "line" | "heatmap" | "treemap" {
  if (!x && !y) return "treemap";
  if (x === "temporal" && y && isNumeric(y)) return "line";
  if (x && isCategorical(x) && y && isCategorical(y)) return "heatmap";
  if (x && isNumeric(x) && y && isNumeric(y)) return "scatter";
  if (x && isCategorical(x) && y && isNumeric(y)) return "bar";
  if (x && isNumeric(x) && y && isCategorical(y)) return "bar";
  if (x && !y) return "bar";
  return "bar";
}
