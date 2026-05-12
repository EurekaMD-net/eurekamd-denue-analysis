/**
 * Field catalog for Locust mode's axis pickers.
 *
 * Each entry binds a stable id (used in URL state) to:
 *   - Data source (one of 14 layers; drives the source-facet chips)
 *   - Preferred grain (muni | ageb | estado | nacional) — drives the picker
 *     grain-section header and is the default join key when the field acts
 *     as X.
 *   - Field type (categorical|numeric_continuous|numeric_count|...) which
 *     drives auto-chart-type derivation.
 *   - `xEligible`: may this field anchor a chart as the X axis? Only fields
 *     that produce a category set (categorical_nominal or categorical_ordinal)
 *     and have at least one column on a Locust-reachable endpoint qualify.
 *     Temporal anchors are reserved for a future "time series" mode; today
 *     they are not X-eligible.
 *   - `columns`: per-grain column name on the corresponding endpoint
 *     payload. Y/Z compatibility with a chosen X is decided by whether
 *     this map has an entry for `xAxis.field.grain`. An empty map means
 *     the field is not yet reachable from any Locust endpoint.
 *
 * Reachable endpoints, by grain, are declared in `GRAIN_ENDPOINTS` below.
 * Adding a new endpoint requires:
 *   1. A row in GRAIN_ENDPOINTS for its grain.
 *   2. Populating `columns[<grain>]` on every FieldDef that endpoint serves.
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
  description: string;
  /**
   * X-axis eligibility. Set to true for category-producing anchor fields
   * (entidad name, municipio name, SCIAN sector). Y/Z slots ignore this.
   */
  xEligible: boolean;
  /**
   * Per-grain payload column name. Y/Z fields are graphable against an X
   * field iff `columns[xField.grain]` is defined.
   *
   * Empty object ({}) = field is in the catalog but no Locust endpoint
   * currently serves it. Surfaced in the picker as a disabled
   * "próximamente" row so users see what's coming.
   */
  columns: Partial<Record<FieldGrain, string>>;
  /**
   * For `categorical_ordinal` fields only: the canonical order of category
   * values, smallest → largest. Used by Locust's Z-colourant pipeline to
   * map a categorical Z (e.g. "Muy bajo" / "Bajo" / "Medio" / "Alto" /
   * "Muy alto") to a [0,1] gradient position.
   *
   * Values absent from this array (e.g. "sin_dato") render as the slate
   * "no-data" colour. The order is stable across renders; do NOT derive
   * it from observed payload order.
   */
  ordinalOrder?: readonly string[];
}

/**
 * IRS rezago social scale, smallest rezago → largest. Used by both
 * `coneval.irs_grado` (muni) and modal-IRS columns rolled up to estado.
 */
export const IRS_GRADO_ORDER = [
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
] as const;

/**
 * Endpoints Locust can dispatch to, keyed by the X-anchor's grain.
 *
 *   path(entidad): the URL to fetch. `entidad` is the currently selected
 *     2-digit clave from FilterControls; some endpoints require it.
 *     Returns null if the endpoint needs entidad and none is selected.
 *   rowsKey: where the row array lives in the JSON envelope.
 *   needsEntidad: surfaces an inline "selecciona una entidad" hint to the
 *     user before fetch is even attempted.
 */
export interface GrainEndpoint {
  path: (entidad: string | null) => string | null;
  rowsKey: string;
  needsEntidad: boolean;
}

export const GRAIN_ENDPOINTS: Partial<Record<FieldGrain, GrainEndpoint>> = {
  estado: {
    path: () => "/analytics/national-treemap",
    rowsKey: "entidades",
    needsEntidad: false,
  },
  muni: {
    path: (entidad) =>
      entidad ? `/analytics/municipios?entidad=${entidad}` : null,
    rowsKey: "municipios",
    needsEntidad: true,
  },
  nacional: {
    path: (entidad) =>
      entidad ? `/analytics/top-sectors?entidad=${entidad}` : null,
    rowsKey: "sectors",
    needsEntidad: true,
  },
  // ageb: no endpoint serves a multi-row ageb-grain chart yet.
};

