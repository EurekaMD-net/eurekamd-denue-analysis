/**
 * CLI: Load ENIGH (Encuesta Nacional de Ingresos y Gastos de los Hogares) —
 * INEGI biennial household income/expenditure survey. Calibrator (state-level).
 *
 * v0.2.3-C of the analytical roadmap. ENIGH's sample design (n≈90k households,
 * ~3k/state) doesn't support cve_mun inference, so this loads at the
 * concentradohogar grain and aggregates to a 32-row `calibrators_enigh_state`
 * parameter table keyed by entidad. Existing analytics endpoints can
 * `LEFT JOIN ON entidad = LEFT(cve_mun, 2)` to enrich municipal rows with
 * state-level absolute income anchors (decil distributions, mean expenditure)
 * — closes the "30% pobreza in CDMX vs Chiapas mean different things" gap.
 *
 * Source: https://www.inegi.org.mx/programas/enigh/nc/2024/
 *   Direct ZIP (operator-supplied 2026-05-05):
 *   https://www.inegi.org.mx/contenidos/programas/enigh/nc/2024/datosabiertos/conjunto_de_datos_enigh2024_ns_csv.zip
 *
 * The ZIP contains 17 sub-tables; we load only `concentradohogar` (the
 * household-level rolled-up summary with all 126 derived income/expense
 * variables) since that's the canonical source for state aggregation.
 *
 * Behavior:
 *   1. Drop+create enigh_concentradohogar_raw (126 TEXT cols) idempotently.
 *   2. \copy CSV in (~91k household rows for ENIGH 2024).
 *   3. Drop+create calibrators_enigh_state (32 rows, parameter table) with
 *      weighted aggregations: factor-weighted mean income/expense, weighted
 *      decile cuts (P10/P50/P90), and per-category expense shares.
 *
 * Idempotent: rerun freely. Each new ENIGH wave (2026, 2028, ...) overwrites
 * the prior load. Multi-wave history is out of scope for v0.2.3 — the
 * calibrator is "current snapshot" by design.
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const ANIO_RE = /^(19|20)[0-9]{2}$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const nl = text.indexOf("\n");
    return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, "");
  } finally {
    closeSync(fd);
  }
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadEnigh: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

/**
 * 126 ENIGH concentradohogar columns in canonical CSV order. Source of truth:
 * `diccionario_datos_concentradohogar_enigh2024_ns.csv` inside the ZIP.
 */
export const ENIGH_CONCENTRADOHOGAR_COLUMNS = [
  "folioviv",
  "foliohog",
  "ubica_geo",
  "tam_loc",
  "est_socio",
  "est_dis",
  "upm",
  "factor",
  "clase_hog",
  "sexo_jefe",
  "edad_jefe",
  "educa_jefe",
  "tot_integ",
  "hombres",
  "mujeres",
  "mayores",
  "menores",
  "p12_64",
  "p65mas",
  "ocupados",
  "percep_ing",
  "perc_ocupa",
  "ing_cor",
  "ingtrab",
  "trabajo",
  "sueldos",
  "horas_extr",
  "comisiones",
  "aguinaldo",
  "indemtrab",
  "otra_rem",
  "remu_espec",
  "negocio",
  "noagrop",
  "industria",
  "comercio",
  "servicios",
  "agrope",
  "agricolas",
  "pecuarios",
  "reproducc",
  "pesca",
  "otros_trab",
  "rentas",
  "utilidad",
  "arrenda",
  "transfer",
  "jubilacion",
  "becas",
  "donativos",
  "remesas",
  "bene_gob",
  "transf_hog",
  "trans_inst",
  "estim_alqu",
  "otros_ing",
  "gasto_mon",
  "alimentos",
  "ali_dentro",
  "cereales",
  "carnes",
  "pescado",
  "leche",
  "huevo",
  "aceites",
  "tuberculo",
  "verduras",
  "frutas",
  "azucar",
  "cafe",
  "especias",
  "otros_alim",
  "bebidas",
  "ali_fuera",
  "tabaco",
  "vesti_calz",
  "vestido",
  "calzado",
  "vivienda",
  "alquiler",
  "pred_cons",
  "agua",
  "energia",
  "limpieza",
  "cuidados",
  "utensilios",
  "enseres",
  "salud",
  "ambul_serv",
  "aten_hosp",
  "medic_prod",
  "transporte",
  "publico",
  "foraneo",
  "adqui_vehi",
  "mantenim",
  "refaccion",
  "combus",
  "comunica",
  "educa_espa",
  "educacion",
  "esparci",
  "paq_turist",
  "personales",
  "cuida_pers",
  "acces_pers",
  "otros_gas",
  "transf_gas",
  "percep_tot",
  "retiro_inv",
  "prestamos",
  "otras_perc",
  "ero_nm_viv",
  "ero_nm_hog",
  "erogac_tot",
  "cuota_viv",
  "mater_serv",
  "material",
  "servicio",
  "deposito",
  "prest_terc",
  "pago_tarje",
  "deudas",
  "balance",
  "otras_erog",
  "smg",
] as const;

