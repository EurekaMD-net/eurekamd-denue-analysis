/**
 * CLI: Load SESNSP RNID (Registro Nacional de Información Delictiva).
 *
 * v0.2.2 of the analytical roadmap — operational-risk overlay for joining to
 * DENUE establecimientos via cve_mun. Captures incidencia delictiva (events
 * counted as delitos) and victimization (people counted as víctimas) at both
 * state and municipal granularity, with monthly columns Enero..Diciembre.
 *
 * Source: https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva
 *   Headless probes hit a Cloudflare-style "Challenge Validation" gate; the
 *   files must be downloaded through a real browser session, then dropped in
 *   raw/sesnsp/. See docs/fase-2-ce2024-clues-sesnsp.md "Verificación
 *   2026-05-05" for the gate fingerprint.
 *
 * Inputs: 4 ZIPs in raw/sesnsp/ (canonical names — match the CSV name inside
 * each ZIP):
 *   - RNID-Delitos_Estatal-YYYY-mes.zip
 *   - RNID-Delitos_Municipal-YYYY-mes.zip
 *   - RNID-Victimas_Estatal-YYYY-mes.zip
 *   - RNID-Victimas_Municipal-YYYY-mes.zip
 *
 * Each CSV is WINDOWS-1252 with Spanish accents in headers AND values
 * (`Año`, `Bien jurídico afectado`, etc.). Loader iconv's to UTF-8 + rewrites
 * the header to snake_case ASCII identifiers before \copy.
 *
 * Schema (all 4 raw tables share the same wide-month layout; only the keys
 * differ — Estatal lacks cve_municipio/municipio):
 *   ano | cve_ent | entidad | [cve_municipio | municipio]? | bien_juridico
 *     | tipo_delito | subtipo_delito | modalidad
 *     | enero..diciembre  (monthly counts, may be empty)
 *
 * Post-load views unpivot the 12 monthly columns into long format (one row
 * per (ano, mes, cve_mun, delito), with 5-char zero-padded cve_mun derived
 * from the file's 4-or-5-digit Cve.Municipio via LPAD). The DENUE join is
 * `establecimientos.area_geo = sesnsp_*.cve_mun`.
 *
 * Idempotent: rerun freely. ZIPs are the boundary of trust.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9_.\\/-]+$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadSesnsp: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
  if (!SAFE_PATH_RE.test(p)) {
    throw new Error(`loadSesnsp: ${label} contiene caracteres no permitidos.`);
  }
}

/**
 * Snake-case + de-accent transform for header normalization. The raw SESNSP
 * column names — once iconv'd to UTF-8 — contain spaces, dots, and accented
 * characters. PostgreSQL allows them with quoting, but the loader rejects
 * any column name that doesn't match `[a-z][a-z0-9_]*` to keep SQL identifier
 * paths trivially safe.
 *
 * Mapping verified against the four RNID-2026 files; treat any change as a
 * schema break that needs explicit code update (test asserts canonical names).
 */
const HEADER_MAP: Record<string, string> = {
  año: "ano",
  clave_ent: "cve_ent",
  entidad: "entidad",
  "cve._municipio": "cve_municipio",
  municipio: "municipio",
  bien_jurídico_afectado: "bien_juridico",
  tipo_de_delito: "tipo_delito",
  subtipo_de_delito: "subtipo_delito",
  modalidad: "modalidad",
  // Víctimas variants only — segments people by demographic.
  sexo: "sexo",
  rango_de_edad: "rango_edad",
  enero: "enero",
  febrero: "febrero",
  marzo: "marzo",
  abril: "abril",
  mayo: "mayo",
  junio: "junio",
  julio: "julio",
  agosto: "agosto",
  septiembre: "septiembre",
  octubre: "octubre",
  noviembre: "noviembre",
  diciembre: "diciembre",
};

export function normalizeHeader(raw: string): string {
  // Strip BOM, lowercase, replace whitespace with `_`, then look up in map.
  const cleaned = raw
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const mapped = HEADER_MAP[cleaned];
  if (!mapped) {
    throw new Error(
      `loadSesnsp: unknown SESNSP column "${raw}" (normalized "${cleaned}"). HEADER_MAP needs an entry.`,
    );
  }
  return mapped;
}

export interface RnidVariant {
  /** Filename inside the zip (and the zip stem). */
  basename: string;
  /** Granularity. */
  level: "estatal" | "municipal";
  /** What's being counted. */
  metric: "delitos" | "victimas";
  /** Postgres table name for the raw load. */
  rawTable: string;
  /** Postgres materialized view name for the unpivoted long form. */
  longView: string;
  /** Whether the source has cve_municipio/municipio columns. */
  hasMunicipio: boolean;
  /** Whether the source has sexo/rango_edad columns (Víctimas only). */
  hasDemographics: boolean;
}

