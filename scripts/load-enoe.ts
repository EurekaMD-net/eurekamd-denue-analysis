/**
 * CLI: Load ENOE (Encuesta Nacional de Ocupación y Empleo) — INEGI quarterly
 * labor force survey. Calibrator (state-level).
 *
 * v0.2.3-C-2 of the analytical roadmap. ENOE's sample design (n≈420k
 * per quarter, representative at 32 entidades + 39 ciudades autorrepresentadas)
 * doesn't support cve_mun inference, so this loads the `sdem`
 * (sociodemográfico) table at the per-record grain and aggregates to
 * `calibrators_enoe_state` keyed by entidad. ENOE state-level informalidad
 * multiplies CE 2024 establishment counts (more informal = more sub-reported
 * real economic activity); desocupación contextualizes the Censo 2020
 * `pea / pocupada` columns at the municipal level.
 *
 * Source: https://www.inegi.org.mx/programas/enoe/15ymas/
 *   Direct ZIPs (operator-supplied 2026-05-05): 4 quarter ZIPs for 2025
 *   /contenidos/programas/enoe/15ymas/datosabiertos/2025/conjunto_de_datos_enoe_2025_{1,2,3,4}t_csv.zip
 *
 * The ZIP contains 5 sub-tables; we load only `sdem` (sociodemográfico).
 *
 * Schema gotcha (2025): INEGI renamed columns mid-year. Q1+Q2 use
 * `ent`/`mun`/`loc`/`ageb`; Q3+Q4 use `cve_ent`/`cve_mun`/`cve_loc`/`cve_ageb`
 * + add a `cvegeo` 115th column. Calibration-relevant column INDICES are
 * identical across all 4 quarters (positions 11/25/53/55/56/97/107), so the
 * loader sidesteps the rename by extracting 7 columns by position via
 * `awk -F,` rather than relying on header names.
 *
 * Behavior:
 *   1. Drop+create enoe_sdem_raw idempotently (7 typed cols + trimestre tag).
 *   2. For each quarter ZIP, awk-project the 7 columns + tag trimestre, \copy.
 *   3. Aggregate to calibrators_enoe_state keyed by (entidad,
 *      ano_levantamiento), idempotent via DELETE-then-INSERT.
 *   4. Variables computed per entidad averaged across the 4 quarters:
 *      - tasa_desocupacion = desocupada/PEA*100
 *      - tasa_participacion = PEA/pob_15mas*100
 *      - tasa_informalidad = informal/ocupada*100
 *      - ingreso_promedio_mensual = factor-weighted mean of ingocup
 */

