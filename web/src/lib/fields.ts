/**
 * Field catalog for Locust mode's axis pickers.
 *
 * Architecture (revised 2026-05-12, per-field endpoint model):
 *
 *   - Each backend endpoint that returns multi-row data is registered in
 *     `ENDPOINTS` with its path, rowsKey envelope, grain (display label),
 *     and entidad-requirement.
 *   - Each FieldDef declares `endpoints: Partial<Record<EndpointId,string>>` —
 *     for each endpoint that serves the field, the column name on the
 *     payload rows. A field with an empty `endpoints` map is unreachable.
 *   - Locust dispatches the fetch using X's chosen endpoint
 *     (`field.primaryEndpoint ?? first key of endpoints`). Y/Z gating is
 *     decided by "Y has a column on X's endpoint" — not by grain. Two
 *     muni-grain endpoints (`/municipios` and `/risk-summary`) return
 *     DIFFERENT column sets, so the gate must be endpoint-keyed.
 *
 * Why this is better than the prior grain-keyed model:
 *   - Adding a backend endpoint = adding a row to ENDPOINTS + populating
 *     one or more `endpoints[id]` entries. No central dispatcher change.
 *   - Y/Z compatibility is exact (same row source), not heuristic.
 *   - Multi-source columns (e.g. `municipio` exists on /municipios, /risk-
 *     summary, /mortality-summary) are wired to all three endpoints, so
 *     picking sesnsp.homicidio_doloso as X also gives denue.municipio_nombre
 *     as a Y option for free.
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

/**
 * Stable identifiers for the backend endpoints Locust can dispatch to.
 * Adding a new endpoint requires:
 *   1. New EndpointId literal here.
 *   2. New entry in ENDPOINTS below.
 *   3. Populating `endpoints[<new-id>]` on every FieldDef the endpoint
 *      serves (and verifying the column name matches the response shape).
 */
export type EndpointId =
  | "national-treemap"
  | "municipios"
  | "top-sectors"
  | "risk-summary"
  | "mortality-summary"
  | "locust-muni"
  | "locust-estado";

export interface EndpointDef {
  id: EndpointId;
  /**
   * Resolves the full URL given the operator's selected `entidad` clave.
   * Returns null when the endpoint requires an entidad and none is set.
   */
  path: (entidad: string | null) => string | null;
  /** Key on the JSON envelope where the row array lives. */
  rowsKey: string;
  /** Surfaces the "selecciona una entidad" hint pre-fetch. */
  needsEntidad: boolean;
  /** Display grain — drives the picker chip label. */
  grain: FieldGrain;
  /** Human-friendly label for the picker context hint. */
  label: string;
}

export const ENDPOINTS: Record<EndpointId, EndpointDef> = {
  "national-treemap": {
    id: "national-treemap",
    path: () => "/analytics/national-treemap",
    rowsKey: "entidades",
    needsEntidad: false,
    grain: "estado",
    label: "Estados (DENUE national treemap)",
  },
  municipios: {
    id: "municipios",
    path: (entidad) =>
      entidad ? `/analytics/municipios?entidad=${entidad}` : null,
    rowsKey: "municipios",
    needsEntidad: true,
    grain: "muni",
    label: "Municipios (DENUE+CONEVAL+CLUES per muni)",
  },
  "top-sectors": {
    id: "top-sectors",
    path: (entidad) =>
      entidad ? `/analytics/top-sectors?entidad=${entidad}` : null,
    rowsKey: "sectors",
    needsEntidad: true,
    grain: "nacional",
    label: "Sectores SCIAN (top por entidad)",
  },
  "risk-summary": {
    id: "risk-summary",
    path: (entidad) =>
      entidad ? `/analytics/risk-summary?entidad=${entidad}` : null,
    rowsKey: "municipios",
    needsEntidad: true,
    grain: "muni",
    label: "Riesgo SESNSP (delitos por municipio)",
  },
  "mortality-summary": {
    id: "mortality-summary",
    path: (entidad) =>
      entidad ? `/analytics/mortality-summary?entidad=${entidad}` : null,
    rowsKey: "municipios",
    needsEntidad: true,
    grain: "muni",
    label: "Mortalidad EDR (defunciones por municipio)",
  },
  "locust-muni": {
    id: "locust-muni",
    path: (entidad) =>
      entidad ? `/analytics/locust-muni?entidad=${entidad}` : null,
    rowsKey: "municipios",
    needsEntidad: true,
    grain: "muni",
    label: "Composite muni (todas las fuentes joinables por cve_mun)",
  },
  "locust-estado": {
    id: "locust-estado",
    path: () => "/analytics/locust-estado",
    rowsKey: "entidades",
    needsEntidad: false,
    grain: "estado",
    label: "Composite estado (ENOE + ENIGH + censo entidades)",
  },
};

