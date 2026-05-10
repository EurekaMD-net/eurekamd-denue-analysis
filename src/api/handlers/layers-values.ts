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
 *   entidad=NN                optional, 2-digit; when present, restricts to one estado
 *
 * Response:
 *   {
 *     "grain":   "muni",
 *     "layers":  ["pct_pobreza", "homicidios_per_1k"],
 *     "values":  { "01001": { "pct_pobreza": 25.4, "homicidios_per_1k": 0.12 }, … }
 *   }
 *
 * Cache: 5 minutes (layers are slow-changing, mat-view-backed).
 *
 * Layer dispatch is fully internal — the layer id maps to a known SQL
 * expression over an allowlisted view. No user input ever lands in SQL
 * other than via the layer-id whitelist + entidad regex check.
 */

import type { Context } from "hono";
import { execFileSync } from "node:child_process";
import { HttpError } from "../middleware/error.js";
import { assertSafeContainer } from "./_safe-container.js";
import type { ApiServerConfig } from "../types.js";
import { ENTIDAD_RE } from "../types.js";

export type LayerGrain = "muni" | "ageb";

interface LayerDef {
  grain: LayerGrain;
  // SQL expression that yields a single numeric value per polygon key.
  // The full query is: SELECT <key>, <expr> AS v FROM <from> WHERE …
  key_col: string;
  from: string;
  value_expr: string;
  // Optional filter; combined with ENTIDAD when present.
  extra_where?: string;
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
  // EDR mortalidad: only 2024 is fully loaded today; AVG-across-years
  // would mix near-zero pre-2024 rows. Restrict to 2024 (the resolved
  // currentMortalityAno) which is the most-reported registration year.
  defunciones_total: {
    grain: "muni",
    key_col: "cve_mun",
    from: "mv_mortalidad_municipal_yearly",
    value_expr: "total_defunciones",
    extra_where: "ano = 2024",
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
  return { grain: grainRaw, layers, entidad };
}

function buildLayerSql(
  layerId: string,
  _grain: LayerGrain,
  entidad: string | undefined,
): string {
  const def = MAP_LAYER_REGISTRY[layerId];
  if (!def) throw new Error(`internal: layer ${layerId} disappeared`);
  const keyCol = def.key_col;
  const where: string[] = [];
  if (entidad) {
    // entidad has already been validated by ENTIDAD_RE in parseQuery
    // (2-digit numeric only). Still parameterize via psql -v
    // substitution at the handler level so this code is robust to
    // future contributors weakening the regex (R1 C2-sec).
    where.push(`${estadoPrefixExpr(keyCol)} = :'entidad'`);
  }
  if (def.extra_where) {
    // extra_where can include GROUP BY/ano filter. The string is from
    // the curated registry — never user input.
    const whereClause =
      where.length > 0 ? `WHERE ${where.join(" AND ")} AND ` : "WHERE ";
    return `
SELECT ${keyCol} AS k, (${def.value_expr})::float AS v
FROM ${def.from}
${whereClause}${def.extra_where}
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
      ? `keys AS (SELECT DISTINCT cve_mun AS k FROM censo_municipios WHERE LEFT(cve_mun, 2) = :'entidad')`
      : `keys AS (SELECT DISTINCT cve_mun AS k FROM censo_municipios)`;
  }
  // AGEB: use ageb_polygons as the canonical universe (81k urban AGEBs).
  return entidad
    ? `keys AS (SELECT DISTINCT cvegeo AS k FROM ageb_polygons WHERE LEFT(cvegeo, 2) = :'entidad')`
    : `keys AS (SELECT DISTINCT cvegeo AS k FROM ageb_polygons)`;
}

function buildCombinedSql(query: LayerValuesQuery): string {
  // CTEs: base universe + each requested layer.
  const baseCte = baseCteForGrain(query.grain, query.entidad);
  const layerCtes = query.layers
    .map(
      (id, i) => `l${i} AS (${buildLayerSql(id, query.grain, query.entidad)})`,
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

// 25s PG statement_timeout below + 5s docker exec/libpq startup headroom
// = 30s wall-clock (matches analytics.ts discipline: DB-side abort fires
// first, surfaces a structured PG error; without the gap SIGTERM races
// stmt_timeout). Closure audit W6-perf.
const EXEC_OPTS = {
  encoding: "utf-8" as const,
  timeout: 30_000,
  maxBuffer: 64 * 1024 * 1024,
};

export interface LayerValuesResult {
  grain: LayerGrain;
  layers: string[];
  values: Record<string, Record<string, number | null>>;
}

export function layersValuesHandler(
  c: Context,
  config: ApiServerConfig,
): Response {
  const query = parseQuery(c);
  assertSafeContainer(config.dbContainer);

  const sql = buildCombinedSql(query);

  let stdout: string;
  try {
    // Pass entidad as a psql variable (`-v entidad=NN`) so the SQL
    // never has user input interpolated even though ENTIDAD_RE is the
    // first defense. The :'entidad' substitution in buildLayerSql /
    // baseCteForGrain references this var.
    const psqlArgs = [
      "exec",
      "-e",
      "PGOPTIONS=-c statement_timeout=25000",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
    ];
    if (query.entidad) {
      psqlArgs.push("-v", `entidad=${query.entidad}`);
    }
    psqlArgs.push("-c", sql);
    stdout = execFileSync("docker", psqlArgs, EXEC_OPTS).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    const msg = e.stderr?.toString("utf-8") ?? e.message ?? "query failed";
    throw new HttpError(
      `layers-values query failed: ${msg.slice(0, 240)}`,
      502,
      "postgres.error",
    );
  }

  let values: Record<string, Record<string, number | null>> = {};
  try {
    values = stdout
      ? (JSON.parse(stdout) as Record<string, Record<string, number | null>>)
      : {};
  } catch {
    throw new HttpError(
      "layers-values: malformed JSON from psql.",
      502,
      "postgres.parse_error",
    );
  }

  const result: LayerValuesResult = {
    grain: query.grain,
    layers: query.layers,
    values,
  };

  c.header("Cache-Control", "public, max-age=300");
  return c.json(result);
}