export const FIELD_CATALOG: FieldDef[] = [
  // ----- DENUE ---------------------------------------------------------
  {
    id: "denue.total_establecimientos",
    label: "Total establecimientos",
    source: "DENUE",
    grain: "muni",
    type: "numeric_count",
    description: "Conteo de unidades económicas DENUE.",
    xEligible: false,
    // /national-treemap: establecimientos per estado.
    // /municipios: establecimientos per muni.
    // /top-sectors: 'count' per SCIAN sector.
    columns: {
      estado: "establecimientos",
      muni: "establecimientos",
      nacional: "count",
    },
  },
  {
    id: "denue.entidad_nombre",
    label: "Entidad",
    source: "DENUE",
    grain: "estado",
    type: "categorical_nominal",
    description: "Nombre de la entidad federativa (32 estados).",
    xEligible: true,
    columns: { estado: "nombre" },
  },
  {
    id: "denue.municipio_nombre",
    label: "Municipio",
    source: "DENUE",
    grain: "muni",
    type: "categorical_nominal",
    description: "Nombre del municipio dentro de la entidad seleccionada.",
    xEligible: true,
    columns: { muni: "municipio" },
  },
  {
    id: "denue.scian_sector",
    label: "Sector SCIAN",
    source: "DENUE",
    grain: "nacional",
    type: "categorical_nominal",
    description: "Sector SCIAN 2-dígito (etiqueta legible).",
    xEligible: true,
    columns: { nacional: "name" },
  },

  // ----- Censo 2020 -----------------------------------------------------
  {
    id: "censo.pobtot",
    label: "Población total",
    source: "Censo",
    grain: "muni",
    type: "numeric_count",
    description: "Población total 2020 INEGI (en /municipios).",
    xEligible: false,
    columns: { muni: "poblacion" },
  },
  {
    id: "censo.pobtot_ageb",
    label: "Población AGEB",
    source: "Censo",
    grain: "ageb",
    type: "numeric_count",
    description: "Población a nivel AGEB urbana 2020.",
    xEligible: false,
    columns: {},
  },
  {
    id: "censo.pct_pea",
    label: "% PEA",
    source: "Censo",
    grain: "muni",
    type: "numeric_pct",
    description: "Población económicamente activa / pob ≥15 años.",
    xEligible: false,
    columns: {},
  },
  {
    id: "censo.graproes",
    label: "Escolaridad promedio",
    source: "Censo",
    grain: "muni",
    type: "numeric_continuous",
    description: "Grado promedio de escolaridad ≥15 años.",
    xEligible: false,
    columns: {},
  },
  {
    id: "censo.pct_sin_cobertura_salud",
    label: "% sin cobertura salud (AGEB)",
    source: "Censo",
    grain: "ageb",
    type: "numeric_pct",
    description: "Población sin derechohabiencia / pobtot, AGEB.",
    xEligible: false,
    columns: {},
  },

  // ----- CONEVAL -------------------------------------------------------
  {
    id: "coneval.pobreza_pct",
    label: "% pobreza",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% en pobreza (CONEVAL 2020).",
    xEligible: false,
    // /national-treemap: pobreza_pct_promedio (ponderado por población).
    // /municipios: pobreza_pct directo.
    columns: { estado: "pobreza_pct_promedio", muni: "pobreza_pct" },
  },
  {
    id: "coneval.pobreza_extrema_pct",
    label: "% pobreza extrema",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% en pobreza extrema (CONEVAL 2020).",
    xEligible: false,
    columns: {},
  },
  {
    id: "coneval.carencia_acceso_salud_pct",
    label: "% sin acceso salud",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "Carencia por acceso a servicios de salud.",
    xEligible: false,
    columns: {},
  },
  {
    id: "coneval.irs_indice",
    label: "Índice rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_continuous",
    description: "IRS 2020 (continuo, mayor = más rezago).",
    xEligible: false,
    columns: { muni: "irs_indice" },
  },
  {
    id: "coneval.irs_grado",
    label: "Grado rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "categorical_ordinal",
    description: "Muy bajo / Bajo / Medio / Alto / Muy alto.",
    xEligible: false,
    // /national-treemap: modal_irs_grado (moda por estado).
    // /municipios: irs_grado directo.
    columns: { estado: "modal_irs_grado", muni: "irs_grado" },
    ordinalOrder: IRS_GRADO_ORDER,
  },
  {
    id: "coneval.grado_rezago_ageb",
    label: "Rezago AGEB",
    source: "CONEVAL",
    grain: "ageb",
    type: "categorical_ordinal",
    description: "Grado de rezago social a nivel AGEB urbana.",
    xEligible: false,
    columns: {},
    ordinalOrder: IRS_GRADO_ORDER,
  },

  // ----- SESNSP --------------------------------------------------------
  {
    id: "sesnsp.homicidio_doloso",
    label: "Homicidios dolosos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Casos de homicidio doloso reportados, promedio anual.",
    xEligible: false,
    columns: {},
  },
  {
    id: "sesnsp.total_delitos",
    label: "Total delitos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Total de carpetas SESNSP por municipio, promedio anual.",
    xEligible: false,
    columns: {},
  },
  {
    id: "sesnsp.ano",
    label: "Año (SESNSP)",
    source: "SESNSP",
    grain: "muni",
    type: "temporal",
    description: "Año 2015–2026.",
    xEligible: false,
    columns: {},
  },

  // ----- EDR mortalidad -------------------------------------------------
  {
    id: "edr.total_defunciones",
    label: "Defunciones totales",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones registradas en el municipio (EDR 2024).",
    xEligible: false,
    columns: {},
  },
  {
    id: "edr.def_circulatorio",
    label: "Defunciones circulatorio",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por enfermedades del sistema circulatorio.",
    xEligible: false,
    columns: {},
  },
  {
    id: "edr.def_neoplasias",
    label: "Defunciones neoplasias",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por neoplasias.",
    xEligible: false,
    columns: {},
  },

  // ----- CLUES ---------------------------------------------------------
  {
    id: "clues.total",
    label: "CLUES total",
    source: "CLUES",
    grain: "muni",
    type: "numeric_count",
    description: "Establecimientos de salud DGIS en operación.",
    xEligible: false,
    columns: { muni: "unidades_clues" },
  },

  // ----- SINBA --------------------------------------------------------
  {
    id: "sinba.casos_dm2_promedio",
    label: "Casos DM2 promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos diabetes tipo 2 / promedio mensual activos SUS.",
    xEligible: false,
    columns: {},
  },
  {
    id: "sinba.casos_hta_promedio",
    label: "Casos HTA promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos hipertensión / promedio mensual activos SUS.",
    xEligible: false,
    columns: {},
  },
  {
    id: "sinba.casos_obesidad_promedio",
    label: "Casos obesidad promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos obesidad / promedio mensual activos SUS.",
    xEligible: false,
    columns: {},
  },

  // ----- COFEPRIS ------------------------------------------------------
  {
    id: "cofepris.total_licenciadas",
    label: "Farmacias licenciadas",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias con licencia sanitaria vigente COFEPRIS.",
    xEligible: false,
    columns: {},
  },
  {
    id: "cofepris.con_estupefacientes",
    label: "Farmacias c/ estupefacientes",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias autorizadas a vender estupefacientes.",
    xEligible: false,
    columns: {},
  },
  {
    id: "cofepris.con_controlados_ageb",
    label: "Farmacias controladas (AGEB)",
    source: "COFEPRIS",
    grain: "ageb",
    type: "numeric_count",
    description: "Farmacias con controlados a nivel AGEB.",
    xEligible: false,
    columns: {},
  },

  // ----- CE 2024 -------------------------------------------------------
  {
    id: "ce2024.ue",
    label: "Unidades económicas CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Unidades económicas Censo Económico 2024.",
    xEligible: false,
    columns: {},
  },
  {
    id: "ce2024.personal_ocupado",
    label: "Personal ocupado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Personal ocupado total (Censo Económico 2024).",
    xEligible: false,
    columns: {},
  },
  {
    id: "ce2024.valor_agregado",
    label: "Valor agregado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_continuous",
    description: "Valor agregado censal bruto (CE 2024).",
    xEligible: false,
    columns: {},
  },

  // ----- ENIGH ---------------------------------------------------------
  {
    id: "enigh.ingreso_p50",
    label: "Ingreso mediano (ENIGH)",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_continuous",
    description: "Ingreso mediano estatal ponderado, ENIGH 2024.",
    xEligible: false,
    columns: {},
  },
  {
    id: "enigh.engel_coefficient",
    label: "Coeficiente Engel",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_pct",
    description: "% gasto en alimentos / gasto total (ENIGH).",
    xEligible: false,
    columns: {},
  },

  // ----- ENOE ----------------------------------------------------------
  {
    id: "enoe.pct_informal",
    label: "% informalidad",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de informalidad laboral ENOE 2025.",
    xEligible: false,
    columns: {},
  },
  {
    id: "enoe.tasa_desocupacion",
    label: "Tasa desocupación",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de desocupación ENOE 2025.",
    xEligible: false,
    columns: {},
  },

  // ----- SICT ----------------------------------------------------------
  {
    id: "sict.tdpa_total",
    label: "TDPA total",
    source: "SICT",
    grain: "muni",
    type: "numeric_count",
    description: "Tránsito diario promedio anual (SICT).",
    xEligible: false,
    columns: {},
  },

  // ----- SEDATU --------------------------------------------------------
  {
    id: "sedatu.monto_total",
    label: "Monto subsidiado SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto subsidiado total vivienda 2025.",
    xEligible: false,
    columns: {},
  },
  {
    id: "sedatu.acciones_total",
    label: "Acciones SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_count",
    description: "Acciones de financiamiento SEDATU.",
    xEligible: false,
    columns: {},
  },

  // ----- CNBV ----------------------------------------------------------
  {
    id: "cnbv.monto_total",
    label: "Monto crédito CNBV",
    source: "CNBV",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto crédito comercial total 2025.",
    xEligible: false,
    columns: {},
  },
  {
    id: "cnbv.pct_femenino",
    label: "% crédito femenino",
    source: "CNBV",
    grain: "muni",
    type: "numeric_pct",
    description: "% acciones a mujeres (crédito comercial CNBV).",
    xEligible: false,
    columns: {},
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

/** True iff this field can be selected at all from the Locust picker. */
export function isFieldReachable(f: FieldDef): boolean {
  return Object.keys(f.columns).length > 0;
}

/** True iff this field is graphable against an X-anchor at the given grain. */
export function isFieldGraphableAt(
  f: FieldDef,
  anchorGrain: FieldGrain,
): boolean {
  return f.columns[anchorGrain] !== undefined;
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