export function expectEnighHeader(headerLine: string): void {
  const cols = headerLine
    .replace(/^﻿/, "")
    .trim()
    .split(",")
    .map((c) => c.trim().toLowerCase());
  if (cols.length !== ENIGH_CONCENTRADOHOGAR_COLUMNS.length) {
    throw new Error(
      `loadEnigh: expected ${ENIGH_CONCENTRADOHOGAR_COLUMNS.length} columns, got ${cols.length}.`,
    );
  }
  for (let i = 0; i < ENIGH_CONCENTRADOHOGAR_COLUMNS.length; i++) {
    if (cols[i] !== ENIGH_CONCENTRADOHOGAR_COLUMNS[i]) {
      throw new Error(
        `loadEnigh: column ${i + 1} mismatch — expected "${ENIGH_CONCENTRADOHOGAR_COLUMNS[i]}", got "${cols[i]}".`,
      );
    }
  }
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`loadEnigh: unsafe column name "${c}"`);
    }
  }
}

const ENIGH_RAW_DDL = `
DROP TABLE IF EXISTS enigh_concentradohogar_raw CASCADE;
CREATE TABLE enigh_concentradohogar_raw (
  ${ENIGH_CONCENTRADOHOGAR_COLUMNS.map((c) => `${c} TEXT`).join(",\n  ")}
);
CREATE INDEX idx_enigh_ubica_geo ON enigh_concentradohogar_raw (LEFT(ubica_geo, 2));
`;

export const ENIGH_RAW_DDL_FOR_TEST = ENIGH_RAW_DDL;

/**
 * State calibrator parameter table. 32 rows after a successful load (one per
 * entidad). Schema chosen to satisfy the analyzer's "anchor municipal pobreza
 * to absolute state-level income" use case + provide expense-share ratios
 * usable as multipliers on CE 2024 sector aggregates.
 *
 * Composite PK on (entidad, ano_levantamiento) so future ENIGH waves can
 * stack — `calibrators_enigh_state` becomes a longitudinal calibrator
 * surface across 2024, 2026, 2028... ENOE follows the same pattern.
 */
