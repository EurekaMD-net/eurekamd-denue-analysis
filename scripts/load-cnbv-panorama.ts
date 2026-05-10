/**
 * CLI: Load CNBV Panorama Anual de Inclusión Financiera 2025.
 *
 * v0.2.12 of the analytical roadmap. CNBV's flagship comprehensive annual
 * report on financial inclusion. Two annexes are loaded:
 *
 *   1. Detalle por municipio (76 cols × 2,469 munis)
 *      → cnbv_panorama_municipal_raw + cnbv_panorama_municipal view
 *      → /analytics/municipio-detail nested `inclusion_financiera`
 *
 *   2. Anexo-Estado (72 cols × 32 estados)
 *      → cnbv_panorama_estatal_raw + cnbv_panorama_estatal view
 *      → /analytics/entidad-detail nested `inclusion_financiera`
 *
 * Source: operator-supplied via Drive 2026-05-10.
 *   raw/cnbv/Anexo_Panorama_2025.xlsx (~3 MB / 20 sheets)
 *
 * Why two phases in one loader: the two anexos share the schema-family
 * (Sucursales, Cajeros, TPV, Cuentas, Créditos, Tx TPV, Remesas) plus
 * estado-only extras (SAR, Seguros, CONDUSEF, Acomodo rankings) and
 * muni-only extras (gender brechas). Single load pass covers both, both
 * raw tables are independent, both views are independent. If one
 * downstream join breaks, we don't re-load the other.
 *
 * Behavior:
 *   1. Run cnbv-panorama-xlsx-to-csv.py twice (--sheet=muni, --sheet=estado)
 *      to /tmp/cnbv_panorama_{muni,estado}.csv. Python+openpyxl is the
 *      project-standard XLSX → CSV pre-pass (see scripts/coneval-ageb-*.py
 *      and scripts/aeropuertos-*.py).
 *   2. DROP+CREATE both raw tables (TEXT cols) idempotently.
 *   3. \copy both CSVs in via docker exec, with NULL '*' so the converter's
 *      sentinel maps to actual NULL on read.
 *   4. DROP+CREATE both views with NULLIF/cast.
 *   5. Verify counts. Hard-fail if dup (cve_mun) or (cve_ent) groups.
 *
 * Idempotent: rerun freely. Annual refresh (Panorama 2026, ...) overwrites
 * prior load; multi-period history is out of scope.
 *
 * Usage:
 *   npx tsx scripts/load-cnbv-panorama.ts \
 *     --xlsx=raw/cnbv/Anexo_Panorama_2025.xlsx
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadCnbvPanorama: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

// ---------------------------------------------------------------------------
// DDL — raw tables (all TEXT, mirrors converter HEADER lists exactly).
// ---------------------------------------------------------------------------

export const MUNI_RAW_DDL = `
DROP TABLE IF EXISTS cnbv_panorama_municipal_raw CASCADE;
CREATE TABLE cnbv_panorama_municipal_raw (
  clave_municipio_num   TEXT,
  cve_mun               TEXT,
  nom_ent               TEXT,
  nom_mun               TEXT,
  nom_ent_mun           TEXT,
  poblacion_total       TEXT,
  poblacion_adulta      TEXT,
  rezago_social         TEXT,
  sucursales_bm         TEXT,
  sucursales_bd         TEXT,
  sucursales_socap      TEXT,
  sucursales_sofipo     TEXT,
  sucursales_total      TEXT,
  corresponsales_max    TEXT,
  cajeros_bm            TEXT,
  cajeros_bd            TEXT,
  cajeros_socap         TEXT,
  cajeros_sofipo        TEXT,
  cajeros_total         TEXT,
  tpv_bm                TEXT,
  tpv_bd                TEXT,
  tpv_socap             TEXT,
  tpv_sofipo            TEXT,
  tpv_total_eacp        TEXT,
  tpv_agregadores       TEXT,
  tpv_adq_no_banc       TEXT,
  tpv_total_ag_adq      TEXT,
  tpv_total             TEXT,
  puntos_acceso_sca     TEXT,
  cuentas_bm            TEXT,
  cuentas_bd            TEXT,
  cuentas_socap         TEXT,
  cuentas_sofipo        TEXT,
  cuentas_total         TEXT,
  creditos_bm           TEXT,
  creditos_bd           TEXT,
  creditos_socap        TEXT,
  creditos_sofipo       TEXT,
  creditos_total        TEXT,
  tx_tpv_bm             TEXT,
  tx_tpv_bd             TEXT,
  tx_tpv_socap          TEXT,
  tx_tpv_sofipo         TEXT,
  tx_tpv_total          TEXT,
  remesas_mdd           TEXT,
  remesas_per_capita    TEXT,
  g_cuentas_bm_m        TEXT,
  g_cuentas_bm_h        TEXT,
  g_cuentas_bm_b        TEXT,
  g_cuentas_bd_m        TEXT,
  g_cuentas_bd_h        TEXT,
  g_cuentas_bd_b        TEXT,
  g_cuentas_socap_m     TEXT,
  g_cuentas_socap_h     TEXT,
  g_cuentas_socap_b     TEXT,
  g_cuentas_sofipo_m    TEXT,
  g_cuentas_sofipo_h    TEXT,
  g_cuentas_sofipo_b    TEXT,
  g_cuentas_total_m     TEXT,
  g_cuentas_total_h     TEXT,
  g_cuentas_total_b     TEXT,
  g_creditos_bm_m       TEXT,
  g_creditos_bm_h       TEXT,
  g_creditos_bm_b       TEXT,
  g_creditos_bd_m       TEXT,
  g_creditos_bd_h       TEXT,
  g_creditos_bd_b       TEXT,
  g_creditos_socap_m    TEXT,
  g_creditos_socap_h    TEXT,
  g_creditos_socap_b    TEXT,
  g_creditos_sofipo_m   TEXT,
  g_creditos_sofipo_h   TEXT,
  g_creditos_sofipo_b   TEXT,
  g_creditos_total_m    TEXT,
  g_creditos_total_h    TEXT,
  g_creditos_total_b    TEXT,
  periodo               TEXT DEFAULT 'panorama-2025',
  ingested_at           TIMESTAMPTZ DEFAULT NOW()
);
`;

export const ESTADO_RAW_DDL = `
DROP TABLE IF EXISTS cnbv_panorama_estatal_raw CASCADE;
CREATE TABLE cnbv_panorama_estatal_raw (
  cve_estado_num        TEXT,
  nom_ent               TEXT,
  poblacion_total       TEXT,
  poblacion_adulta      TEXT,
  sucursales_bm         TEXT,
  sucursales_bd         TEXT,
  sucursales_socap      TEXT,
  sucursales_sofipo     TEXT,
  sucursales_total      TEXT,
  corresponsales_max    TEXT,
  cajeros_bm            TEXT,
  cajeros_bd            TEXT,
  cajeros_socap         TEXT,
  cajeros_sofipo        TEXT,
  cajeros_total         TEXT,
  tpv_bm                TEXT,
  tpv_bd                TEXT,
  tpv_socap             TEXT,
  tpv_sofipo            TEXT,
  tpv_total_eacp        TEXT,
  tpv_agregadores       TEXT,
  tpv_adq_no_banc       TEXT,
  tpv_total_ag_adq      TEXT,
  tpv_total             TEXT,
  cuentas_bm            TEXT,
  cuentas_bd            TEXT,
  cuentas_socap         TEXT,
  cuentas_sofipo        TEXT,
  cuentas_total         TEXT,
  creditos_bm           TEXT,
  creditos_bd           TEXT,
  creditos_socap        TEXT,
  creditos_sofipo       TEXT,
  creditos_total        TEXT,
  sar_asignado          TEXT,
  sar_registrado        TEXT,
  sar_total             TEXT,
  seg_vida              TEXT,
  seg_pensiones         TEXT,
  seg_accidentes        TEXT,
  seg_danos_sin_autos   TEXT,
  seg_automoviles       TEXT,
  seg_total             TEXT,
  tx_tpv_bm             TEXT,
  tx_tpv_bd             TEXT,
  tx_tpv_socap          TEXT,
  tx_tpv_sofipo         TEXT,
  tx_tpv_total          TEXT,
  remesas_mdd           TEXT,
  condusef_ubicacion    TEXT,
  condusef_reclamaciones TEXT,
  ac_inf_sucursales     TEXT,
  ac_inf_corresponsales TEXT,
  ac_inf_cajeros        TEXT,
  ac_inf_tpv            TEXT,
  ac_inf_total_ag_adq   TEXT,
  ac_inf_estado         TEXT,
  ac_pf_captacion       TEXT,
  ac_pf_credito         TEXT,
  ac_pf_afore           TEXT,
  ac_pf_vida            TEXT,
  ac_pf_pensiones       TEXT,
  ac_pf_accidentes      TEXT,
  ac_pf_danos_sin_autos TEXT,
  ac_pf_automoviles     TEXT,
  ac_pf_estado          TEXT,
  ac_mp_tx_tpv          TEXT,
  ac_mp_remesas         TEXT,
  ac_mp_estado_a        TEXT,
  ac_mp_ubicacion       TEXT,
  ac_mp_reclamaciones   TEXT,
  ac_mp_estado_b        TEXT,
  periodo               TEXT DEFAULT 'panorama-2025',
  ingested_at           TIMESTAMPTZ DEFAULT NOW()
);
`;

// ---------------------------------------------------------------------------
// Views — NULLIF '*' + cast. The converter uses '*' as the sentinel for both
// "missing" and "n<100 brecha suppressed" (CNBV statistical-validity floor).
// View consumers cannot distinguish the two. This is intentional — see
// docs/scan-cnbv-panorama-2025.md for the trade-off rationale.
// ---------------------------------------------------------------------------

const N = (col: string): string => `NULLIF(${col}, '*')::numeric`;
const NI = (col: string): string => `NULLIF(${col}, '*')::int`;

const NUMERIC_MUNI_COLS = [
  "poblacion_total",
  "poblacion_adulta",
  "sucursales_bm",
  "sucursales_bd",
  "sucursales_socap",
  "sucursales_sofipo",
  "sucursales_total",
  "corresponsales_max",
  "cajeros_bm",
  "cajeros_bd",
  "cajeros_socap",
  "cajeros_sofipo",
  "cajeros_total",
  "tpv_bm",
  "tpv_bd",
  "tpv_socap",
  "tpv_sofipo",
  "tpv_total_eacp",
  "tpv_agregadores",
  "tpv_adq_no_banc",
  "tpv_total_ag_adq",
  "tpv_total",
  "puntos_acceso_sca",
  "cuentas_bm",
  "cuentas_bd",
  "cuentas_socap",
  "cuentas_sofipo",
  "cuentas_total",
  "creditos_bm",
  "creditos_bd",
  "creditos_socap",
  "creditos_sofipo",
  "creditos_total",
  "tx_tpv_bm",
  "tx_tpv_bd",
  "tx_tpv_socap",
  "tx_tpv_sofipo",
  "tx_tpv_total",
  "remesas_mdd",
  "remesas_per_capita",
  "g_cuentas_bm_m",
  "g_cuentas_bm_h",
  "g_cuentas_bm_b",
  "g_cuentas_bd_m",
  "g_cuentas_bd_h",
  "g_cuentas_bd_b",
  "g_cuentas_socap_m",
  "g_cuentas_socap_h",
  "g_cuentas_socap_b",
  "g_cuentas_sofipo_m",
  "g_cuentas_sofipo_h",
  "g_cuentas_sofipo_b",
  "g_cuentas_total_m",
  "g_cuentas_total_h",
  "g_cuentas_total_b",
  "g_creditos_bm_m",
  "g_creditos_bm_h",
  "g_creditos_bm_b",
  "g_creditos_bd_m",
  "g_creditos_bd_h",
  "g_creditos_bd_b",
  "g_creditos_socap_m",
  "g_creditos_socap_h",
  "g_creditos_socap_b",
  "g_creditos_sofipo_m",
  "g_creditos_sofipo_h",
  "g_creditos_sofipo_b",
  "g_creditos_total_m",
  "g_creditos_total_h",
  "g_creditos_total_b",
];

const NUMERIC_ESTADO_COLS = [
  "poblacion_total",
  "poblacion_adulta",
  "sucursales_bm",
  "sucursales_bd",
  "sucursales_socap",
  "sucursales_sofipo",
  "sucursales_total",
  "corresponsales_max",
  "cajeros_bm",
  "cajeros_bd",
  "cajeros_socap",
  "cajeros_sofipo",
  "cajeros_total",
  "tpv_bm",
  "tpv_bd",
  "tpv_socap",
  "tpv_sofipo",
  "tpv_total_eacp",
  "tpv_agregadores",
  "tpv_adq_no_banc",
  "tpv_total_ag_adq",
  "tpv_total",
  "cuentas_bm",
  "cuentas_bd",
  "cuentas_socap",
  "cuentas_sofipo",
  "cuentas_total",
  "creditos_bm",
  "creditos_bd",
  "creditos_socap",
  "creditos_sofipo",
  "creditos_total",
  "sar_asignado",
  "sar_registrado",
  "sar_total",
  "seg_vida",
  "seg_pensiones",
  "seg_accidentes",
  "seg_danos_sin_autos",
  "seg_automoviles",
  "seg_total",
  "tx_tpv_bm",
  "tx_tpv_bd",
  "tx_tpv_socap",
  "tx_tpv_sofipo",
  "tx_tpv_total",
  "remesas_mdd",
  "condusef_ubicacion",
  "condusef_reclamaciones",
  "ac_inf_sucursales",
  "ac_inf_corresponsales",
  "ac_inf_cajeros",
  "ac_inf_tpv",
  "ac_inf_total_ag_adq",
  "ac_pf_captacion",
  "ac_pf_credito",
  "ac_pf_afore",
  "ac_pf_vida",
  "ac_pf_pensiones",
  "ac_pf_accidentes",
  "ac_pf_danos_sin_autos",
  "ac_pf_automoviles",
  "ac_mp_tx_tpv",
  "ac_mp_remesas",
  "ac_mp_ubicacion",
  "ac_mp_reclamaciones",
];

function buildMuniViewSql(): string {
  const numericProjections = NUMERIC_MUNI_COLS.map(
    (c) => `${N(c)} AS ${c}`,
  ).join(",\n  ");
  return `
DROP VIEW IF EXISTS cnbv_panorama_municipal CASCADE;
CREATE VIEW cnbv_panorama_municipal AS
SELECT
  cve_mun,
  ${NI("clave_municipio_num")} AS clave_municipio_num,
  nom_ent,
  nom_mun,
  nom_ent_mun,
  NULLIF(rezago_social, '*') AS rezago_social,
  ${numericProjections},
  periodo
FROM cnbv_panorama_municipal_raw
WHERE cve_mun ~ '^[0-9]{5}$'
  AND cve_mun <> '99999';
`;
}

function buildEstadoViewSql(): string {
  const numericProjections = NUMERIC_ESTADO_COLS.map(
    (c) => `${N(c)} AS ${c}`,
  ).join(",\n  ");
  return `
DROP VIEW IF EXISTS cnbv_panorama_estatal CASCADE;
CREATE VIEW cnbv_panorama_estatal AS
SELECT
  LPAD(cve_estado_num, 2, '0') AS cve_ent,
  ${NI("cve_estado_num")} AS cve_estado_num,
  nom_ent,
  ${numericProjections},
  NULLIF(ac_inf_estado, '*')   AS ac_inf_estado_label,
  NULLIF(ac_pf_estado, '*')    AS ac_pf_estado_label,
  NULLIF(ac_mp_estado_a, '*')  AS ac_mp_estado_a_label,
  NULLIF(ac_mp_estado_b, '*')  AS ac_mp_estado_b_label,
  periodo
FROM cnbv_panorama_estatal_raw
WHERE cve_estado_num ~ '^[0-9]+$'
  AND cve_estado_num::int BETWEEN 1 AND 32;
`;
}

/**
 * Btree indexes on the join keys for the LEFT JOINs in
 * /analytics/municipio-detail and /analytics/entidad-detail. Round-2 audit
 * (SV1) flagged that sibling raw tables (cofepris/coneval/ce2024) all
 * carry an index on cve_mun-equivalent and CNBV's were missing. n=2,469
 * is small enough that a seq-scan is fine today (~57ms full); adding the
 * index protects against the pattern violation and makes EXPLAIN read
 * cleaner (Index Scan instead of Seq Scan + Filter).
 */
