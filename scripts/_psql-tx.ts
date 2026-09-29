/**
 * Shared helpers for loaders that replace a raw table other relations
 * depend on (audit #144, 2026-09-26).
 *
 * The old loaders ran `DROP TABLE <raw> CASCADE` in one psql session and
 * `\copy` in another. CASCADE silently took every dependent view / MV with
 * it (mv_national_treemap, mv_sector_grade_matrix, mv_delitos_municipal_yearly,
 * mv_mortalidad_municipal_yearly, censo_entidades, censo_localidades) and
 * nothing recreated them. The pattern these helpers support instead:
 *
 *   1. `\copy` into `<raw>_staging` (no lock on anything live yet).
 *   2. Drop the known dependents EXPLICITLY, without CASCADE, so an unknown
 *      dependent makes the DROP TABLE fail instead of vanishing.
 *   3. Swap the staging table in (`ALTER TABLE ... RENAME`).
 *   4. Recreate every dependent from its canonical DDL (perf-matviews.sql,
 *      migrate-censo-views.sql) and re-apply grants.
 *
 * All of it runs as ONE psql script under `--single-transaction` +
 * `ON_ERROR_STOP=1`: any failure rolls back to the previous state, so a
 * reload either fully lands or changes nothing.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeContainer } from "../src/api/handlers/_safe-container.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function readScriptFile(name: string): string {
  return readFileSync(join(SCRIPTS_DIR, name), "utf-8");
}

export function assertIdent(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`_psql-tx: unsafe relation name "${name}"`);
  }
}

/**
 * Pipe `script` into ONE psql session as a single transaction. Any error
 * (including a failed `\copy`) stops the script and rolls everything back.
 * A Buffer script can carry `\copy ... FROM STDIN` data inline (see
 * copyFromStdinScript).
 */
export function runPsqlScript(
  container: string,
  script: string | Buffer,
  timeoutMs: number,
): string {
  assertSafeContainer(container);
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--single-transaction",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-f",
      "-",
    ],
    {
      input: script,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
}

/**
 * A psql script that runs `prelude` (e.g. `TRUNCATE <raw>;`) and then
 * `\copy ... FROM STDIN` with `csv` inline, ended by the `\.` marker
 * (audit #146). Piped through runPsqlScript it is one transaction, so a
 * failed copy rolls the TRUNCATE back instead of committing an empty table.
 */
export function copyFromStdinScript(
  prelude: string,
  copyCmd: string,
  csv: Buffer,
): Buffer {
  if (!/^\\copy [^\n]* FROM STDIN\b[^\n]*$/.test(copyCmd)) {
    throw new Error("_psql-tx: copyCmd must be a one-line \\copy ... FROM STDIN");
  }
  // The `\.` end-of-data marker must start its own line and end with the
  // data's newline style: CSV COPY fixes the style from the first line, so
  // after CRLF rows (the SNIIV CSVs) a bare `\.\n` fails with "unquoted
  // newline found in data" and the load rolls back (2026-09-28).
  const firstNl = csv.indexOf(0x0a);
  const eol = firstNl > 0 && csv[firstNl - 1] === 0x0d ? "\r\n" : "\n";
  const sep = csv.length === 0 || csv[csv.length - 1] === 0x0a ? "" : eol;
  return Buffer.concat([
    Buffer.from(`${prelude}\n${copyCmd}\n`, "utf-8"),
    csv,
    Buffer.from(`${sep}\\.${eol}`, "utf-8"),
  ]);
}

/**
 * Rows in `table`, or 0 when the relation does not exist (audit #157). Only
 * a NULL `to_regclass` means "absent": a COUNT timeout, lock wait or docker
 * error is rethrown, so a populated-table guard can never mistake a failed
 * probe for an empty table and go on to replace it.
 */
export function existingRowCount(container: string, table: string): number {
  assertSafeContainer(container);
  assertIdent(table);
  const psql = (sql: string): string =>
    execFileSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
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
  const exists = psql(`SELECT to_regclass('${table}') IS NOT NULL;`);
  if (exists === "f") return 0;
  if (exists !== "t") {
    throw new Error(`_psql-tx: unexpected to_regclass output "${exists}"`);
  }
  const out = psql(`SELECT COUNT(*) FROM ${table};`);
  const n = Number.parseInt(out, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`_psql-tx: unexpected COUNT output "${out}" for ${table}`);
  }
  return n;
}

/**
 * Swap `<table>_staging` in for `<table>`: drop the listed dependents
 * first (explicitly, no CASCADE — an unknown dependent makes DROP TABLE
 * fail and the transaction roll back), then the old table, then rename.
 * Emit inside a runPsqlScript transaction, after the staging \copy.
 */
export function swapInStagingSql(
  table: string,
  dropDependents: readonly string[],
): string {
  assertIdent(table);
  return [
    ...dropDependents,
    `DROP TABLE IF EXISTS ${table};`,
    `ALTER TABLE ${table}_staging RENAME TO ${table};`,
  ].join("\n");
}

