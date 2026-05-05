/**
 * CLI: Load CE 2024 (Censos Económicos 2024) per-state ZIPs.
 *
 * v0.2.2 of the analytical roadmap — per-municipio rollups of unidades
 * económicas, personal ocupado, producción bruta total, valor agregado
 * censal bruto, remuneraciones, gastos, ingresos, inversión, etc. Joins to
 * DENUE establecimientos via cve_mun (5-char ENT||MUN) and to CONEVAL +
 * CLUES via the same key for the analyzer's "Locust" mode.
 *
 * Source: https://www.censoseconomicos2024.mx/ → Datos abiertos
 *   Per-state CSV ZIPs at
 *   https://www.inegi.org.mx/contenidos/programas/ce/2024/datosabiertos/conjunto_de_datos_ce_<XXX>_2024_csv.zip
 *   where <XXX> is INEGI's state short code. The headless probe of any
 *   guessed slug returns a 2,263-byte UA-gating decoy; the operator copies
 *   the real URLs out of the SPA. See docs/fase-2-ce2024-clues-sesnsp.md
 *   "Verificación 2026-05-05".
 *
 * Inputs: 32 zips in raw/ (one per entidad federativa). Each contains:
 *   - conjunto_de_datos/tr_ce_<XXX>_2024.csv  (the 105-column fact table)
 *   - catalogos/, diccionario_de_datos/, metadatos/, modelo_entidad_relacion/
 *   The loader only reads the fact table.
 *
 * Schema: all 32 fact CSVs share an identical 105-column header (verified
 * 2026-05-05). The DDL for `ce2024_raw` is generated once from the first
 * ZIP's header row, so a future column add or rename in INEGI's emission
 * is caught when the loader's column-name allowlist or the audit assertion
 * trips — not silently absorbed.
 *
 * Granularity is mixed within each file:
 *   - E03='' AND E04=''     → national rollup row (only in the *_nac_* file,
 *                              not in state files; if seen here it's a bug)
 *   - E03!='' AND E04=''    → state-level row
 *   - E03!='' AND E04!=''   → municipal row (the join target)
 *
 * Post-load views:
 *   - ce2024_municipal: filtered to (E03!='' AND E04!=''), with cast numeric
 *     metrics, derived `cve_mun` (5-char), and SCIAN hierarchy promoted to
 *     dedicated columns. Indexed on cve_mun + sector for the analytics
 *     handlers.
 *
 * Idempotent: rerun freely. ZIPs are the boundary of trust.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9_.\\/-]+$/;
const STATE_CODE_RE = /^[a-z]{2,5}$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadCe2024: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
  if (!SAFE_PATH_RE.test(p)) {
    throw new Error(`loadCe2024: ${label} contiene caracteres no permitidos.`);
  }
}

function dockerExec(
  container: string,
  args: string[],
  timeoutMs: number,
): string {
  return execFileSync("docker", ["exec", container, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
  });
}

function dockerCp(
  container: string,
  src: string,
  dst: string,
  timeoutMs: number,
): void {
  execFileSync("docker", ["cp", "--", src, `${container}:${dst}`], {
    encoding: "utf-8",
    timeout: timeoutMs,
  });
}

/**
 * List CE 2024 ZIPs in `dir`, return sorted [{ stateCode, zipPath }] tuples.
 * Filenames follow `conjunto_de_datos_ce_<state>_2024_csv.zip`. The "_nac_"
 * (national rollup) file is silently skipped — the loader only ingests the
 * 31 state files for municipal granularity. A future operator who passes a
 * dir with extra zips will get an error.
 */
export function listStateZips(
  dir: string,
): Array<{ stateCode: string; zipPath: string }> {
  const out = execFileSync(
    "/bin/sh",
    [
      "-c",
      `cd "$1" && ls conjunto_de_datos_ce_*_2024_csv.zip 2>/dev/null`,
      "sh",
      dir,
    ],
    { encoding: "utf-8", timeout: 10_000 },
  );
  const result: Array<{ stateCode: string; zipPath: string }> = [];
  for (const line of out.split("\n")) {
    const name = line.trim();
    if (!name) continue;
    const m = name.match(/^conjunto_de_datos_ce_([a-z]+)_2024_csv\.zip$/);
    if (!m) continue;
    const code = m[1] as string;
    if (code === "nac") continue; // skip national rollup
    if (!STATE_CODE_RE.test(code)) {
      throw new Error(
        `loadCe2024: state code "${code}" in ${name} doesn't match [a-z]{2,5}`,
      );
    }
    result.push({ stateCode: code, zipPath: join(dir, name) });
  }
  result.sort((a, b) => a.stateCode.localeCompare(b.stateCode));
  return result;
}

/**
 * Read the fact-table header from one ZIP and return the lower-cased,
 * comma-separated SQL column names. CE 2024 column codes are pure ASCII
 * (E03, A111A, H001A...) so no normalization beyond a tolower pass is
 * needed. The PostgreSQL identifier safety check rejects anything outside
 * [a-z][a-z0-9_]*.
 */