function calibratorsDdl(year: number): string {
  return `
CREATE TABLE IF NOT EXISTS calibrators_enigh_state (
  entidad TEXT NOT NULL,
  ano_levantamiento INT NOT NULL,
  hogares_estimados BIGINT NOT NULL,
  poblacion_estimada BIGINT NOT NULL,
  ingreso_corriente_promedio NUMERIC(14, 2),
  ingreso_corriente_mediana NUMERIC(14, 2),
  decil_1_ingreso NUMERIC(14, 2),
  decil_9_ingreso NUMERIC(14, 2),
  gasto_corriente_promedio NUMERIC(14, 2),
  pct_gasto_alimentos NUMERIC(5, 2),
  pct_gasto_vivienda NUMERIC(5, 2),
  pct_gasto_salud NUMERIC(5, 2),
  pct_gasto_transporte NUMERIC(5, 2),
  pct_gasto_educacion NUMERIC(5, 2),
  cargado_en TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (entidad, ano_levantamiento)
);

-- Idempotent: re-running the loader for the same year overwrites that
-- year's slice without dropping prior years (operator-friendly when ENIGH
-- 2026 ships alongside 2024 data already loaded).
DELETE FROM calibrators_enigh_state WHERE ano_levantamiento = ${year};

INSERT INTO calibrators_enigh_state (
  entidad,
  ano_levantamiento,
  hogares_estimados,
  poblacion_estimada,
  ingreso_corriente_promedio,
  ingreso_corriente_mediana,
  decil_1_ingreso,
  decil_9_ingreso,
  gasto_corriente_promedio,
  pct_gasto_alimentos,
  pct_gasto_vivienda,
  pct_gasto_salud,
  pct_gasto_transporte,
  pct_gasto_educacion
)
WITH parsed AS (
  SELECT
    LEFT(ubica_geo, 2)              AS entidad,
    NULLIF(factor, '')::numeric     AS w,
    NULLIF(tot_integ, '')::int      AS integ,
    NULLIF(ing_cor, '')::numeric    AS ing,
    NULLIF(gasto_mon, '')::numeric  AS gasto,
    NULLIF(alimentos, '')::numeric  AS gasto_ali,
    NULLIF(vivienda, '')::numeric   AS gasto_viv,
    NULLIF(salud, '')::numeric      AS gasto_sal,
    NULLIF(transporte, '')::numeric AS gasto_tra,
    NULLIF(educacion, '')::numeric  AS gasto_edu
  FROM enigh_concentradohogar_raw
  WHERE ubica_geo ~ '^(0[1-9]|[12][0-9]|3[0-2])[0-9]{3}$'
    AND NULLIF(factor, '')::numeric > 0
),
ranked AS (
  -- Weighted percentile via cumulative factor sum. percentile_cont/disc in
  -- Postgres are unweighted; for ENIGH the factor weight ranges 4-7127 so
  -- expanding to one row per household (~20M rows nationally) is wasteful.
  SELECT
    entidad,
    ing,
    w,
    SUM(w) OVER (PARTITION BY entidad ORDER BY ing
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumw,
    SUM(w) OVER (PARTITION BY entidad)                              AS totw
  FROM parsed
  WHERE ing IS NOT NULL
)
SELECT
  parsed.entidad,
  ${year}                                                            AS ano_levantamiento,
  SUM(parsed.w)::bigint                                              AS hogares_estimados,
  SUM(parsed.w * parsed.integ)::bigint                               AS poblacion_estimada,
  ROUND(SUM(parsed.w * parsed.ing)::numeric / SUM(parsed.w)::numeric, 2)
                                                                     AS ingreso_corriente_promedio,
  -- Mediana / decil cuts via the cumulative-sum CTE. MIN(ing) FILTER pulls
  -- the first ing where the running total hits the threshold percentile.
  (SELECT MIN(ing) FROM ranked r
    WHERE r.entidad = parsed.entidad AND r.cumw >= r.totw * 0.5)     AS ingreso_corriente_mediana,
  (SELECT MIN(ing) FROM ranked r
    WHERE r.entidad = parsed.entidad AND r.cumw >= r.totw * 0.1)     AS decil_1_ingreso,
  (SELECT MIN(ing) FROM ranked r
    WHERE r.entidad = parsed.entidad AND r.cumw >= r.totw * 0.9)     AS decil_9_ingreso,
  ROUND(SUM(parsed.w * parsed.gasto)::numeric
        / NULLIF(SUM(parsed.w * (parsed.gasto IS NOT NULL)::int), 0)::numeric, 2)
                                                                     AS gasto_corriente_promedio,
  ROUND(SUM(parsed.w * parsed.gasto_ali)::numeric
        / NULLIF(SUM(parsed.w * parsed.gasto), 0)::numeric * 100, 2)
                                                                     AS pct_gasto_alimentos,
  ROUND(SUM(parsed.w * parsed.gasto_viv)::numeric
        / NULLIF(SUM(parsed.w * parsed.gasto), 0)::numeric * 100, 2)
                                                                     AS pct_gasto_vivienda,
  ROUND(SUM(parsed.w * parsed.gasto_sal)::numeric
        / NULLIF(SUM(parsed.w * parsed.gasto), 0)::numeric * 100, 2)
                                                                     AS pct_gasto_salud,
  ROUND(SUM(parsed.w * parsed.gasto_tra)::numeric
        / NULLIF(SUM(parsed.w * parsed.gasto), 0)::numeric * 100, 2)
                                                                     AS pct_gasto_transporte,
  ROUND(SUM(parsed.w * parsed.gasto_edu)::numeric
        / NULLIF(SUM(parsed.w * parsed.gasto), 0)::numeric * 100, 2)
                                                                     AS pct_gasto_educacion
FROM parsed
GROUP BY parsed.entidad
ORDER BY parsed.entidad;
`;
}