/** MVs the nightly refresh sweeps — parsed from the script so the lists can't drift. */
export function refreshedMatviews(): string[] {
  const sh = readScriptFile("refresh-matviews.sh");
  const names = [
    ...sh.matchAll(
      /REFRESH MATERIALIZED VIEW (?:CONCURRENTLY )?([a-z_][a-z0-9_]*)/g,
    ),
  ].map((m) => m[1] as string);
  return [...new Set(names)];
}

/** Views read by analytics + Sage that only migrate-censo-views.sql defines. */
export const CENSO_VIEWS = [
  "censo_municipios",
  "censo_entidades",
  "censo_localidades",
  "municipios_2025",
] as const;

/**
 * EIC 2025 municipal views, defined only in migrate-eic2025-views.sql and
 * recreated by load-eic2025.ts (drop order = reverse: the parity view reads
 * eic_2025_municipio). They read eic_2025_municipio_raw only, never a
 * CENSO_VIEWS relation, so a Censo reload never has to drop them. Not part
 * of assertRelationsExist's default list: other loaders must not fail on a
 * database where EIC is not loaded yet.
 */
export const EIC_VIEWS = [
  "eic_2025_municipio",
  "eic_2025_municipio_moe",
  "eic_2025_municipio_censo_parity",
] as const;

/**
 * Fail loud when any analytics MV / view is missing after a load. The MV
 * handlers silently fall back to live aggregation (100x slower) and the
 * censo_localidades consumers error outright, so a missing relation must
 * surface as a non-zero loader exit, not as a slow dashboard days later.
 */
export function assertRelationsExist(
  container: string,
  names: readonly string[] = [...refreshedMatviews(), ...CENSO_VIEWS],
): void {
  assertSafeContainer(container);
  for (const n of names) assertIdent(n);
  const list = names.map((n) => `'${n}'`).join(",");
  const out = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      `SELECT n FROM unnest(ARRAY[${list}]::text[]) AS n WHERE to_regclass(n) IS NULL ORDER BY n;`,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );
  const missing = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (missing.length > 0) {
    throw new Error(
      `relations missing after load: ${missing.join(", ")}. Recreate them from scripts/perf-matviews.sql / scripts/migrate-censo-views.sql before trusting analytics.`,
    );
  }
}

/**
 * The perf-matviews.sql section that builds one MV: from its
 * `DROP MATERIALIZED VIEW IF EXISTS <name>` up to the next `-- ====` rule
 * (or EOF). Includes the MV's indexes, so the rebuilt MV can still be
 * refreshed CONCURRENTLY.
 */
export function perfMatviewSql(name: string): string {
  assertIdent(name);
  const sql = readScriptFile("perf-matviews.sql");
  const start = sql.search(
    new RegExp(`^DROP MATERIALIZED VIEW IF EXISTS ${name}\\b`, "m"),
  );
  if (start === -1) {
    throw new Error(`_psql-tx: ${name} is not defined in perf-matviews.sql`);
  }
  const rest = sql.slice(start);
  const end = rest.search(/^-- =====/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * migrate-censo-views.sql verbatim: censo_municipios, censo_localidades,
 * censo_entidades, municipio_bridge_2025 (seed upsert) and municipios_2025.
 */
export function censoViewsSql(): string {
  return readScriptFile("migrate-censo-views.sql");
}

/** Relations sage-role.sql allowlists for denue_sage. */
function sageAllowlist(): Set<string> {
  const sql = readScriptFile("sage-role.sql");
  return new Set(
    // `^\s*` also counts the existence-guarded GRANT inside a DO block
    // (osm_ageb_aggregates).
    [...sql.matchAll(/^\s*GRANT SELECT ON\s+([a-z_][a-z0-9_]*)\s+TO denue_sage;/gm)].map(
      (m) => m[1] as string,
    ),
  );
}

/**
 * Grants for relations the load (re)created: a recreated relation inherits
 * the schema's default privileges, so strip them (P02 hygiene) and restore
 * the denue_sage SELECT when sage-role.sql allowlists the relation. With
 * `schema`, every statement names `schema.relation` (allowlist match stays on
 * the bare name).
 */
export function postLoadGrants(
  relations: readonly string[],
  schema?: string,
): string {
  const sage = sageAllowlist();
  if (schema !== undefined) assertIdent(schema);
  return relations
    .map((r) => {
      assertIdent(r);
      const q = schema === undefined ? r : `${schema}.${r}`;
      const lines = [`REVOKE ALL ON ${q} FROM anon, authenticated, trustr_app;`];
      if (sage.has(r)) lines.push(`GRANT SELECT ON ${q} TO denue_sage;`);
      return lines.join("\n");
    })
    .join("\n");
}