function ddlForVariant(v: RnidVariant): string {
  const muniCols = v.hasMunicipio
    ? "  cve_municipio TEXT,\n  municipio TEXT,\n"
    : "";
  const demoCols = v.hasDemographics
    ? "  sexo TEXT,\n  rango_edad TEXT,\n"
    : "";
  return `
DROP TABLE IF EXISTS ${v.rawTable} CASCADE;
CREATE TABLE ${v.rawTable} (
  ano TEXT,
  cve_ent TEXT,
  entidad TEXT,
${muniCols}  bien_juridico TEXT,
  tipo_delito TEXT,
  subtipo_delito TEXT,
  modalidad TEXT,
${demoCols}  enero TEXT, febrero TEXT, marzo TEXT, abril TEXT,
  mayo TEXT, junio TEXT, julio TEXT, agosto TEXT,
  septiembre TEXT, octubre TEXT, noviembre TEXT, diciembre TEXT
);
`;
}

/**
 * Produces a `MATERIALIZED VIEW` that unpivots the 12 monthly columns into
 * (ano, mes, cve_mun?, ..., count). NULLIF strips empty-string sentinels so
 * the int cast succeeds. cve_mun is built as LPAD(cve_municipio, 5, '0')
 * because SESNSP encodes ENT(1-2 digits)+MUN(3 digits) without zero-padding
 * the entidad — i.e. AGS municipio 001 ships as `1001` not `01001`. DENUE's
 * area_geo is 5-char zero-padded; LPAD aligns them.
 */
function longViewSql(v: RnidVariant): string {
  const muniSelect = v.hasMunicipio
    ? "  LPAD(cve_municipio, 5, '0')                     AS cve_mun,\n  municipio                                      AS municipio_nombre,\n"
    : "";
  const demoSelect = v.hasDemographics ? "  sexo,\n  rango_edad,\n" : "";
  return `
DROP MATERIALIZED VIEW IF EXISTS ${v.longView} CASCADE;
CREATE MATERIALIZED VIEW ${v.longView} AS
SELECT
  NULLIF(ano, '')::int                              AS ano,
  cve_ent,
  entidad                                           AS entidad_nombre,
${muniSelect}  bien_juridico,
  tipo_delito,
  subtipo_delito,
  modalidad,
${demoSelect}  m.mes::int                                        AS mes,
  NULLIF(m.count_text, '')::int                     AS count
FROM ${v.rawTable} r
CROSS JOIN LATERAL (VALUES
  (1,  r.enero),      (2,  r.febrero),  (3,  r.marzo),
  (4,  r.abril),      (5,  r.mayo),     (6,  r.junio),
  (7,  r.julio),      (8,  r.agosto),   (9,  r.septiembre),
  (10, r.octubre),    (11, r.noviembre),(12, r.diciembre)
) AS m(mes, count_text)
WHERE NULLIF(m.count_text, '') IS NOT NULL;
${
  v.hasMunicipio
    ? `
DROP INDEX IF EXISTS idx_${v.longView}_cve_mun;
CREATE INDEX idx_${v.longView}_cve_mun ON ${v.longView} (cve_mun);
`
    : ""
}
DROP INDEX IF EXISTS idx_${v.longView}_ano_mes;
CREATE INDEX idx_${v.longView}_ano_mes ON ${v.longView} (ano, mes);

DROP INDEX IF EXISTS idx_${v.longView}_subtipo;
CREATE INDEX idx_${v.longView}_subtipo ON ${v.longView} (subtipo_delito);
`;
}

/**
 * Only Municipal Delitos is currently used by the analyzer. The Estatal
 * variant is redundant (we can re-aggregate from municipal at query time);
 * Víctimas would only matter if we surfaced demographic-segmented analysis,
 * which isn't on the roadmap. Keeping the schema flags + DDL/MV scaffolding
 * around in this file so re-enabling a variant is a single-entry change here.
 */
export const RNID_VARIANTS: readonly RnidVariant[] = [
  {
    basename: "RNID-Delitos_Municipal",
    level: "municipal",
    metric: "delitos",
    rawTable: "sesnsp_delitos_municipal_raw",
    longView: "sesnsp_delitos_municipal",
    hasMunicipio: true,
    hasDemographics: false,
  },
];

export interface LoadSesnspConfig {
  rnidDir: string;
  dbContainer: string;
}

export interface LoadSesnspResult {
  variants: Array<{
    basename: string;
    raw_rows: number;
    long_rows: number;
  }>;
  duration_ms: number;
}