const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_cnbv_panorama_muni_cve_mun
  ON cnbv_panorama_municipal_raw(cve_mun);
CREATE INDEX IF NOT EXISTS idx_cnbv_panorama_estatal_cve_estado
  ON cnbv_panorama_estatal_raw(cve_estado_num);
`;

// ---------------------------------------------------------------------------
// Public entry — exported for tests.
// ---------------------------------------------------------------------------

export const POST_LOAD_SQL_FOR_TEST = buildMuniViewSql() + buildEstadoViewSql();

export interface LoadCnbvPanoramaConfig {
  xlsxPath: string;
  dbContainer: string;
  /** Override the python interpreter (default: 'python3'). */
  pythonBin?: string;
  /** Override script dir for tests (default: scripts/ alongside this file). */
  scriptDir?: string;
}

export interface LoadCnbvPanoramaResult {
  muni_rows: number;
  estado_rows: number;
  duration_ms: number;
}

export async function loadCnbvPanorama(
  config: LoadCnbvPanoramaConfig,
): Promise<LoadCnbvPanoramaResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadCnbvPanorama: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("xlsxPath", config.xlsxPath);

  const started = Date.now();
  const pythonBin = config.pythonBin ?? "python3";
  const scriptDir = config.scriptDir ?? "scripts";
  const converter = `${scriptDir}/cnbv-panorama-xlsx-to-csv.py`;

  // 1. Convert XLSX → 2 CSVs in a private tempdir
  const work = mkdtempSync(join(tmpdir(), "cnbv-panorama-"));
  const muniCsv = join(work, "muni.csv");
  const estadoCsv = join(work, "estado.csv");
  try {
    for (const [sheet, dest] of [
      ["muni", muniCsv],
      ["estado", estadoCsv],
    ] as const) {
      const out = execFileSync(
        pythonBin,
        [converter, `--sheet=${sheet}`, config.xlsxPath],
        { encoding: "utf-8", timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      writeFileSync(dest, out);
    }

    // 2. Create raw tables
    psql(config.dbContainer, MUNI_RAW_DDL);
    psql(config.dbContainer, ESTADO_RAW_DDL);

    // 3. \copy both CSVs in
    copyCsv(config.dbContainer, muniCsv, "cnbv_panorama_municipal_raw");
    copyCsv(config.dbContainer, estadoCsv, "cnbv_panorama_estatal_raw");

    // 4. Create views
    psql(config.dbContainer, buildMuniViewSql());
    psql(config.dbContainer, buildEstadoViewSql());

    // 4b. Btree indexes on join keys (SV1 round-2 audit)
    psql(config.dbContainer, INDEX_DDL);

    // 5. Verify counts + dup guards
    const muniRows = countRows(
      config.dbContainer,
      "SELECT COUNT(*) FROM cnbv_panorama_municipal;",
    );
    const estadoRows = countRows(
      config.dbContainer,
      "SELECT COUNT(*) FROM cnbv_panorama_estatal;",
    );

    const muniDups = countRows(
      config.dbContainer,
      `SELECT COUNT(*) FROM (
         SELECT cve_mun FROM cnbv_panorama_municipal
         GROUP BY cve_mun HAVING COUNT(*) > 1
       ) d;`,
    );
    const estadoDups = countRows(
      config.dbContainer,
      `SELECT COUNT(*) FROM (
         SELECT cve_ent FROM cnbv_panorama_estatal
         GROUP BY cve_ent HAVING COUNT(*) > 1
       ) d;`,
    );
    if (muniDups > 0) {
      throw new Error(
        `loadCnbvPanorama: producer invariant violated — ${muniDups} cve_mun groups have >1 row.`,
      );
    }
    if (estadoDups > 0) {
      throw new Error(
        `loadCnbvPanorama: producer invariant violated — ${estadoDups} cve_ent groups have >1 row.`,
      );
    }

    return {
      muni_rows: muniRows,
      estado_rows: estadoRows,
      duration_ms: Date.now() - started,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function psql(container: string, sql: string): void {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      sql,
    ],
    { encoding: "utf-8", timeout: 5 * 60_000 },
  );
}

function copyCsv(container: string, csvPath: string, table: string): void {
  // CSV path is host-side. docker cp into container, then \copy from inside.
  const containerPath = `/tmp/${table}.csv`;
  execFileSync(
    "docker",
    ["cp", "--", csvPath, `${container}:${containerPath}`],
    {
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
  try {
    execFileSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `\\copy ${table} (${tableLeadingCols(table).join(",")}) FROM '${containerPath}' WITH (FORMAT csv, HEADER true, NULL '*')`,
      ],
      { encoding: "utf-8", timeout: 5 * 60_000 },
    );
  } finally {
    try {
      execFileSync("docker", ["exec", container, "rm", "-f", containerPath], {
        encoding: "utf-8",
        timeout: 30_000,
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * Names of the leading columns to load via \copy (excluding `periodo` and
 * `ingested_at`, both of which use DEFAULT). Mirrors the converter HEADER
 * lists exactly. Defined here rather than imported so the loader is the
 * single source of truth for the load contract.
 */
export function tableLeadingCols(table: string): string[] {
  if (table === "cnbv_panorama_municipal_raw") {
    return [
      "clave_municipio_num",
      "cve_mun",
      "nom_ent",
      "nom_mun",
      "nom_ent_mun",
      "poblacion_total",
      "poblacion_adulta",
      "rezago_social",
      "sucursales_bm",
      "sucursales_bd",
      "sucursales_socap",
      "sucursales_sofipo",
      "sucursales_total",
      "corresponsales_max",
      "cajeros_bm",
      "cajeros_bd",
      "cajeros_socap",
      "cajeros_sofipo",
      "cajeros_total",
      "tpv_bm",
      "tpv_bd",
      "tpv_socap",
      "tpv_sofipo",
      "tpv_total_eacp",
      "tpv_agregadores",
      "tpv_adq_no_banc",
      "tpv_total_ag_adq",
      "tpv_total",
      "puntos_acceso_sca",
      "cuentas_bm",
      "cuentas_bd",
      "cuentas_socap",
      "cuentas_sofipo",
      "cuentas_total",
      "creditos_bm",
      "creditos_bd",
      "creditos_socap",
      "creditos_sofipo",
      "creditos_total",
      "tx_tpv_bm",
      "tx_tpv_bd",
      "tx_tpv_socap",
      "tx_tpv_sofipo",
      "tx_tpv_total",
      "remesas_mdd",
      "remesas_per_capita",
      "g_cuentas_bm_m",
      "g_cuentas_bm_h",
      "g_cuentas_bm_b",
      "g_cuentas_bd_m",
      "g_cuentas_bd_h",
      "g_cuentas_bd_b",
      "g_cuentas_socap_m",
      "g_cuentas_socap_h",
      "g_cuentas_socap_b",
      "g_cuentas_sofipo_m",
      "g_cuentas_sofipo_h",
      "g_cuentas_sofipo_b",
      "g_cuentas_total_m",
      "g_cuentas_total_h",
      "g_cuentas_total_b",
      "g_creditos_bm_m",
      "g_creditos_bm_h",
      "g_creditos_bm_b",
      "g_creditos_bd_m",
      "g_creditos_bd_h",
      "g_creditos_bd_b",
      "g_creditos_socap_m",
      "g_creditos_socap_h",
      "g_creditos_socap_b",
      "g_creditos_sofipo_m",
      "g_creditos_sofipo_h",
      "g_creditos_sofipo_b",
      "g_creditos_total_m",
      "g_creditos_total_h",
      "g_creditos_total_b",
    ];
  }
  if (table === "cnbv_panorama_estatal_raw") {
    return [
      "cve_estado_num",
      "nom_ent",
      "poblacion_total",
      "poblacion_adulta",
      "sucursales_bm",
      "sucursales_bd",
      "sucursales_socap",
      "sucursales_sofipo",
      "sucursales_total",
      "corresponsales_max",
      "cajeros_bm",
      "cajeros_bd",
      "cajeros_socap",
      "cajeros_sofipo",
      "cajeros_total",
      "tpv_bm",
      "tpv_bd",
      "tpv_socap",
      "tpv_sofipo",
      "tpv_total_eacp",
      "tpv_agregadores",
      "tpv_adq_no_banc",
      "tpv_total_ag_adq",
      "tpv_total",
      "cuentas_bm",
      "cuentas_bd",
      "cuentas_socap",
      "cuentas_sofipo",
      "cuentas_total",
      "creditos_bm",
      "creditos_bd",
      "creditos_socap",
      "creditos_sofipo",
      "creditos_total",
      "sar_asignado",
      "sar_registrado",
      "sar_total",
      "seg_vida",
      "seg_pensiones",
      "seg_accidentes",
      "seg_danos_sin_autos",
      "seg_automoviles",
      "seg_total",
      "tx_tpv_bm",
      "tx_tpv_bd",
      "tx_tpv_socap",
      "tx_tpv_sofipo",
      "tx_tpv_total",
      "remesas_mdd",
      "condusef_ubicacion",
      "condusef_reclamaciones",
      "ac_inf_sucursales",
      "ac_inf_corresponsales",
      "ac_inf_cajeros",
      "ac_inf_tpv",
      "ac_inf_total_ag_adq",
      "ac_inf_estado",
      "ac_pf_captacion",
      "ac_pf_credito",
      "ac_pf_afore",
      "ac_pf_vida",
      "ac_pf_pensiones",
      "ac_pf_accidentes",
      "ac_pf_danos_sin_autos",
      "ac_pf_automoviles",
      "ac_pf_estado",
      "ac_mp_tx_tpv",
      "ac_mp_remesas",
      "ac_mp_estado_a",
      "ac_mp_ubicacion",
      "ac_mp_reclamaciones",
      "ac_mp_estado_b",
    ];
  }
  throw new Error(`tableLeadingCols: unknown table ${table}`);
}

function countRows(container: string, sql: string): number {
  const out = execFileSync(
    "docker",
    [
      "exec",
      container,
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
    throw new Error(`loadCnbvPanorama: unexpected count output "${out}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const xlsxPath = getArg("xlsx");
  if (!xlsxPath) {
    console.error(
      "Usage: npx tsx scripts/load-cnbv-panorama.ts --xlsx=raw/cnbv/Anexo_Panorama_2025.xlsx",
    );
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(`[load-cnbv-panorama] loading panorama → ${dbContainer} ...`);
  loadCnbvPanorama({ xlsxPath, dbContainer })
    .then((r) => {
      console.log(
        `[load-cnbv-panorama] ✓ muni=${r.muni_rows.toLocaleString()} | estado=${r.estado_rows.toLocaleString()} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-cnbv-panorama] ✗ ${msg}`);
      process.exit(1);
    });
}