export interface FieldDef {
  id: string;
  label: string;
  source: FieldSource;
  /** Canonical/display grain — drives picker chip + grouping. */
  grain: FieldGrain;
  type: FieldType;
  description: string;
  /**
   * Per-endpoint payload column name. Empty map = unreachable
   * ("próximamente" in the picker, no endpoint serves it yet).
   * Y/Z are joinable with X iff their `endpoints[X.activeEndpoint]` is defined.
   */
  endpoints: Partial<Record<EndpointId, string>>;
  /**
   * Default endpoint when this field is picked as X. If absent, the
   * dispatcher falls back to the first key in `endpoints`. Useful when a
   * field appears on multiple endpoints and one is more informative as
   * an anchor (e.g. denue.total_establecimientos → "municipios" by default,
   * not "national-treemap").
   */
  primaryEndpoint?: EndpointId;
  /**
   * For `categorical_ordinal` fields only: canonical order of category
   * values, smallest → largest. Drives the Z-colourant pipeline.
   */
  ordinalOrder?: readonly string[];
}

export const IRS_GRADO_ORDER = [
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
] as const;

export const FIELD_CATALOG: FieldDef[] = [
  // ----- DENUE ---------------------------------------------------------
  {
    id: "denue.total_establecimientos",
    label: "Total establecimientos",
    source: "DENUE",
    grain: "muni",
    type: "numeric_count",
    description: "Conteo de unidades económicas DENUE.",
    endpoints: {
      "locust-muni": "denue_establecimientos",
      municipios: "establecimientos",
      "national-treemap": "establecimientos",
      "top-sectors": "count",
    },
    primaryEndpoint: "locust-muni",
  },
  {
    id: "denue.entidad_nombre",
    label: "Entidad",
    source: "DENUE",
    grain: "estado",
    type: "categorical_nominal",
    description: "Nombre de la entidad federativa (32 estados).",
    endpoints: {
      "national-treemap": "nombre",
      "locust-estado": "nom_ent",
    },
  },
  {
    id: "denue.municipio_nombre",
    label: "Municipio",
    source: "DENUE",
    grain: "muni",
    type: "categorical_nominal",
    description: "Nombre del municipio dentro de la entidad.",
    endpoints: {
      "locust-muni": "municipio",
      municipios: "municipio",
      "risk-summary": "municipio",
      "mortality-summary": "municipio",
    },
    primaryEndpoint: "locust-muni",
  },
  {
    id: "denue.scian_sector",
    label: "Sector SCIAN",
    source: "DENUE",
    grain: "nacional",
    type: "categorical_nominal",
    description: "Sector SCIAN 2-dígito (etiqueta legible).",
    endpoints: { "top-sectors": "name" },
  },

  // ----- Censo 2020 -----------------------------------------------------
  {
    id: "censo.pobtot",
    label: "Población total",
    source: "Censo",
    grain: "muni",
    type: "numeric_count",
    description: "Población total INEGI 2020.",
    endpoints: {
      "locust-muni": "poblacion",
      municipios: "poblacion",
      "risk-summary": "poblacion",
      "mortality-summary": "poblacion",
    },
    primaryEndpoint: "locust-muni",
  },
  {
    id: "censo.pobtot_ageb",
    label: "Población AGEB",
    source: "Censo",
    grain: "ageb",
    type: "numeric_count",
    description: "Población a nivel AGEB urbana 2020.",
    endpoints: {},
  },
  {
    id: "censo.pct_pea",
    label: "% PEA",
    source: "Censo",
    grain: "muni",
    type: "numeric_pct",
    description: "Población económicamente activa / pob ≥15 años.",
    endpoints: { "locust-muni": "pct_pea" },
  },
  {
    id: "censo.graproes",
    label: "Escolaridad promedio",
    source: "Censo",
    grain: "muni",
    type: "numeric_continuous",
    description: "Grado promedio de escolaridad ≥15 años.",
    endpoints: { "locust-muni": "graproes" },
  },
  {
    id: "censo.pct_sin_cobertura_salud",
    label: "% sin derechohabiencia",
    source: "Censo",
    // Re-grained from "ageb" to "muni" since locust-muni serves a
    // muni-aggregated version. AGEB version still unimplemented. Label
    // corrected per audit R3: "sin derechohabiencia" ≠ "sin cobertura"
    // (people with private insurance / Seguro Popular have cobertura
    // without derechohabiencia formal).
    grain: "muni",
    type: "numeric_pct",
    description: "psinder / pobtot (% sin afiliación a salud pública).",
    endpoints: { "locust-muni": "pct_sin_cobertura_salud" },
  },

  // ----- CONEVAL -------------------------------------------------------
  {
    id: "coneval.pobreza_pct",
    label: "% pobreza",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% en pobreza (CONEVAL 2020).",
    endpoints: {
      "locust-muni": "pobreza_pct",
      municipios: "pobreza_pct",
      "national-treemap": "pobreza_pct_promedio",
    },
    primaryEndpoint: "locust-muni",
  },
  {
    id: "coneval.pobreza_extrema_pct",
    label: "% pobreza extrema",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "% en pobreza extrema (CONEVAL 2020).",
    endpoints: { "locust-muni": "pobreza_extrema_pct" },
  },
  {
    id: "coneval.carencia_acceso_salud_pct",
    label: "% sin acceso salud",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_pct",
    description: "Carencia por acceso a servicios de salud.",
    endpoints: { "locust-muni": "carencia_acceso_salud_pct" },
  },
  {
    id: "coneval.irs_indice",
    label: "Índice rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "numeric_continuous",
    description: "IRS 2020 (continuo, mayor = más rezago).",
    endpoints: {
      "locust-muni": "irs_indice",
      municipios: "irs_indice",
    },
    primaryEndpoint: "locust-muni",
  },
  {
    id: "coneval.irs_grado",
    label: "Grado rezago social",
    source: "CONEVAL",
    grain: "muni",
    type: "categorical_ordinal",
    description: "Muy bajo / Bajo / Medio / Alto / Muy alto.",
    endpoints: {
      "locust-muni": "irs_grado",
      municipios: "irs_grado",
      "national-treemap": "modal_irs_grado",
    },
    primaryEndpoint: "locust-muni",
    ordinalOrder: IRS_GRADO_ORDER,
  },
  {
    id: "coneval.grado_rezago_ageb",
    label: "Rezago AGEB",
    source: "CONEVAL",
    grain: "ageb",
    type: "categorical_ordinal",
    description: "Grado de rezago social a nivel AGEB urbana.",
    endpoints: {},
    ordinalOrder: IRS_GRADO_ORDER,
  },

  // ----- SESNSP --------------------------------------------------------
  {
    id: "sesnsp.homicidio_doloso",
    label: "Homicidios dolosos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Casos de homicidio doloso por municipio (año actual).",
    endpoints: { "risk-summary": "homicidio_doloso" },
  },
  {
    id: "sesnsp.total_delitos",
    label: "Total delitos / año",
    source: "SESNSP",
    grain: "muni",
    type: "numeric_count",
    description: "Total de carpetas SESNSP por municipio (año actual).",
    endpoints: { "risk-summary": "total_delitos" },
  },
  {
    id: "sesnsp.ano",
    label: "Año (SESNSP)",
    source: "SESNSP",
    grain: "muni",
    type: "temporal",
    description: "Año 2015–2026 (requiere /risk-trend, no servido aún).",
    endpoints: {},
  },

  // ----- EDR mortalidad -------------------------------------------------
  {
    id: "edr.total_defunciones",
    label: "Defunciones totales",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones registradas en el municipio (EDR año actual).",
    endpoints: { "mortality-summary": "total_defunciones" },
  },
  {
    id: "edr.def_circulatorio",
    label: "Defunciones circulatorio",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por enfermedades del sistema circulatorio.",
    endpoints: { "mortality-summary": "def_circulatorio" },
  },
  {
    id: "edr.def_neoplasias",
    label: "Defunciones neoplasias",
    source: "EDR",
    grain: "muni",
    type: "numeric_count",
    description: "Defunciones por neoplasias.",
    endpoints: { "mortality-summary": "def_neoplasias" },
  },

  // ----- CLUES ---------------------------------------------------------
  {
    id: "clues.total",
    label: "CLUES total",
    source: "CLUES",
    grain: "muni",
    type: "numeric_count",
    description: "Establecimientos de salud DGIS en operación.",
    endpoints: {
      "locust-muni": "unidades_clues",
      municipios: "unidades_clues",
    },
    primaryEndpoint: "locust-muni",
  },

  // ----- SINBA --------------------------------------------------------
  {
    id: "sinba.casos_dm2_promedio",
    label: "Casos DM2 promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos diabetes tipo 2 / promedio mensual activos SUS.",
    endpoints: { "locust-muni": "sinba_dm2_promedio" },
  },
  {
    id: "sinba.casos_hta_promedio",
    label: "Casos HTA promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos hipertensión / promedio mensual activos SUS.",
    endpoints: { "locust-muni": "sinba_hta_promedio" },
  },
  {
    id: "sinba.casos_obesidad_promedio",
    label: "Casos obesidad promedio",
    source: "SINBA",
    grain: "muni",
    type: "numeric_count",
    description: "Casos obesidad / promedio mensual activos SUS.",
    endpoints: { "locust-muni": "sinba_obesidad_promedio" },
  },

  // ----- COFEPRIS ------------------------------------------------------
  {
    id: "cofepris.total_licenciadas",
    label: "Farmacias licenciadas",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias con licencia sanitaria vigente COFEPRIS.",
    endpoints: { "locust-muni": "cofepris_total_licenciadas" },
  },
  {
    id: "cofepris.con_estupefacientes",
    label: "Farmacias c/ estupefacientes",
    source: "COFEPRIS",
    grain: "muni",
    type: "numeric_count",
    description: "Farmacias autorizadas a vender estupefacientes.",
    endpoints: { "locust-muni": "cofepris_con_estupefacientes" },
  },
  {
    id: "cofepris.con_controlados_ageb",
    label: "Farmacias controladas (AGEB)",
    source: "COFEPRIS",
    grain: "ageb",
    type: "numeric_count",
    description: "Farmacias con controlados a nivel AGEB.",
    endpoints: {},
  },

  // ----- CE 2024 -------------------------------------------------------
  {
    id: "ce2024.ue",
    label: "Unidades económicas CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Unidades económicas Censo Económico 2024.",
    endpoints: { "locust-muni": "ce2024_ue" },
  },
  {
    id: "ce2024.personal_ocupado",
    label: "Personal ocupado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_count",
    description: "Personal ocupado total (Censo Económico 2024).",
    endpoints: { "locust-muni": "ce2024_personal_ocupado" },
  },
  {
    id: "ce2024.valor_agregado",
    label: "Valor agregado CE",
    source: "CE2024",
    grain: "muni",
    type: "numeric_continuous",
    description: "Valor agregado censal bruto (CE 2024).",
    endpoints: { "locust-muni": "ce2024_valor_agregado" },
  },

  // ----- ENIGH ---------------------------------------------------------
  {
    id: "enigh.ingreso_p50",
    label: "Ingreso mediano (ENIGH)",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_continuous",
    description: "Ingreso mediano estatal ponderado, ENIGH 2024.",
    endpoints: { "locust-estado": "enigh_ingreso_p50" },
  },
  {
    id: "enigh.engel_coefficient",
    label: "% gasto alimentos (Engel)",
    source: "ENIGH",
    grain: "estado",
    type: "numeric_pct",
    description: "% gasto en alimentos / gasto total (ENIGH).",
    endpoints: { "locust-estado": "enigh_pct_gasto_alimentos" },
  },

  // ----- ENOE ----------------------------------------------------------
  {
    id: "enoe.pct_informal",
    label: "% informalidad",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de informalidad laboral ENOE 2025.",
    endpoints: { "locust-estado": "enoe_tasa_informalidad" },
  },
  {
    id: "enoe.tasa_desocupacion",
    label: "Tasa desocupación",
    source: "ENOE",
    grain: "estado",
    type: "numeric_pct",
    description: "Tasa de desocupación ENOE 2025.",
    endpoints: { "locust-estado": "enoe_tasa_desocupacion" },
  },

  // ----- SICT ----------------------------------------------------------
  {
    id: "sict.tdpa_total",
    label: "TDPA total",
    source: "SICT",
    grain: "muni",
    type: "numeric_count",
    description: "Tránsito diario promedio anual (SICT).",
    endpoints: { "locust-muni": "sict_tdpa_total" },
  },

  // ----- SEDATU --------------------------------------------------------
  {
    id: "sedatu.monto_total",
    label: "Monto subsidiado SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto subsidiado total vivienda (último periodo).",
    endpoints: { "locust-muni": "sedatu_monto_total" },
  },
  {
    id: "sedatu.acciones_total",
    label: "Acciones SEDATU",
    source: "SEDATU",
    grain: "muni",
    type: "numeric_count",
    description: "Acciones de financiamiento SEDATU.",
    endpoints: { "locust-muni": "sedatu_acciones_total" },
  },

  // ----- CNBV ----------------------------------------------------------
  {
    id: "cnbv.monto_total",
    label: "Monto crédito CNBV",
    source: "CNBV",
    grain: "muni",
    type: "numeric_continuous",
    description: "Monto crédito comercial total (último periodo).",
    endpoints: { "locust-muni": "cnbv_monto_total" },
  },
  {
    id: "cnbv.pct_femenino",
    label: "% crédito femenino",
    source: "CNBV",
    grain: "muni",
    type: "numeric_pct",
    description: "% acciones a mujeres (crédito comercial CNBV).",
    endpoints: { "locust-muni": "cnbv_pct_femenino" },
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

/** Field is reachable if at least one endpoint serves it. */
export function isFieldReachable(f: FieldDef): boolean {
  return Object.keys(f.endpoints).length > 0;
}

/**
 * Resolve which endpoint to fetch given the current X (and optional Y, Z).
 *
 *   - With X alone: returns X.primaryEndpoint if set, else first key.
 *   - With X+Y: returns the first endpoint where BOTH X and Y have columns.
 *     Prefers X.primaryEndpoint if it satisfies both; otherwise picks the
 *     first intersection. This lets denue.municipio_nombre (on 3 endpoints)
 *     anchor a chart against sesnsp.homicidio_doloso (on only /risk-summary).
 *   - With X+Y+Z: same, but requires all three to share an endpoint.
 *   - Returns null if no endpoint satisfies all chosen fields.
 */
export function getActiveEndpoint(
  x: FieldDef,
  y?: FieldDef | null,
  z?: FieldDef | null,
): EndpointId | null {
  const xKeys = Object.keys(x.endpoints) as EndpointId[];
  if (xKeys.length === 0) return null;
  const candidates = xKeys.filter((ep) => {
    if (y && y.endpoints[ep] === undefined) return false;
    if (z && z.endpoints[ep] === undefined) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  if (x.primaryEndpoint && candidates.includes(x.primaryEndpoint)) {
    return x.primaryEndpoint;
  }
  return candidates[0]!;
}

/** True iff field has a column on the given endpoint. */
export function isFieldOnEndpoint(f: FieldDef, ep: EndpointId): boolean {
  return f.endpoints[ep] !== undefined;
}

/**
 * True iff `f` shares at least one endpoint with `x`. Used by the Y
 * picker so the user can pick fields that span X's multi-endpoint scope
 * — the precise endpoint is resolved once Y is chosen.
 */
export function fieldSharesAnyEndpoint(x: FieldDef, f: FieldDef): boolean {
  return Object.keys(x.endpoints).some(
    (ep) => f.endpoints[ep as EndpointId] !== undefined,
  );
}

/**
 * Chart type derivation. Locust override lets the user pick explicitly;
 * this is the auto-derive baseline.
 */
export function deriveChartType(
  x: FieldType | null,
  y: FieldType | null,
): "bar" | "scatter" | "line" | "treemap" {
  if (!x && !y) return "treemap";
  if (x === "temporal" && y && isNumeric(y)) return "line";
  // cat × cat falls to bar: Locust's row model is one numeric value per
  // X identifier, so there's no second value axis to fill a heatmap cell.
  if (x && isCategorical(x) && y && isCategorical(y)) return "bar";
  if (x && isNumeric(x) && y && isNumeric(y)) return "scatter";
  if (x && isCategorical(x) && y && isNumeric(y)) return "bar";
  if (x && isNumeric(x) && y && isCategorical(y)) return "bar";
  if (x && !y) return "bar";
  return "bar";
}