export function readCe2024Header(zipPath: string, innerCsv: string): string[] {
  const out = execFileSync(
    "/bin/sh",
    ["-c", `unzip -p "$1" "$2" | head -1`, "sh", zipPath, innerCsv],
    { encoding: "utf-8", timeout: 30_000 },
  );
  const headerLine = out.replace(/\r?\n.*/s, "").replace(/^﻿/, "");
  const cols = headerLine.split(",").map((c) => c.trim().toLowerCase());
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(
        `loadCe2024: unsafe column name "${c}" in ${zipPath}/${innerCsv}`,
      );
    }
  }
  return cols;
}

const CE2024_REQUIRED = [
  "e03",
  "e04",
  "sector",
  "subsector",
  "rama",
  "subrama",
  "clase",
  "id_estrato",
  "codigo",
  "ue",
  "h001a",
  "a111a",
  "a131a",
  "a700a",
  "a800a",
  "j000a",
];

/**
 * Build the `ce2024_municipal` materialized view. Filters the raw mixed-
 * granularity table down to municipal rows (E03 + E04 both populated). Casts
 * the high-signal numeric columns to numeric/int with NULLIF empty-string
 * guards. Derives `cve_mun` (5-char zero-padded ENT||MUN) and `sector_2`
 * (always 2-char SCIAN, derived from CODIGO when SECTOR is empty for "TOTAL
 * DE SECTOR" rollup rows).
 *
 * Metrics retained (others stay accessible via ce2024_raw if needed):
 *   - ue                                  number of unidades económicas
 *   - h001a/h000a/h010a/h020a             personal ocupado breakdown
 *   - i000a                               horas trabajadas
 *   - j000a                               remuneraciones (M$)
 *   - a111a / a121a / a131a               producción bruta / consumo / VA
 *   - a700a / a800a                       gastos / ingresos totales
 *   - a211a / a221a                       inversión total / FBCF
 *   - a511a                               margen reventa mercancías
 *   - k000a                               gastos de operación
 *   - m000a                               ingresos por suministro
 */
export const POST_LOAD_SQL = `
DROP MATERIALIZED VIEW IF EXISTS ce2024_municipal CASCADE;
CREATE MATERIALIZED VIEW ce2024_municipal AS
SELECT
  (e03 || e04)                                    AS cve_mun,
  e03                                             AS cve_ent,
  e04                                             AS cve_mun_3,
  NULLIF(sector, '')                              AS sector,
  NULLIF(subsector, '')                           AS subsector,
  NULLIF(rama, '')                                AS rama,
  NULLIF(subrama, '')                             AS subrama,
  NULLIF(clase, '')                               AS clase,
  NULLIF(id_estrato, '')::int                     AS id_estrato,
  codigo,
  NULLIF(ue, '')::int                             AS ue,
  NULLIF(h001a, '')::numeric                      AS personal_ocupado_total,
  NULLIF(h000a, '')::numeric                      AS personal_dependiente,
  NULLIF(h010a, '')::numeric                      AS personal_remunerado,
  NULLIF(h020a, '')::numeric                      AS personal_no_remunerado,
  NULLIF(i000a, '')::numeric                      AS horas_trabajadas,
  NULLIF(j000a, '')::numeric                      AS remuneraciones,
  NULLIF(a111a, '')::numeric                      AS produccion_bruta_total,
  NULLIF(a121a, '')::numeric                      AS consumo_intermedio,
  NULLIF(a131a, '')::numeric                      AS valor_agregado_censal_bruto,
  NULLIF(a211a, '')::numeric                      AS inversion_total,
  NULLIF(a221a, '')::numeric                      AS formacion_bruta_capital_fijo,
  NULLIF(a511a, '')::numeric                      AS margen_reventa,
  NULLIF(a700a, '')::numeric                      AS gastos_totales,
  NULLIF(a800a, '')::numeric                      AS ingresos_totales,
  NULLIF(k000a, '')::numeric                      AS gastos_operacion,
  NULLIF(m000a, '')::numeric                      AS ingresos_suministro
FROM ce2024_raw
WHERE e03 IS NOT NULL AND e03 != ''
  AND e04 IS NOT NULL AND e04 != '';

DROP INDEX IF EXISTS idx_ce2024_mun_cve;
CREATE INDEX idx_ce2024_mun_cve ON ce2024_municipal (cve_mun);

DROP INDEX IF EXISTS idx_ce2024_mun_sector;
CREATE INDEX idx_ce2024_mun_sector ON ce2024_municipal (sector);

DROP INDEX IF EXISTS idx_ce2024_mun_clase;
CREATE INDEX idx_ce2024_mun_clase ON ce2024_municipal (clase);

DROP INDEX IF EXISTS idx_ce2024_mun_estrato;
CREATE INDEX idx_ce2024_mun_estrato ON ce2024_municipal (id_estrato);
`;

export interface LoadCe2024Config {
  zipDir: string;
  dbContainer: string;
}