import { execFileSync } from "node:child_process";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const ANIO_RE = /^(19|20)[0-9]{2}$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function getMultiArg(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv
    .filter((a) => a.startsWith(prefix))
    .map((a) => a.slice(prefix.length));
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadEnoe: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

/**
 * Column indices in the ENOE `sdem` CSV. Stable across the 2025 schema
 * rename (Q1+Q2 named `ent` / Q3+Q4 named `cve_ent` — same position).
 */
export const ENOE_SDEM_COL_INDEX = {
  ent: 11,
  eda: 25,
  fac_tri: 53,
  clase1: 55,
  clase2: 56,
  ingocup: 97,
  emp_ppal: 107,
} as const;

const ENOE_RAW_DDL = `
DROP TABLE IF EXISTS enoe_sdem_raw CASCADE;
CREATE TABLE enoe_sdem_raw (
  trimestre INT NOT NULL,
  ent TEXT,
  fac_tri TEXT,
  clase1 TEXT,
  clase2 TEXT,
  eda TEXT,
  ingocup TEXT,
  emp_ppal TEXT
);
CREATE INDEX idx_enoe_sdem_ent ON enoe_sdem_raw (ent);
CREATE INDEX idx_enoe_sdem_trim ON enoe_sdem_raw (trimestre);
`;

export const ENOE_RAW_DDL_FOR_TEST = ENOE_RAW_DDL;

/**
 * State calibrator parameter table. 32 rows after a successful 4-quarter
 * load (one per entidad, year-averaged).
 */
function calibratorsDdl(year: number): string {
  return `
CREATE TABLE IF NOT EXISTS calibrators_enoe_state (
  entidad TEXT NOT NULL,
  ano_levantamiento INT NOT NULL,
  poblacion_15_mas BIGINT NOT NULL,
  pea BIGINT NOT NULL,
  ocupada BIGINT NOT NULL,
  desocupada BIGINT NOT NULL,
  informal BIGINT NOT NULL,
  tasa_participacion NUMERIC(5, 2),
  tasa_desocupacion NUMERIC(5, 2),
  tasa_informalidad NUMERIC(5, 2),
  ingreso_promedio_mensual NUMERIC(14, 2),
  trimestres_cargados INT NOT NULL,
  cargado_en TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (entidad, ano_levantamiento)
);

DELETE FROM calibrators_enoe_state WHERE ano_levantamiento = ${year};

INSERT INTO calibrators_enoe_state (
  entidad,
  ano_levantamiento,
  poblacion_15_mas,
  pea,
  ocupada,
  desocupada,
  informal,
  tasa_participacion,
  tasa_desocupacion,
  tasa_informalidad,
  ingreso_promedio_mensual,
  trimestres_cargados
)
WITH parsed AS (
  -- INEGI uses single-space ' ' as a "no aplica" sentinel for unasked
  -- numeric columns (eda, ingocup) alongside empty string. TRIM-then-
  -- NULLIF normalizes both to NULL so the casts don't fail.
  SELECT
    LPAD(TRIM(ent), 2, '0')                AS entidad,
    NULLIF(TRIM(fac_tri), '')::numeric     AS w,
    NULLIF(TRIM(eda), '')::int             AS edad,
    TRIM(clase1)                           AS clase1,
    TRIM(clase2)                           AS clase2,
    TRIM(emp_ppal)                         AS emp_ppal,
    NULLIF(TRIM(ingocup), '')::numeric     AS ingreso,
    trimestre
  FROM enoe_sdem_raw
  WHERE LPAD(TRIM(ent), 2, '0') ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
    AND NULLIF(TRIM(fac_tri), '')::numeric > 0
)
-- ENOE labor force universe is the population 15+ years.
-- clase1: 1=PEA, 2=PNEA, 0=under 15 (filtered out implicitly via eda>=15).
-- clase2: 1=Ocupada, 2=Desocupada, 3=Disponible (PNEA), 4=No disponible (PNEA).
-- emp_ppal: 1=Informal, 2=Formal, 0=N/A (not occupied).
-- Each row contributes its quarterly factor weight; we sum across all
-- 4 quarters and divide by the count of trimestres present so the rates
-- are year-averaged per the standard INEGI quarterly→annual aggregation.
SELECT
  entidad,
  ${year}                                                            AS ano_levantamiento,
  -- Absolute counts are summed across N quarters then divided by N so the
  -- result is "per-quarter average" matching INEGI's published methodology.
  -- Without this, a 4-quarter load multiplies counts by 4 — the rates below
  -- still come out right (numerator/denominator cancel) but absolute totals
  -- would be 4× actual population.
  ((SUM(w) FILTER (WHERE edad >= 15)) / NULLIF(COUNT(DISTINCT trimestre), 0))::bigint
                                                                     AS poblacion_15_mas,
  ((SUM(w) FILTER (WHERE clase1 = '1')) / NULLIF(COUNT(DISTINCT trimestre), 0))::bigint
                                                                     AS pea,
  ((SUM(w) FILTER (WHERE clase2 = '1')) / NULLIF(COUNT(DISTINCT trimestre), 0))::bigint
                                                                     AS ocupada,
  ((SUM(w) FILTER (WHERE clase2 = '2')) / NULLIF(COUNT(DISTINCT trimestre), 0))::bigint
                                                                     AS desocupada,
  ((SUM(w) FILTER (WHERE emp_ppal = '1')) / NULLIF(COUNT(DISTINCT trimestre), 0))::bigint
                                                                     AS informal,
  ROUND(
    SUM(w) FILTER (WHERE clase1 = '1')::numeric * 100
    / NULLIF(SUM(w) FILTER (WHERE edad >= 15), 0)::numeric,
    2
  )                                                                  AS tasa_participacion,
  ROUND(
    SUM(w) FILTER (WHERE clase2 = '2')::numeric * 100
    / NULLIF(SUM(w) FILTER (WHERE clase1 = '1'), 0)::numeric,
    2
  )                                                                  AS tasa_desocupacion,
  ROUND(
    SUM(w) FILTER (WHERE emp_ppal = '1')::numeric * 100
    / NULLIF(SUM(w) FILTER (WHERE clase2 = '1'), 0)::numeric,
    2
  )                                                                  AS tasa_informalidad,
  ROUND(
    SUM(w * ingreso) FILTER (WHERE clase2 = '1' AND ingreso > 0)::numeric
    / NULLIF(SUM(w) FILTER (WHERE clase2 = '1' AND ingreso > 0), 0)::numeric,
    2
  )                                                                  AS ingreso_promedio_mensual,
  COUNT(DISTINCT trimestre)::int                                     AS trimestres_cargados
FROM parsed
GROUP BY entidad
ORDER BY entidad;
`;
}

export function calibratorsDdlForTest(year: number): string {
  return calibratorsDdl(year);
}

export interface LoadEnoeQuarter {
  /** 1, 2, 3, or 4 */
  trimestre: number;
  /** absolute path to the sdem CSV for this quarter */
  csvPath: string;
}

export interface LoadEnoeConfig {
  quarters: LoadEnoeQuarter[];
  dbContainer: string;
  /** ENOE wave year — used as ano_levantamiento and validates filenames. */
  year: number;
}

export interface LoadEnoeResult {
  raw_rows: number;
  trimestres_cargados: number[];
  calibrators_rows: number;
  duration_ms: number;
}

/**
 * Per-quarter shell pipeline that projects the 7 calibration columns from
 * the full sdem CSV. Output: `trimestre,ent,fac_tri,clase1,clase2,eda,ingocup,emp_ppal`
 * (header included). Runs entirely in the docker container via stdin so we
 * never copy the full 100MB+ source CSV into PG storage.
 *
 * awk arithmetic indexes match the column-order assertion above. Header
 * line emitted by the BEGIN block; data lines start at NR>1.
 */
function projectionAwkScript(trimestre: number): string {
  const idx = ENOE_SDEM_COL_INDEX;
  return `BEGIN { FS=","; OFS=","; print "trimestre,ent,fac_tri,clase1,clase2,eda,ingocup,emp_ppal" }
NR>1 { print ${trimestre}, $${idx.ent}, $${idx.fac_tri}, $${idx.clase1}, $${idx.clase2}, $${idx.eda}, $${idx.ingocup}, $${idx.emp_ppal} }`;
}

export async function loadEnoe(
  config: LoadEnoeConfig,
): Promise<LoadEnoeResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(`loadEnoe: dbContainer inválido "${config.dbContainer}".`);
  }
  if (!Number.isInteger(config.year) || !ANIO_RE.test(String(config.year))) {
    throw new Error(`loadEnoe: year inválido "${config.year}".`);
  }
  if (config.quarters.length === 0) {
    throw new Error("loadEnoe: at least one quarter required");
  }
  for (const q of config.quarters) {
    if (![1, 2, 3, 4].includes(q.trimestre)) {
      throw new Error(`loadEnoe: trimestre inválido "${q.trimestre}".`);
    }
    assertSafePath(`csvPath[Q${q.trimestre}]`, q.csvPath);
  }

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
      ENOE_RAW_DDL,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 2. For each quarter: awk-project + COPY
  const trimestresCargados: number[] = [];
  for (const q of config.quarters) {
    const containerSrc = `/tmp/enoe_sdem_${q.trimestre}_src_${Date.now()}.csv`;
    const containerProj = `/tmp/enoe_sdem_${q.trimestre}_proj_${Date.now()}.csv`;

    // Push full source CSV into container
    execFileSync(
      "docker",
      ["cp", "--", q.csvPath, `${config.dbContainer}:${containerSrc}`],
      { encoding: "utf-8", timeout: 10 * 60_000 },
    );

    try {
      // Project to 7-column form via awk
      execFileSync(
        "docker",
        [
          "exec",
          config.dbContainer,
          "sh",
          "-c",
          `awk '${projectionAwkScript(q.trimestre)}' ${containerSrc} > ${containerProj}`,
        ],
        { encoding: "utf-8", timeout: 5 * 60_000 },
      );

      // \copy projected CSV
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
          `\\copy enoe_sdem_raw (trimestre, ent, fac_tri, clase1, clase2, eda, ingocup, emp_ppal) FROM '${containerProj}' WITH (FORMAT csv, HEADER true)`,
        ],
        { encoding: "utf-8", timeout: 10 * 60_000 },
      );

      trimestresCargados.push(q.trimestre);
    } finally {
      try {
        execFileSync(
          "docker",
          ["exec", config.dbContainer, "rm", "-f", containerSrc, containerProj],
          { encoding: "utf-8", timeout: 30_000 },
        );
      } catch {
        // best-effort
      }
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
      throw new Error(`loadEnoe: unexpected count output "${out}"`);
    }
    return n;
  };
  const raw_rows = cnt("SELECT COUNT(*) FROM enoe_sdem_raw;");
  const calibrators_rows = cnt(
    `SELECT COUNT(*) FROM calibrators_enoe_state WHERE ano_levantamiento = ${config.year};`,
  );
  return {
    raw_rows,
    trimestres_cargados: trimestresCargados,
    calibrators_rows,
    duration_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const yearArg = getArg("year");
  const csvArgs = getMultiArg("csv");
  if (!yearArg || csvArgs.length === 0) {
    console.error(
      "Usage: npx tsx scripts/load-enoe.ts --year=2025 --csv=Q:/path/sdem.csv [--csv=Q:/path/sdem.csv ...]\n" +
        "  Each --csv must be prefixed with the quarter (1/2/3/4) followed by ':'.\n" +
        "  Example: --csv=1:/data/enoe/sdem_1t.csv --csv=2:/data/enoe/sdem_2t.csv",
    );
    process.exit(1);
  }
  const year = parseInt(yearArg, 10);
  const quarters: LoadEnoeQuarter[] = csvArgs.map((a) => {
    const m = a.match(/^([1-4]):(.+)$/);
    if (!m || !m[1] || !m[2]) {
      throw new Error(
        `loadEnoe: bad --csv arg "${a}" — expected "<Q>:<path>".`,
      );
    }
    return { trimestre: parseInt(m[1], 10), csvPath: m[2] };
  });
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-enoe] loading ENOE ${year} sdem (${quarters.length} trimestres) → ${dbContainer} ...`,
  );
  loadEnoe({ quarters, dbContainer, year })
    .then((r) => {
      console.log(
        `[load-enoe] ✓ raw=${r.raw_rows.toLocaleString()} | trimestres=${r.trimestres_cargados.join(",")} | calibrators=${r.calibrators_rows} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-enoe] ✗ ${msg}`);
      process.exit(1);
    });
}
