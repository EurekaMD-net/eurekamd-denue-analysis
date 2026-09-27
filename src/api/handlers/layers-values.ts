/**
 * GET /analytics/layers/values — Mapview client-side join feed.
 *
 * Returns layer values keyed by polygon ID so the frontend can color
 * DENUE points by their containing polygon's bivariate/trivariate scale
 * with zero network round-trips between layer swaps.
 *
 * Query params:
 *   grain=muni|ageb           required
 *   layers=A,B,C              required (1..3, comma-separated layer ids)
 *   entidad=NN                2-digit; restricts to one estado. Optional for
 *                             grain=muni, REQUIRED for grain=ageb (audit #25)
 *
 * Response:
 *   {
 *     "grain":   "muni",
 *     "layers":  ["pct_pobreza", "homicidios_per_1k"],
 *     "values":  { "01001": { "pct_pobreza": 25.4, "homicidios_per_1k": 0.12 }, … }
 *   }
 *
 * Cache: 5 minutes (layers are slow-changing, mat-view-backed) — both the
 * Cache-Control header and an in-process memo keyed by (grain, sorted
 * layer ids, entidad) so repeat requests skip psql entirely (audit #102).
 *
 * Layer dispatch is fully internal — the layer id maps to a known SQL
 * expression over an allowlisted view. No user input ever lands in SQL
 * other than via the layer-id whitelist + entidad regex check.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import { assertSafeContainer } from "./_safe-container.js";
import { runSql } from "../db/psql-runner.js";
import type { ApiServerConfig } from "../types.js";
import { ENTIDAD_RE, MORTALITY_DEFAULT_CURRENT_ANO } from "../types.js";

export type LayerGrain = "muni" | "ageb";

interface LayerDef {
  grain: LayerGrain;
  // SQL expression that yields a single numeric value per polygon key.
  // The full query is: SELECT <key>, <expr> AS v FROM <from> WHERE …
  key_col: string;
  from: string;
  value_expr: string;
  // Optional filter; combined with ENTIDAD when present. A function when
  // the filter depends on boot-resolved config (audit #45).
  extra_where?: string | ((config: ApiServerConfig) => string);
}

// IMPORTANT: every entry is hand-curated. Add new layers here, not from
// user input. The Mapview frontend reads MAP_LAYER_REGISTRY (mirrored
// in web/src/lib/layers.ts) so adding here = adding there.
export const MAP_LAYER_REGISTRY: Record<string, LayerDef> = {
  // ----- muni-grain ------------------------------------------------------
  pobreza_pct: {
    grain: "muni",
    key_col: "cve_mun",
    from: "coneval_pobreza_municipal",
    value_expr: "pobreza_pct",
  },
  pobreza_extrema_pct: {
    grain: "muni",
    key_col: "cve_mun",
    from: "coneval_pobreza_municipal",
    value_expr: "pobreza_extrema_pct",
  },
  carencia_acceso_salud_pct: {
    grain: "muni",
    key_col: "cve_mun",
    from: "coneval_pobreza_municipal",
    value_expr: "carencia_acceso_salud_pct",
  },
  irs_indice: {
    grain: "muni",
    key_col: "cve_mun",
    from: "coneval_irs_municipal",
    value_expr: "irs_indice",
  },
  // SESNSP delitos: filter `XX998/XX999` catch-all rows (publisher-side
  // rolled-up buckets that appear with non-null delito counts but null
  // censo joins). Also drop partial current year so the AVG isn't skewed
  // downward by an incomplete reporting window (closure audit C1, W1).
  homicidio_doloso_year: {
    grain: "muni",
    key_col: "cve_mun",
    from: "mv_delitos_municipal_yearly",
    value_expr: "AVG(homicidio_doloso)",
    extra_where:
      "ano IS NOT NULL AND ano < EXTRACT(YEAR FROM CURRENT_DATE)::int AND cve_mun NOT LIKE '%999' AND cve_mun NOT LIKE '%998' GROUP BY cve_mun",
  },
  total_delitos_year: {
    grain: "muni",
    key_col: "cve_mun",
    from: "mv_delitos_municipal_yearly",
    value_expr: "AVG(total_delitos)",
    extra_where:
      "ano IS NOT NULL AND ano < EXTRACT(YEAR FROM CURRENT_DATE)::int AND cve_mun NOT LIKE '%999' AND cve_mun NOT LIKE '%998' GROUP BY cve_mun",
  },
  // EDR mortalidad: AVG-across-years would mix near-zero older rows.
  // Restrict to the boot-resolved currentMortalityAno (same year the
  // analytics endpoints use) so the Map layer and analytics agree when a
  // newer year is loaded (audit #45).
  defunciones_total: {
    grain: "muni",
    key_col: "cve_mun",
    from: "mv_mortalidad_municipal_yearly",
    value_expr: "total_defunciones",
    extra_where: (config) => `ano = ${mortalityAno(config)}`,
  },
  farmacias_licenciadas: {
    grain: "muni",
    key_col: "cve_mun",
    from: "cofepris_farmacias_by_municipio",
    value_expr: "total_licenciadas",
  },
  // Sum of "con_*" flags counts ENDORSEMENTS (not distinct pharmacies);
  // a single pharmacy holding multiple controlled-substance licenses
  // contributes to each addend. Renamed for honesty (R1 W6-coh).
  farmacias_endorsements_controlados: {
    grain: "muni",
    key_col: "cve_mun",
    from: "cofepris_farmacias_by_municipio",
    value_expr:
      "(con_estupefacientes + con_psicotropicos + con_vacunas + con_hemoderivados)",
  },
  dm2_casos_promedio: {
    grain: "muni",
    key_col: "cve_mun",
    from: "sinba_morbidity_municipal",
    value_expr: "casos_dm2_promedio",
  },
  monto_credito_comercial: {
    grain: "muni",
    key_col: "cve_mun",
    from: "cnbv_credito_by_municipio",
    value_expr: "monto_total",
  },
  pct_femenino_credito: {
    grain: "muni",
    key_col: "cve_mun",
    from: "cnbv_credito_by_municipio",
    value_expr: "pct_femenino",
  },
  monto_subsidiado_vivienda: {
    grain: "muni",
    key_col: "cve_mun",
    from: "sedatu_financing_by_municipio",
    value_expr: "monto_total",
  },
  acciones_vivienda_total: {
    grain: "muni",
    key_col: "cve_mun",
    from: "sedatu_financing_by_municipio",
    value_expr: "acciones_total",
  },
  tdpa_total: {
    grain: "muni",
    key_col: "cve_mun",
    from: "sict_traffic_by_municipio",
    value_expr: "tdpa_total",
  },
  pobtot_muni: {
    grain: "muni",
    key_col: "cve_mun",
    from: "censo_municipios",
    value_expr: "pobtot",
  },

  // ----- AGEB-grain ------------------------------------------------------
  pobtot_ageb: {
    grain: "ageb",
    key_col: "cvegeo",
    from: "censo_ageb",
    value_expr: "pobtot",
  },
  pct_sin_cobertura_salud: {
    grain: "ageb",
    key_col: "cvegeo",
    from: "censo_ageb",
    value_expr: "CASE WHEN pobtot > 0 THEN (psinder::float / pobtot) * 100 END",
  },
  grado_rezago_ageb_ordinal: {
    grain: "ageb",
    key_col: "cvegeo",
    from: "coneval_grs_ageb",
    value_expr:
      "CASE grado WHEN 'Muy bajo' THEN 1 WHEN 'Bajo' THEN 2 WHEN 'Medio' THEN 3 WHEN 'Alto' THEN 4 WHEN 'Muy alto' THEN 5 END",
  },
  farmacias_licenciadas_ageb: {
    grain: "ageb",
    key_col: "cvegeo_ageb",
    from: "cofepris_farmacias_by_ageb",
    value_expr: "total_licenciadas",
  },
};

/** Resolved mortality year, validated as an integer before it reaches SQL. */
function mortalityAno(config: ApiServerConfig): number {
  const ano = config.currentMortalityAno ?? MORTALITY_DEFAULT_CURRENT_ANO;
  if (!Number.isInteger(ano)) {
    throw new HttpError("invalid currentMortalityAno", 500, "config.bad_ano");
  }
  return ano;
}