export function calibratorsDdlForTest(year: number): string {
  return calibratorsDdl(year);
}

export interface LoadEnighConfig {
  csvPath: string;
  dbContainer: string;
  /** ENIGH wave year, e.g. 2024. Used as the calibrator row's ano_levantamiento. */
  year: number;
}

export interface LoadEnighResult {
  raw_rows: number;
  calibrators_rows: number;
  duration_ms: number;
}

export async function loadEnigh(
  config: LoadEnighConfig,
): Promise<LoadEnighResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(`loadEnigh: dbContainer inválido "${config.dbContainer}".`);
  }
  assertSafePath("csvPath", config.csvPath);
  if (!Number.isInteger(config.year) || !ANIO_RE.test(String(config.year))) {
    throw new Error(`loadEnigh: year inválido "${config.year}".`);
  }

  expectEnighHeader(readFirstLine(config.csvPath));

  const started = Date.now();

  // 1. Create raw table
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      ENIGH_RAW_DDL,
    ],
    { encoding: "utf-8", timeout: 120_000 },
  );

  // 2. Copy CSV via temp container path
  const containerPath = `/tmp/enigh_raw_${Date.now()}.csv`;
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${containerPath}`],
    { encoding: "utf-8", timeout: 5 * 60_000 },
  );
  try {
    execFileSync(
      "docker",
      [
        "exec",
        config.dbContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `\\copy enigh_concentradohogar_raw FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
      ],
      { encoding: "utf-8", timeout: 10 * 60_000 },
    );
  } finally {
    try {
      execFileSync(
        "docker",
        ["exec", config.dbContainer, "rm", "-f", containerPath],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // best-effort
    }
  }

  // 3. Build calibrators table (year inlined; pre-validated by ANIO_RE)
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      calibratorsDdl(config.year),
    ],
    { encoding: "utf-8", timeout: 5 * 60_000 },
  );

  // 4. Counts
  const cnt = (sql: string): number => {
    const out = execFileSync(
      "docker",
      [
        "exec",
        config.dbContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-t",
        "-A",
        "-c",
        sql,
      ],
      { encoding: "utf-8", timeout: 60_000 },
    ).trim();
    const n = parseInt(out, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`loadEnigh: unexpected count output "${out}"`);
    }
    return n;
  };
  const raw_rows = cnt("SELECT COUNT(*) FROM enigh_concentradohogar_raw;");
  const calibrators_rows = cnt(
    `SELECT COUNT(*) FROM calibrators_enigh_state WHERE ano_levantamiento = ${config.year};`,
  );
  return { raw_rows, calibrators_rows, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const csvPath = getArg("csv");
  const yearArg = getArg("year");
  if (!csvPath || !yearArg) {
    console.error(
      "Usage: npx tsx scripts/load-enigh.ts --csv=/path/concentradohogar.csv --year=2024",
    );
    process.exit(1);
  }
  const year = parseInt(yearArg, 10);
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-enigh] loading ENIGH ${year} concentradohogar → ${dbContainer} ...`,
  );
  loadEnigh({ csvPath, dbContainer, year })
    .then((r) => {
      console.log(
        `[load-enigh] ✓ raw=${r.raw_rows.toLocaleString()} | calibrators=${r.calibrators_rows} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-enigh] ✗ ${msg}`);
      process.exit(1);
    });
}