export interface LoadCe2024Result {
  states_loaded: number;
  raw_rows: number;
  municipal_rows: number;
  duration_ms: number;
}

/**
 * Extract the fact CSV from a state ZIP, normalize line endings (CSV ships
 * with CRLF — Postgres tolerates either, but we pre-normalize so any later
 * append-style operation stays consistent), and write to a temp file.
 */
function prepareStateCsv(
  zipPath: string,
  innerCsv: string,
  outDir: string,
  stateCode: string,
): string {
  const buf = execFileSync(
    "/bin/sh",
    ["-c", `unzip -p "$1" "$2"`, "sh", zipPath, innerCsv],
    {
      encoding: "utf-8",
      maxBuffer: 200 * 1024 * 1024,
      timeout: 5 * 60_000,
    },
  );
  // Normalize line endings to LF; CE 2024 fact data is pure ASCII so no
  // iconv pass is needed.
  const normalized = buf.replace(/\r\n/g, "\n");
  const outPath = join(outDir, `ce2024_${stateCode}.prep.csv`);
  writeFileSync(outPath, normalized, "utf-8");
  return outPath;
}

export async function loadCe2024(
  config: LoadCe2024Config,
): Promise<LoadCe2024Result> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadCe2024: dbContainer inválido "${config.dbContainer}".`,
    );
  }
  assertSafePath("zipDir", config.zipDir);

  const states = listStateZips(config.zipDir);
  if (states.length === 0) {
    throw new Error(`loadCe2024: no state zips in ${config.zipDir}`);
  }

  const started = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), "ce2024-load-"));

  try {
    // Read the header from the first state zip and verify required columns.
    const firstZip = states[0]!;
    const innerFirst = `conjunto_de_datos/tr_ce_${firstZip.stateCode}_2024.csv`;
    const cols = readCe2024Header(firstZip.zipPath, innerFirst);
    for (const req of CE2024_REQUIRED) {
      if (!cols.includes(req)) {
        throw new Error(
          `loadCe2024: required column "${req}" missing from header of ${firstZip.zipPath}. Got: ${cols.slice(0, 12).join(",")}...`,
        );
      }
    }

    // DDL: all 105 columns as TEXT.
    const ddl = `
DROP TABLE IF EXISTS ce2024_raw CASCADE;
CREATE TABLE ce2024_raw (
${cols.map((c) => `  ${c} TEXT`).join(",\n")}
);
`;
    dockerExec(
      config.dbContainer,
      ["psql", "-U", "postgres", "-d", "postgres", "-c", ddl],
      60_000,
    );

    // Per-state COPY.
    for (const { stateCode, zipPath } of states) {
      const innerCsv = `conjunto_de_datos/tr_ce_${stateCode}_2024.csv`;
      // Verify each state's header matches the canonical one (catches an
      // INEGI emission drift where a later state ships an extra column).
      const stateCols = readCe2024Header(zipPath, innerCsv);
      if (stateCols.length !== cols.length) {
        throw new Error(
          `loadCe2024: ${stateCode} header has ${stateCols.length} cols, expected ${cols.length}`,
        );
      }

      const preparedPath = prepareStateCsv(
        zipPath,
        innerCsv,
        tempDir,
        stateCode,
      );
      const containerPath = `/tmp/ce2024_${stateCode}.csv`;
      dockerCp(config.dbContainer, preparedPath, containerPath, 5 * 60_000);
      try {
        dockerExec(
          config.dbContainer,
          [
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-c",
            `\\copy ce2024_raw FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
          ],
          10 * 60_000,
        );
      } finally {
        try {
          dockerExec(config.dbContainer, ["rm", "-f", containerPath], 30_000);
        } catch {
          // best-effort
        }
      }
    }

    // Build the materialized view + indexes.
    dockerExec(
      config.dbContainer,
      ["psql", "-U", "postgres", "-d", "postgres", "-c", POST_LOAD_SQL],
      5 * 60_000,
    );

    // Counts.
    const cnt = (sql: string): number => {
      const r = dockerExec(
        config.dbContainer,
        ["psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
        60_000,
      ).trim();
      const n = parseInt(r, 10);
      if (!Number.isFinite(n)) {
        throw new Error(`loadCe2024: unexpected count "${r}"`);
      }
      return n;
    };
    return {
      states_loaded: states.length,
      raw_rows: cnt("SELECT COUNT(*) FROM ce2024_raw;"),
      municipal_rows: cnt("SELECT COUNT(*) FROM ce2024_municipal;"),
      duration_ms: Date.now() - started,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const zipDir = getArg("zip-dir") ?? "raw";
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(`[load-ce2024] loading state ZIPs from ${zipDir} ...`);
  loadCe2024({ zipDir, dbContainer })
    .then((r) => {
      console.log(
        `[load-ce2024] ✓ states=${r.states_loaded} raw=${r.raw_rows.toLocaleString()} municipal=${r.municipal_rows.toLocaleString()} in ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-ce2024] ✗ ${msg}`);
      process.exit(1);
    });
}
