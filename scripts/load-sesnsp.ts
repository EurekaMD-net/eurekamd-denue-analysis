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
 *   - RNID-Delitos_Estatal-YYYY-<mes>YYYY.zip
 *   - RNID-Delitos_Municipal-YYYY-<mes>YYYY.zip
 *   - RNID-Victimas_Estatal-YYYY-<mes>YYYY.zip
 *   - RNID-Victimas_Municipal-YYYY-<mes>YYYY.zip
 *   (<mes> ∈ ene feb mar abr may jun jul ago sep oct nov dic, lowercase)
 *
 * The encoding is detected per input: files up to mar2026 and the
 * historical CSV are WINDOWS-1252, the SharePoint-era ago2026 file is UTF-8
 * with BOM. Spanish accents appear in headers AND values (`Año`, `Bien
 * jurídico afectado`, etc.). Loader iconv's WINDOWS-1252 inputs to UTF-8 +
 * rewrites the header to snake_case ASCII identifiers before \copy.
 *
 * Month cutoff: the ZIP name's `<mes>YYYY` is the last published month.
 * Later months may ship as `0` (ago2026) instead of empty (mar2026); the
 * reload asserts they carry no data and blanks them so the long MV never
 * gets fake zero-crime months.
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
 * Idempotent: rerun freely. ZIPs are the boundary of trust. Each variant
 * reloads in ONE psql transaction (\copy into <raw>_staging, explicit
 * no-CASCADE drop of the long MV + its analytics dependents, swap, rebuild)
 * so a failed load changes nothing and never orphans
 * mv_delitos_municipal_yearly (audit #144).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  assertIdent,
  assertRelationsExist,
  perfMatviewSql,
  postLoadGrants,
  runPsqlScript,
} from "./_psql-tx.js";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9_.\\/-]+$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/** Reject anything but `--rnid-dir=<dir>` (incl. the `--rnid-dir <dir>` space form). */
export function assertCliArgs(args: readonly string[]): void {
  for (const a of args) {
    if (!a.startsWith("--rnid-dir=")) {
      throw new Error(`unknown argument "${a}"; expected --rnid-dir=<dir>`);
    }
  }
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

function ddlForVariant(v: RnidVariant, table: string): string {
  const muniCols = v.hasMunicipio
    ? "  cve_municipio TEXT,\n  municipio TEXT,\n"
    : "";
  const demoCols = v.hasDemographics
    ? "  sexo TEXT,\n  rango_edad TEXT,\n"
    : "";
  return `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
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
DROP MATERIALIZED VIEW IF EXISTS ${v.longView};
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

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const ZIP_NAME_RE =
  /^[A-Za-z0-9_-]+-(\d{4})-(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\1\.zip$/;

/**
 * Last published month from a canonical `RNID-<Metric>_<Level>-YYYY-<mes>YYYY.zip`
 * name, or null for a non-ZIP input (the historical CSV). Throws for a ZIP
 * that doesn't match: a misnamed file must not load without its cutoff.
 */
export function throughFromZipName(
  name: string,
): { ano: number; mes: number } | null {
  if (!name.endsWith(".zip")) return null;
  const m = ZIP_NAME_RE.exec(name);
  if (!m) {
    throw new Error(
      `loadSesnsp: ${name} does not match RNID-<Metric>_<Level>-YYYY-<mes>YYYY.zip; rename it so the month cutoff is known.`,
    );
  }
  const abbrs = MONTHS.map((mo) => mo.slice(0, 3));
  return { ano: Number(m[1]), mes: abbrs.indexOf(m[2] as string) + 1 };
}

export interface ZipCutoff {
  label: string;
  ano: number;
  mes: number;
}

/**
 * True for a month cell that carries data: anything but NULL (an empty CSV
 * cell under COPY), '' or '0'.
 */
export function monthHasDataSql(col: string): string {
  return `COALESCE(${col}, '') NOT IN ('', '0')`;
}

/**
 * SQL that enforces a ZIP's month cutoff on `table` (rows of year `ano`):
 * the assert fails the transaction when the year is absent or any month
 * after `mes` carries data (monthHasDataSql); the update blanks those
 * months (NULL, same as an empty CSV cell under COPY) so the long MV skips
 * them, touching only rows that still hold a non-NULL value. For `mes` 12
 * only the year-present check remains and `updateSql` is null.
 */
export function cutoffSql(
  table: string,
  label: string,
  ano: number,
  mes: number,
): { assertSql: string; updateSql: string | null } {
  assertIdent(table);
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) {
    throw new Error(`loadSesnsp: unsafe cutoff label "${label}"`);
  }
  const after = MONTHS.slice(mes);
  const through = `${ano}-${String(mes).padStart(2, "0")}`;
  const afterCheck =
    after.length === 0
      ? ""
      : `
  SELECT count(*) INTO n FROM ${table} WHERE ano = '${ano}' AND (
    ${after.map(monthHasDataSql).join("\n    OR ")}
  );
  IF n > 0 THEN
    RAISE EXCEPTION 'loadSesnsp: ${label} carries data after ${through} (% rows); rename the file or check the source', n;
  END IF;`;
  const assertSql = `DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM ${table} WHERE ano = '${ano}';
  IF n = 0 THEN
    RAISE EXCEPTION 'loadSesnsp: ${label} has no rows with ano = ${ano}; wrong file?';
  END IF;${afterCheck}
END $$;`;
  const updateSql =
    after.length === 0
      ? null
      : `UPDATE ${table} SET ${after.map((c) => `${c} = NULL`).join(", ")} WHERE ano = '${ano}' AND (${after.map((c) => `${c} IS NOT NULL`).join(" OR ")});`;
  return { assertSql, updateSql };
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

/**
 * perf-matviews.sql MVs built on top of each long view. The swap drops them
 * explicitly (no CASCADE) and rebuilds them in the same transaction.
 */
export const LONG_VIEW_DEPENDENTS: Readonly<Record<string, readonly string[]>> =
  {
    sesnsp_delitos_municipal: ["mv_delitos_municipal_yearly"],
  };

/**
 * The single-transaction reload script for one variant: \copy every staged
 * input into `<raw>_staging`, enforce each ZIP's month cutoff on staging,
 * drop the long MV + its dependents explicitly
 * (an unknown dependent makes DROP TABLE fail → whole load rolls back),
 * swap staging in, rebuild long MV + dependents, re-apply grants.
 */
export function buildVariantReloadSql(
  v: RnidVariant,
  containerPaths: readonly string[],
  cutoffs: readonly ZipCutoff[] = [],
): string {
  const staging = `${v.rawTable}_staging`;
  const dependents = LONG_VIEW_DEPENDENTS[v.longView] ?? [];
  return [
    ddlForVariant(v, staging),
    ...containerPaths.map(
      (p) => `\\copy ${staging} FROM '${p}' WITH (FORMAT csv, HEADER true)`,
    ),
    ...cutoffs.flatMap((c) => {
      const sql = cutoffSql(staging, c.label, c.ano, c.mes);
      return sql.updateSql ? [sql.assertSql, sql.updateSql] : [sql.assertSql];
    }),
    ...dependents.map((d) => `DROP MATERIALIZED VIEW IF EXISTS ${d};`),
    `DROP MATERIALIZED VIEW IF EXISTS ${v.longView};`,
    `DROP TABLE IF EXISTS ${v.rawTable};`,
    `ALTER TABLE ${staging} RENAME TO ${v.rawTable};`,
    longViewSql(v),
    ...dependents.map((d) => perfMatviewSql(d)),
    postLoadGrants([v.rawTable, v.longView, ...dependents]),
  ].join("\n");
}

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
 * UTF-8 or WINDOWS-1252 for one input: the first 4 MB (minus its last,
 * possibly cut, line — a split multi-byte char would fail iconv) must pass
 * `iconv -f UTF-8`. The source runs as `{ … || true; }` so the SIGPIPE it
 * gets when `head -c` stops reading can't fail the pipefail pipeline; that
 * also hides a missing/corrupt input, so an empty sample (which iconv would
 * accept as UTF-8) throws instead. The sample is written to `sampleDir`.
 */
export function detectEncoding(
  sourceCmd: string,
  sourceEnv: NodeJS.ProcessEnv,
  label: string,
  sampleDir: string,
): "utf-8" | "windows-1252" {
  const out = execFileSync(
    "/bin/bash",
    [
      "-o",
      "pipefail",
      "-c",
      `set -e
{ ${sourceCmd} 2>/dev/null || true; } | head -c 4194304 | head -n -1 > "$SAMPLE"
if [ ! -s "$SAMPLE" ]; then v=empty; elif iconv -f UTF-8 -t UTF-8 < "$SAMPLE" >/dev/null 2>&1; then v=utf-8; else v=windows-1252; fi
rm -f "$SAMPLE"
echo "$v"`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        ...sourceEnv,
        SAMPLE: join(sampleDir, "encoding-probe.sample"),
      },
      timeout: 60_000,
    },
  ).trim();
  if (out === "empty") {
    throw new Error(
      `loadSesnsp: ${label}: empty or unreadable sample (missing/corrupt input?)`,
    );
  }
  if (out !== "utf-8" && out !== "windows-1252") {
    throw new Error(`loadSesnsp: unexpected encoding probe output "${out}"`);
  }
  return out;
}

/**
 * Extract a CSV from a ZIP, iconv WINDOWS-1252 → UTF-8 (UTF-8 inputs pass
 * through), rewrite header to
 * snake_case ASCII identifiers, and write the result to a temp file. Returns
 * the temp path. Caller is responsible for deletion.
 *
 * The body is streamed through a shell pipeline directly into the output
 * file rather than buffered in Node — the 362 MB historical CSV would peak
 * around 800 MB of V8 string heap if we held it as a JS string. The header
 * is read in a separate small `head -1` invocation so we still get the
 * snake_case rewrite.
 */
export function preparePreparedCsv(input: RnidInput, outDir: string): string {
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

  const encoding = detectEncoding(sourceCmd, sourceEnv, sourceLabel, outDir);
  console.log(`[load-sesnsp] ${sourceLabel}: encoding=${encoding}`);
  const decode =
    encoding === "utf-8" ? "" : " | iconv -f WINDOWS-1252 -t UTF-8";

  // Step 1: read just the first line. iconv ensures any accented header
  // characters land in the same encoding the body will be in.
  const headerOut = execFileSync(
    "/bin/sh",
    ["-c", `${sourceCmd}${decode} | head -1`],
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
  // Load-bearing guard against a wrong encoding verdict: a mis-decoded `Año`
  // (e.g. `AÃ±o`) is not in HEADER_MAP, so normalizeHeader throws.
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
  // bash with pipefail (audit #149): under /bin/sh the pipeline's status is
  // only tr's, so an unzip/iconv failure mid-stream exited 0 and \copy loaded
  // a silently truncated file.
  execFileSync(
    "/bin/bash",
    [
      "-o",
      "pipefail",
      "-c",
      `{ printf '%s\\n' "$HEADER"; ${sourceCmd}${decode} | tail -n +2 | tr -d '\\r'; } > "$OUT"`,
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

  // Belt and braces for #149: the prepared file must carry exactly as many
  // lines as the source (the header is swapped 1:1, iconv and `tr -d '\r'`
  // never add or drop a newline).
  const countLines = (script: string, env: NodeJS.ProcessEnv): number =>
    Number(
      execFileSync("/bin/bash", ["-o", "pipefail", "-c", script], {
        encoding: "utf-8",
        env: { ...process.env, ...env },
        timeout: 30 * 60_000,
      }).trim(),
    );
  const sourceLines = countLines(`${sourceCmd} | wc -l`, sourceEnv);
  const preparedLines = countLines(`wc -l < "$OUT"`, { OUT: outPath });
  if (sourceLines !== preparedLines) {
    throw new Error(
      `loadSesnsp: prepared ${sourceLabel} has ${preparedLines} lines, source has ${sourceLines} (truncated prep)`,
    );
  }
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
      // Month cutoffs up front, so a misnamed ZIP fails before any prep.
      const cutoffs = inputs.flatMap<ZipCutoff>((input) => {
        if (input.kind !== "zip") return [];
        const label = basename(input.zipPath);
        const through = throughFromZipName(label);
        return through ? [{ label, ...through }] : [];
      });
      for (const c of cutoffs) {
        console.log(
          `[load-sesnsp] ${c.label}: through=${c.ano}-${String(c.mes).padStart(2, "0")}, later months must be empty/0 and are blanked`,
        );
      }

      // Step 1: prepare + stage every input inside the container.
      const containerPaths: string[] = [];
      try {
        for (let i = 0; i < inputs.length; i++) {
          const preparedPath = preparePreparedCsv(inputs[i]!, tempDir);
          const containerPath = `/tmp/${variant.rawTable}_${i}.csv`;
          dockerCp(config.dbContainer, preparedPath, containerPath, 10 * 60_000);
          containerPaths.push(containerPath);
        }

        // Step 2: ONE transaction — \copy into staging, swap, rebuild the
        // long-format MV and the analytics MVs that read it.
        const psqlOut = runPsqlScript(
          config.dbContainer,
          buildVariantReloadSql(variant, containerPaths, cutoffs),
          (inputs.length + 1) * 30 * 60_000,
        );
        for (const line of psqlOut.match(/^UPDATE \d+$/gm) ?? []) {
          console.log(`[load-sesnsp] ${variant.basename} cutoff: ${line}`);
        }
      } finally {
        for (const containerPath of containerPaths) {
          try {
            dockerExec(config.dbContainer, ["rm", "-f", containerPath], 30_000);
          } catch {
            // best-effort
          }
        }
      }

      // Step 3: counts.
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
  assertRelationsExist(config.dbContainer);

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
 * is deterministic; the historical file lands after the current one
 * (lexically "20XX-mar20XX" < "Historical", '2' < 'H').
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
  try {
    assertCliArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`[load-sesnsp] ✗ ${(err as Error).message}`);
    process.exit(1);
  }
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
      console.log(
        `[load-sesnsp] reminder: refresh analytics mat-views: scripts/refresh-matviews.sh`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-sesnsp] ✗ ${msg}`);
      process.exit(1);
    });
}