export const SAFE_LAYER_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
// Estado prefix derived per-layer because key_col can be either
// `cvegeo` or `cvegeo_ageb` (cofepris). Both start with the 2-char
// estado prefix, but the column name varies.
function estadoPrefixExpr(keyCol: string): string {
  return `LEFT(${keyCol}, 2)`;
}

interface LayerValuesQuery {
  grain: LayerGrain;
  layers: string[];
  entidad?: string;
}

function parseQuery(c: Context): LayerValuesQuery {
  const grainRaw = c.req.query("grain") ?? "";
  if (grainRaw !== "muni" && grainRaw !== "ageb") {
    throw new HttpError(
      "grain must be 'muni' or 'ageb'.",
      400,
      "param.bad_grain",
    );
  }
  const layersRaw = c.req.query("layers") ?? "";
  const layers = layersRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (layers.length < 1 || layers.length > 3) {
    throw new HttpError(
      "layers must have 1..3 comma-separated entries.",
      400,
      "param.layers_count",
    );
  }
  for (const id of layers) {
    if (!SAFE_LAYER_ID_RE.test(id)) {
      throw new HttpError(
        `layer id "${id}" is not a safe identifier.`,
        400,
        "param.bad_layer_id",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(MAP_LAYER_REGISTRY, id)) {
      throw new HttpError(
        `layer "${id}" is not registered.`,
        400,
        "param.unknown_layer",
      );
    }
    if (MAP_LAYER_REGISTRY[id]?.grain !== grainRaw) {
      throw new HttpError(
        `layer "${id}" is not available at grain "${grainRaw}".`,
        400,
        "param.layer_grain_mismatch",
      );
    }
  }
  const entidad = c.req.query("entidad");
  if (entidad !== undefined && !ENTIDAD_RE.test(entidad)) {
    throw new HttpError("entidad inválida.", 400, "param.bad_entidad");
  }
  // Audit #25: a national AGEB request is ~81k keys / multi-MB; bound it.
  if (grainRaw === "ageb" && entidad === undefined) {
    throw new HttpError(
      "entidad is required for grain=ageb.",
      400,
      "param.entidad_required_for_ageb",
    );
  }
  return { grain: grainRaw, layers, entidad };
}

function buildLayerSql(
  layerId: string,
  _grain: LayerGrain,
  entidad: string | undefined,
  config: ApiServerConfig,
): string {
  const def = MAP_LAYER_REGISTRY[layerId];
  if (!def) throw new Error(`internal: layer ${layerId} disappeared`);
  const keyCol = def.key_col;
  const where: string[] = [];
  if (entidad) {
    // entidad has already been validated by ENTIDAD_RE in parseQuery
    // (2-digit numeric only), so the literal is inlined — the same
    // convention as analytics.ts. Audit #22/#33: psql never expands
    // :'var' inside -c, so the old `-v entidad=` path was a syntax error.
    where.push(`${estadoPrefixExpr(keyCol)} = '${entidad}'`);
  }
  if (def.extra_where) {
    // extra_where can include GROUP BY/ano filter. The string is from
    // the curated registry — never user input.
    const extraWhere =
      typeof def.extra_where === "function"
        ? def.extra_where(config)
        : def.extra_where;
    const whereClause =
      where.length > 0 ? `WHERE ${where.join(" AND ")} AND ` : "WHERE ";
    return `
SELECT ${keyCol} AS k, (${def.value_expr})::float AS v
FROM ${def.from}
${whereClause}${extraWhere}
`;
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return `
SELECT ${keyCol} AS k, (${def.value_expr})::float AS v
FROM ${def.from}
${whereClause}
`;
}

// Base CTE that anchors the LEFT JOIN. Without this, sparse first
// layers (e.g. cofepris_farmacias_by_municipio only covers munis with
// licensed pharmacies) would drop munis that have values in subsequent
// layers but not the first (R1 W7-perf).
function baseCteForGrain(
  grain: LayerGrain,
  entidad: string | undefined,
): string {
  if (grain === "muni") {
    return entidad
      ? `keys AS (SELECT DISTINCT cve_mun AS k FROM censo_municipios WHERE LEFT(cve_mun, 2) = '${entidad}')`
      : `keys AS (SELECT DISTINCT cve_mun AS k FROM censo_municipios)`;
  }
  // AGEB: use ageb_polygons as the canonical universe. parseQuery requires
  // entidad for this grain (audit #25). Audit #102: filter on cve_ent and
  // read only cvegeo instead of DISTINCT over the whole 229 MB table.
  return `keys AS (SELECT cvegeo AS k FROM ageb_polygons WHERE cve_ent = '${entidad}')`;
}

function buildCombinedSql(
  query: LayerValuesQuery,
  config: ApiServerConfig,
): string {
  // CTEs: base universe + each requested layer.
  const baseCte = baseCteForGrain(query.grain, query.entidad);
  const layerCtes = query.layers
    .map(
      (id, i) =>
        `l${i} AS (${buildLayerSql(id, query.grain, query.entidad, config)})`,
    )
    .join(",\n");
  const ctes = `${baseCte},\n${layerCtes}`;

  // LEFT JOIN every layer onto the base key set so munis with values in
  // some-but-not-all layers still appear in the output.
  const joinChain = query.layers
    .map((_, i) => `LEFT JOIN l${i} ON l${i}.k = keys.k`)
    .join("\n");

  const fields = query.layers.map((id, i) => `'${id}', l${i}.v`).join(", ");

  return `
WITH ${ctes}
SELECT COALESCE(
  json_object_agg(keys.k, json_build_object(${fields})) FILTER (
    WHERE ${query.layers.map((_, i) => `l${i}.v IS NOT NULL`).join(" OR ")}
  ),
  '{}'::json
)::text AS payload
FROM keys
${joinChain}
WHERE keys.k IS NOT NULL;
`;
}

export interface LayerValuesResult {
  grain: LayerGrain;
  layers: string[];
  values: Record<string, Record<string, number | null>>;
}

// Audit #102: in-process memo of the `values` JSON text, keyed by
// (grain, sorted layer ids, entidad). 5-min TTL matches Cache-Control;
// capped so a key sweep cannot grow memory without bound.
const MEMO_TTL_MS = 5 * 60 * 1000;
const MEMO_MAX_ENTRIES = 50;
const memo = new Map<string, { at: number; values: string }>();

/** Reset the memo. For tests only. */
export function _resetLayerValuesMemo(): void {
  memo.clear();
}

export async function layersValuesHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const query = parseQuery(c);
  assertSafeContainer(config.dbContainer);

  const sortedLayers = [...query.layers].sort().join(",");
  const memoKey = `${query.grain}|${sortedLayers}|${query.entidad ?? ""}`;
  const hit = memo.get(memoKey);
  let values: string;
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) {
    values = hit.values;
  } else {
    // Audit #22/#24/#102: shared async runner (SQL on stdin, generic 502
    // postgres.error without psql text, statement_timeout via -e).
    const stdout = await runSql(buildCombinedSql(query, config), {
      container: config.dbContainer,
    });
    values = stdout.trim() || "{}";
    memo.delete(memoKey);
    if (memo.size >= MEMO_MAX_ENTRIES) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(memoKey, { at: Date.now(), values });
  }

  // Audit #102: Postgres already produced the `values` JSON text; wrap it
  // as-is instead of JSON.parse followed by a c.json re-stringify.
  const body =
    `{"grain":${JSON.stringify(query.grain)},` +
    `"layers":${JSON.stringify(query.layers)},` +
    `"values":${values}}`;
  c.header("Cache-Control", "private, max-age=300");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.body(body, 200, { "content-type": "application/json" });
}