function dockerExec(
  container: string,
  args: string[],
  timeoutMs: number,
): string {
  return execFileSync("docker", ["exec", container, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
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
 * Source of CSV bytes for a single variant load. Either a ZIP that contains
 * one CSV (the canonical RNID-2026 single-year files) or a bare CSV (the
 * historical 2015-2025 dump that ships pre-extracted, ~362 MB).
 */
export type RnidInput =
  | { kind: "zip"; zipPath: string; csvInside: string }
  | { kind: "csv"; csvPath: string };

/**
 * Extract a CSV from a ZIP, iconv WINDOWS-1252 → UTF-8, rewrite header to
 * snake_case ASCII identifiers, and write the result to a temp file. Returns
 * the temp path. Caller is responsible for deletion.
 *
 * The body is streamed through a shell pipeline directly into the output
 * file rather than buffered in Node — the 362 MB historical CSV would peak
 * around 800 MB of V8 string heap if we held it as a JS string. The header
 * is read in a separate small `head -1` invocation so we still get the
 * snake_case rewrite.
 */
function preparePreparedCsv(input: RnidInput, outDir: string): string {
  const sourceLabel =
    input.kind === "zip"
      ? `${input.zipPath}!${input.csvInside}`
      : input.csvPath;

  // Build the source-bytes shell snippet once; both header and body
  // pipelines reuse it so a future tweak (e.g. a `dos2unix` step) only
  // happens in one place.
  const sourceCmd =
    input.kind === "zip" ? `unzip -p "$ZIP" "$INNER"` : `cat "$CSV"`;

  const sourceEnv: NodeJS.ProcessEnv =
    input.kind === "zip"
      ? { ZIP: input.zipPath, INNER: input.csvInside }
      : { CSV: input.csvPath };

  // Step 1: read just the first line. iconv ensures any accented header
  // characters land in the same encoding the body will be in.
  const headerOut = execFileSync(
    "/bin/sh",
    ["-c", `${sourceCmd} | iconv -f WINDOWS-1252 -t UTF-8 | head -1`],
    {
      encoding: "utf-8",
      env: { ...process.env, ...sourceEnv },
      timeout: 60_000,
    },
  );
  const headerLine = headerOut.replace(/\r?\n.*/s, "").replace(/^﻿/, "");
  if (headerLine.length === 0) {
    throw new Error(`loadSesnsp: ${sourceLabel} has empty header`);
  }
  const headers = headerLine.split(",").map((h) => normalizeHeader(h));
  const rewrittenHeader = headers.join(",");

  // Step 2: stream the body straight into the output file. `tail -n +2`
  // drops the original header (we replace it with the rewritten one). `tr
  // -d '\r'` normalizes CRLF → LF — Postgres COPY rejects mid-stream
  // ending changes which is what'd happen otherwise (header rewritten as
  // pure-LF, body still CRLF). Header is prepended via `printf` so the
  // file's first byte is always the new header.
  const outPath = join(
    outDir,
    sourceLabel
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .replace(/\.csv$/, "")
      .slice(-160) + ".prep.csv",
  );
  execFileSync(
    "/bin/sh",
    [
      "-c",
      `{ printf '%s\\n' "$HEADER"; ${sourceCmd} | iconv -f WINDOWS-1252 -t UTF-8 | tail -n +2 | tr -d '\\r'; } > "$OUT"`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ...sourceEnv,
        HEADER: rewrittenHeader,
        OUT: outPath,
      },
      timeout: 30 * 60_000,
    },
  );
  return outPath;
}

export async function loadSesnsp(
  config: LoadSesnspConfig,
): Promise<LoadSesnspResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadSesnsp: dbContainer inválido "${config.dbContainer}".`,
    );
  }
  assertSafePath("rnidDir", config.rnidDir);

  const started = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), "sesnsp-load-"));
  const out: LoadSesnspResult["variants"] = [];

  try {
    for (const variant of RNID_VARIANTS) {
      // Find every input matching the variant basename — could be one
      // (the canonical 2026 single-year case) or several (zip + historical
      // CSV for Delitos_Municipal). All must share the same schema; the
      // loader trusts the variant flags and lets `\copy` fail loudly if a
      // column count drifts.
      const inputs = findVariantInputs(config.rnidDir, variant.basename);
      if (inputs.length === 0) {
        throw new Error(
          `loadSesnsp: no input file in ${config.rnidDir} matches "${variant.basename}".`,
        );
      }

      // Step 1: build raw table (DROP+CREATE) — once per variant before any
      // \copy lands. Subsequent inputs append to the same table.
      dockerExec(
        config.dbContainer,
        [
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          ddlForVariant(variant),
        ],
        60_000,
      );

      // Step 2: prepare + \copy each input into the raw table.
      for (let i = 0; i < inputs.length; i++) {
        const preparedPath = preparePreparedCsv(inputs[i]!, tempDir);
        const containerPath = `/tmp/${variant.rawTable}_${i}.csv`;
        dockerCp(config.dbContainer, preparedPath, containerPath, 10 * 60_000);
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
              `\\copy ${variant.rawTable} FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
            ],
            30 * 60_000,
          );
        } finally {
          try {
            dockerExec(config.dbContainer, ["rm", "-f", containerPath], 30_000);
          } catch {
            // best-effort
          }
        }
      }

      // Step 4: build the long-format MV.
      dockerExec(
        config.dbContainer,
        [
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          longViewSql(variant),
        ],
        5 * 60_000,
      );

      // Step 5: counts.
      const cnt = (sql: string): number => {
        const r = dockerExec(
          config.dbContainer,
          ["psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
          60_000,
        ).trim();
        const n = parseInt(r, 10);
        if (!Number.isFinite(n)) {
          throw new Error(
            `loadSesnsp: unexpected count for ${variant.basename}: "${r}"`,
          );
        }
        return n;
      };
      out.push({
        basename: variant.basename,
        raw_rows: cnt(`SELECT COUNT(*) FROM ${variant.rawTable};`),
        long_rows: cnt(`SELECT COUNT(*) FROM ${variant.longView};`),
      });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return { variants: out, duration_ms: Date.now() - started };
}

/**
 * Read the zip's index and return the first .csv entry. SESNSP zips ship one
 * CSV per archive; if that ever changes we'll trip a clear error here rather
 * than silently picking the wrong file.
 */
export function listFirstCsvInZip(zipPath: string): string {
  const out = execFileSync("unzip", ["-l", zipPath], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  // unzip -l prints `  size  date  time  name` with extra header/footer rows.
  // Pull anything that ends in .csv.
  const matches = out
    .split("\n")
    .map((s) => s.trim())
    .map((s) => s.match(/\s(\S+\.csv)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1] as string);
  if (matches.length === 0) {
    throw new Error(`loadSesnsp: no .csv inside ${zipPath}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `loadSesnsp: ${zipPath} has multiple CSVs: ${matches.join(", ")}. Loader expects one.`,
    );
  }
  return matches[0] as string;
}

/**
 * Return every input file in `dir` whose name starts with `basename` and
 * is either a `.zip` or a `.csv`. Multiple inputs per variant are supported
 * for the historical-plus-current case (RNID-Delitos_Municipal-2026-mar2026.zip
 * + RNID-Delitos_Municipal-Historical-2015-2025.csv → loader unions them
 * into one raw table). Inputs are sorted alphabetically so the load order
 * is deterministic and the historical file lands before the current one
 * (lexically "Historical" < "20XX-mar20XX").
 *
 * Inner-CSV name for ZIPs is resolved via `listFirstCsvInZip` to handle the
 * Víctimas zips' accented inner filename (`RNID-Víctimas_…csv` inside a zip
 * named `RNID-Victimas_…zip`).
 */
export function findVariantInputs(dir: string, basename: string): RnidInput[] {
  const out = execFileSync(
    "/bin/sh",
    [
      "-c",
      // List both .zip and .csv files matching the prefix. `ls` returns 1
      // when nothing matches but we tolerate that with `|| true`.
      `cd "$1" && (ls *.zip *.csv 2>/dev/null || true)`,
      "sh",
      dir,
    ],
    { encoding: "utf-8", timeout: 10_000 },
  );
  const matches = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((name) => name.startsWith(basename))
    .sort();

  return matches.map<RnidInput>((name) => {
    const fullPath = join(dir, name);
    if (name.endsWith(".zip")) {
      return {
        kind: "zip",
        zipPath: fullPath,
        csvInside: listFirstCsvInZip(fullPath),
      };
    }
    return { kind: "csv", csvPath: fullPath };
  });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const rnidDir = getArg("rnid-dir") ?? "raw/sesnsp";
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-sesnsp] loading ${RNID_VARIANTS.length} variant(s) from ${rnidDir} ...`,
  );
  loadSesnsp({ rnidDir, dbContainer })
    .then((r) => {
      for (const v of r.variants) {
        console.log(
          `[load-sesnsp] ✓ ${v.basename}: raw=${v.raw_rows.toLocaleString()} long=${v.long_rows.toLocaleString()}`,
        );
      }
      console.log(
        `[load-sesnsp] done in ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-sesnsp] ✗ ${msg}`);
      process.exit(1);
    });
}
