/**
 * CLI: load INEGI Marco Geoestadístico 2025 municipio + AGEB polygons
 * ALONGSIDE the MG 2020 tables (step 3 of the municipio bridge ruling,
 * docs/MG-2025-LOAD-BRIEF-2026-09-28.md). Never touches `mun_polygons` /
 * `ageb_polygons`: the 2025 layers land in `mun_polygons_2025` and
 * `ageb_polygons_2025`.
 *
 * Usage:
 *   npx tsx scripts/load-mg2025-polygons.ts --dry-run [--zip=<abs path>] [--layers=mun,ageb]
 *   npx tsx scripts/load-mg2025-polygons.ts [--zip=<abs path>] [--layers=mun,ageb] [--force]
 *   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql
 *
 *   --zip      the INEGI bundle 794551163061_s.zip (default
 *              raw/mg2025/794551163061_s.zip); its sha256 is checked first.
 *   --layers   mun, ageb or both (default both, loaded in that order).
 *   --dry-run  runs ogr2ogr through the same filter into a byte counter and
 *              prints the script size, the first 40 lines, the column list,
 *              the row counts and the post-load SQL. No docker, no psql.
 *   --force    required when a target table already exists; it is then
 *              dropped (no CASCADE) and re-created in the same transaction.
 *              The DROP holds ACCESS EXCLUSIVE on the table until COMMIT, so
 *              a --force reload of mun_polygons_2025 blocks every reader for
 *              the whole load window (~1-1.5 min): /analytics/street-geometry
 *              (src/osm/osmium.ts) times out at psql-runner's 25 s
 *              statement_timeout until the COMMIT. Run it in a quiet window.
 *
 * How (ONE psql session, one transaction):
 *   1. `ogr2ogr -f PGDUMP /vsistdout/` reads the national layer straight out
 *      of the nested zip (`/vsizip//vsizip/...`), reprojects the INEGI LCC
 *      (ITRF2008) to EPSG:4326 and promotes to MultiPolygon. PG_USE_COPY
 *      makes the dump a CREATE TABLE + one COPY block. The shapefile driver
 *      recodes the DBF from its `.cpg` (88591 = ISO-8859-1) to UTF-8, which
 *      the in-transaction assertion checks on two accented names.
 *   2. ogr2ogr's stdout is split into lines and piped into psql's stdin (never
 *      buffered whole: the AGEB dump is ~200 MB of text). The filter drops the
 *      dump's own BEGIN;/COMMIT; and refuses any statement that does not name
 *      the target table.
 *   3. Post-steps in the same transaction: ST_MakeValid repair (as migration
 *      019:268), `<t>_cvegeo_uq`, `idx_ageb_polygons_2025_ent_mun`, ANALYZE,
 *      owner / REVOKE / GRANT / COMMENT (mirrored by
 *      scripts/migrations/028-mg2025-polygons-grants.sql), then a DO-block
 *      assertion on counts, keys, geometry type, SRID, validity and encoding.
 *   4. `COMMIT;` is written only after every layer streamed cleanly.
 *
 * Grants after the merge: the loader grants denue_api itself, but
 * scripts/api-role.sql REVOKEs everything from denue_api and re-grants only
 * its own list. Until this branch is merged, main's copy (run by
 * ops/deploy-audit-refactor.sh:102 and the load-censo / load-cofepris hints)
 * lacks the 2025 tables and drops their grant. After the merge and before the
 * service restart, re-run main's api-role.sql (or migration 028) so the grant
 * is proven on main's copy.
 *
 * Why an explicit BEGIN/COMMIT and not `psql --single-transaction`: with
 * `-1`, psql COMMITs whatever it has read when its input ends. A loader that
 * dies mid-stream (killed, OOM, ogr2ogr failure) closes psql's stdin, so a
 * truncated table would be committed. Here the COMMIT is the last line of the
 * stream; an input that ends before it leaves the transaction open and psql's
 * exit rolls it back.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { assertSafeContainer } from "../src/api/handlers/_safe-container.js";
import { assertIdent } from "./_psql-tx.js";

export type Layer = "mun" | "ageb";

export interface LayerSpec {
  layer: Layer;
  /** Shapefile inside mg_2025_integrado.zip/conjunto_de_datos/. */
  shp: string;
  table: string;
  /** The MG 2020 table this edition is loaded next to (never written). */
  legacyTable: string;
  expectedRows: number;
  description: string;
}

export const LAYERS: Readonly<Record<Layer, LayerSpec>> = {
  mun: {
    layer: "mun",
    shp: "00mun.shp",
    table: "mun_polygons_2025",
    legacyTable: "mun_polygons",
    expectedRows: 2478,
    description: "layer 00mun (areas geoestadisticas municipales)",
  },
  ageb: {
    layer: "ageb",
    shp: "00a.shp",
    table: "ageb_polygons_2025",
    legacyTable: "ageb_polygons",
    expectedRows: 82283,
    description: "layer 00a (AGEB urbanas 13-char + rurales 9-char)",
  },
};

/** Fixed load order: municipios first. */
export const LAYER_ORDER: readonly Layer[] = ["mun", "ageb"];

export const AGEB_URBANA_13 = 64808;
export const AGEB_RURAL_9 = 17475;

/** MG 2025 municipios absent from MG 2020 (= municipio_bridge_2025 children). */
export const NEW_MUN_KEYS_2025 = [
  "02007",
  "04013",
  "12082",
  "12083",
  "12084",
  "12085",
  "24059",
  "25019",
  "25020",
] as const;

/** Names that only survive a correct ISO-8859-1 → UTF-8 path. */
export const ENCODING_PROBES: ReadonlyArray<readonly [string, string]> = [
  ["04013", "Dzitbalché"],
  ["12083", "Ñuu Savi"],
];

export const MG2025_UPC = "794551163061";
export const MG2025_ZIP_NAME = "794551163061_s.zip";
/** raw/mg2025/SHA256SUMS */
export const MG2025_ZIP_SHA256 =
  "e87c83c6613026dceaff44c1ac0e949926f6cf055b4522fa16cfa5bb1a594303";
export const DEFAULT_ZIP = `raw/mg2025/${MG2025_ZIP_NAME}`;

const API_ROLE_LINE =
  "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface LoaderArgs {
  zip: string;
  layers: LayerSpec[];
  dryRun: boolean;
  force: boolean;
}

export function parseArgs(argv: readonly string[], cwd = process.cwd()): LoaderArgs {
  let zip = DEFAULT_ZIP;
  let layerList: string | undefined;
  let dryRun = false;
  let force = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--zip=")) zip = arg.slice("--zip=".length);
    else if (arg.startsWith("--layers=")) layerList = arg.slice("--layers=".length);
    else throw new Error(`load-mg2025-polygons: unknown argument "${arg}"`);
  }
  if (zip.length === 0 || zip.startsWith("-")) {
    throw new Error(`load-mg2025-polygons: --zip inválido "${zip}"`);
  }
  const wanted = new Set<string>(
    (layerList ?? LAYER_ORDER.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  for (const l of wanted) {
    if (!(LAYER_ORDER as readonly string[]).includes(l)) {
      throw new Error(`load-mg2025-polygons: unknown layer "${l}" (expected mun, ageb)`);
    }
  }
  if (wanted.size === 0) throw new Error("load-mg2025-polygons: --layers is empty");
  const layers = LAYER_ORDER.filter((l) => wanted.has(l)).map((l) => LAYERS[l]);
  return { zip: resolve(cwd, zip), layers, dryRun, force };
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

export function vsiPath(zip: string, shp: string): string {
  return `/vsizip//vsizip/${zip}/mg_2025_integrado.zip/conjunto_de_datos/${shp}`;
}

export function ogr2ogrArgs(zip: string, spec: LayerSpec): string[] {
  assertIdent(spec.table);
  return [
    "--config",
    "PG_USE_COPY",
    "YES",
    "-f",
    "PGDUMP",
    "/vsistdout/",
    vsiPath(zip, spec.shp),
    "-nln",
    spec.table,
    "-lco",
    "SCHEMA=public",
    "-lco",
    "GEOMETRY_NAME=geom",
    "-lco",
    "FID=ogc_fid",
    "-lco",
    "SPATIAL_INDEX=GIST",
    "-lco",
    "CREATE_SCHEMA=OFF",
    "-lco",
    "DROP_TABLE=OFF",
    "-nlt",
    "PROMOTE_TO_MULTI",
    "-t_srs",
    "EPSG:4326",
  ];
}

/** Session setup + the transaction start + the per-table overwrite guard. */
export function preludeSql(specs: readonly LayerSpec[], force: boolean): string {
  const lines = [
    "SET client_encoding = 'UTF8';",
    "BEGIN;",
    "SET LOCAL statement_timeout = '30min';",
    "SET LOCAL lock_timeout = '10s';",
    // supabase-db has a 64 MB /dev/shm: no parallel workers (AGENT_LEARNINGS 09-28).
    "SET LOCAL max_parallel_workers_per_gather = 0;",
    "SET LOCAL max_parallel_maintenance_workers = 0;",
  ];
  for (const s of specs) {
    assertIdent(s.table);
    if (force) {
      // No CASCADE: an unknown dependent makes the DROP fail and roll back.
      lines.push(`DROP TABLE IF EXISTS public.${s.table};`);
    } else {
      lines.push(
        `DO $$ BEGIN IF to_regclass('public.${s.table}') IS NOT NULL THEN RAISE EXCEPTION 'public.${s.table} already exists; re-run with --force to replace it'; END IF; END $$;`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function tableComment(spec: LayerSpec): string {
  return (
    `INEGI Marco Geoestadístico 2025 (MG 2025, UPC ${MG2025_UPC}, cartographic cut July 2025), ${spec.description}. ` +
    `Source ${MG2025_ZIP_NAME} sha256 ${MG2025_ZIP_SHA256}. ` +
    `Reprojected from MEXICO_ITRF_2008_LCC to EPSG:4326 by ogr2ogr; invalid geometries repaired with ST_MakeValid. ` +
    `Loaded by scripts/load-mg2025-polygons.ts alongside MG 2020 (${spec.legacyTable}), which stays the Censo 2020 edition.`
  );
}

/**
 * Owner, privilege and comment statements for one table. The loader runs
 * them in its transaction; migration 028 carries the same lines verbatim
 * (scripts/load-mg2025-polygons.test.ts pins the match).
 */
export function grantAndCommentStatements(spec: LayerSpec): string[] {
  const t = spec.table;
  assertIdent(t);
  return [
    `ALTER TABLE public.${t} OWNER TO postgres;`,
    `REVOKE ALL ON public.${t} FROM anon, authenticated, trustr_app;`,
    `REVOKE ALL ON SEQUENCE public.${t}_ogc_fid_seq FROM anon, authenticated, trustr_app;`,
    // Sage does not get polygons (sage-role.sql, sql-gate.ts FORBIDDEN_RELATIONS).
    `REVOKE ALL ON public.${t} FROM denue_sage;`,
    // The API reads them as denue_api (scripts/api-role.sql allowlist).
    `GRANT SELECT ON public.${t} TO denue_api;`,
    `COMMENT ON TABLE public.${t} IS '${tableComment(spec).replace(/'/g, "''")}';`,
  ];
}

/** Checks that must hold before COMMIT; any failure raises and rolls back. */
export function assertionSql(spec: LayerSpec): string {
  const t = spec.table;
  assertIdent(t);
  assertIdent(spec.legacyTable);
  const common = `
  SELECT count(*), count(DISTINCT cvegeo), count(*) FILTER (WHERE cvegeo IS NULL),
         count(*) FILTER (WHERE geom IS NULL OR ST_IsEmpty(geom) OR GeometryType(geom) <> 'MULTIPOLYGON'),
         count(*) FILTER (WHERE ST_SRID(geom) <> 4326),
         count(*) FILTER (WHERE NOT ST_IsValid(geom))
    INTO n, d, nulls, badtype, badsrid, invalid
    FROM public.${t};
  IF n <> ${spec.expectedRows} OR d <> ${spec.expectedRows} OR nulls <> 0 THEN
    RAISE EXCEPTION '${t}: % rows / % distinct cvegeo / % NULL, expected ${spec.expectedRows} / ${spec.expectedRows} / 0', n, d, nulls;
  END IF;
  IF badtype <> 0 OR badsrid <> 0 OR invalid <> 0 THEN
    RAISE EXCEPTION '${t}: % non-MULTIPOLYGON or empty, % SRID <> 4326, % invalid after repair', badtype, badsrid, invalid;
  END IF;
  IF Find_SRID('public', '${t}', 'geom') <> 4326 THEN
    RAISE EXCEPTION '${t}: Find_SRID = %, expected 4326', Find_SRID('public', '${t}', 'geom');
  END IF;`;
  if (spec.layer === "mun") {
    const keys = NEW_MUN_KEYS_2025.map((k) => `'${k}'`).join(",");
    const probes = ENCODING_PROBES.map(
      ([cve, name]) =>
        `  IF NOT EXISTS (SELECT 1 FROM public.${t} WHERE cvegeo = '${cve}' AND nomgeo = '${name}') THEN
    RAISE EXCEPTION '${t}: nomgeo of ${cve} is not ''${name}'' (encoding path broken)';
  END IF;`,
    ).join("\n");
    return `DO $$
DECLARE
  n bigint; d bigint; nulls bigint; badtype bigint; badsrid bigint; invalid bigint;
  extra text[]; gone bigint;
BEGIN${common}
  SELECT array_agg(cvegeo ORDER BY cvegeo) INTO extra FROM (
    SELECT cvegeo::text AS cvegeo FROM public.${t}
    EXCEPT SELECT cvegeo::text FROM public.${spec.legacyTable}) s;
  IF extra IS DISTINCT FROM ARRAY[${keys}]::text[] THEN
    RAISE EXCEPTION '${t}: keys not in ${spec.legacyTable} = %, expected the 9 new MG 2025 municipios ${NEW_MUN_KEYS_2025.join(" ")}', extra;
  END IF;
  SELECT count(*) INTO gone FROM (
    SELECT cvegeo::text FROM public.${spec.legacyTable}
    EXCEPT SELECT cvegeo::text FROM public.${t}) s;
  IF gone <> 0 THEN
    RAISE EXCEPTION '${t}: % ${spec.legacyTable} keys missing from MG 2025, expected 0', gone;
  END IF;
${probes}
  RAISE NOTICE '${t}: OK % rows, 9 new keys vs ${spec.legacyTable}, 0 gone, all valid MULTIPOLYGON/4326', n;
END $$;`;
  }
  return `DO $$
DECLARE
  n bigint; d bigint; nulls bigint; badtype bigint; badsrid bigint; invalid bigint;
  urb bigint; rur bigint;
BEGIN${common}
  SELECT count(*) FILTER (WHERE ambito = 'Urbana' AND length(cvegeo) = 13),
         count(*) FILTER (WHERE ambito = 'Rural' AND length(cvegeo) = 9)
    INTO urb, rur FROM public.${t};
  IF urb <> ${AGEB_URBANA_13} OR rur <> ${AGEB_RURAL_9} THEN
    RAISE EXCEPTION '${t}: Urbana/13-char = %, Rural/9-char = %, expected ${AGEB_URBANA_13} / ${AGEB_RURAL_9}', urb, rur;
  END IF;
  RAISE NOTICE '${t}: OK % rows (Urbana % + Rural %), all valid MULTIPOLYGON/4326', n, urb, rur;
END $$;`;
}

/** Everything that runs after a layer's COPY, inside the same transaction. */
export function postStepsSql(spec: LayerSpec): string {
  const t = spec.table;
  assertIdent(t);
  const lines = [
    `-- ${t}: post-load steps (same transaction)`,
    `DO $$ DECLARE n bigint; bad bigint; BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT ST_IsValid(geom)) INTO n, bad FROM public.${t};
  RAISE NOTICE '${t}: % of % geometries invalid before repair', bad, n;
END $$;`,
    // Same repair as scripts/migrations/019-censo-views-treemap-geoms.sql:268.
    `UPDATE public.${t}
SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))
WHERE NOT ST_IsValid(geom);`,
    `CREATE UNIQUE INDEX ${t}_cvegeo_uq ON public.${t} (cvegeo);`,
  ];
  if (spec.layer === "ageb") {
    lines.push(`CREATE INDEX idx_${t}_ent_mun ON public.${t} (cve_ent, cve_mun);`);
  }
  lines.push(`ANALYZE public.${t};`);
  lines.push(...grantAndCommentStatements(spec));
  lines.push(assertionSql(spec));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// PGDUMP stream filter
// ---------------------------------------------------------------------------

export interface LayerStreamResult {
  rows: number;
  columns: string[];
  probesFound: string[];
}

const COPY_END = Buffer.from("\\.");

/**
 * The only statement shapes ogr2ogr's PGDUMP emits for these layers (besides
 * the exact `SET standard_conforming_strings = ON;`, the dropped
 * BEGIN;/COMMIT; and the `\.` that ends the COPY data).
 */
const DUMP_STATEMENT_SHAPES: readonly RegExp[] = [
  /^CREATE TABLE "public"\./,
  /^ALTER TABLE "public"\./,
  /^SELECT AddGeometryColumn\('public',/,
  /^COMMENT ON TABLE "public"\./,
  /^COPY "public"\./,
  /^CREATE INDEX "[a-z0-9_]+" ON "public"\./,
];

/**
 * Line filter over ogr2ogr's PGDUMP output. Drops the dump's own
 * BEGIN;/COMMIT; (the loader owns the transaction), passes COPY data
 * through untouched, and refuses any SQL line that does not name the target
 * table, so a dump can never touch the 2020 tables.
 */
export class PgdumpFilter {
  private inCopy = false;
  private begins = 0;
  private commits = 0;
  private copies = 0;
  private rows = 0;
  private readonly columns: string[] = [];
  private readonly probes: Array<{ label: string; tail: Buffer }>;
  private readonly found = new Set<string>();
  private readonly quoted: string;
  private readonly literal: string;

  constructor(private readonly spec: LayerSpec) {
    assertIdent(spec.table);
    this.quoted = `"public"."${spec.table}"`;
    this.literal = `'public','${spec.table}'`;
    this.probes =
      spec.layer === "mun"
        ? ENCODING_PROBES.map(([cve, name]) => ({
            label: `${cve} ${name}`,
            // nomgeo is the last COPY column: `...\t<cvegeo>\t<ent>\t<mun>\t<nomgeo>`.
            tail: Buffer.from(`\t${cve}\t${cve.slice(0, 2)}\t${cve.slice(2)}\t${name}`, "utf-8"),
          }))
        : [];
  }

  /** The line to forward (without its newline), or null to drop it. */
  push(line: Buffer): Buffer | null {
    if (this.inCopy) {
      if (line.equals(COPY_END)) {
        this.inCopy = false;
        return line;
      }
      this.rows++;
      for (const p of this.probes) {
        if (line.length >= p.tail.length && line.subarray(line.length - p.tail.length).equals(p.tail)) {
          this.found.add(p.label);
        }
      }
      return line;
    }
    const s = line.toString("utf-8").replace(/\r$/, "");
    if (s === "BEGIN;") {
      this.begins++;
      return null;
    }
    if (s === "COMMIT;") {
      this.commits++;
      return null;
    }
    if (s === "" || s === "SET standard_conforming_strings = ON;") return line;
    if (/^\s*(DROP|TRUNCATE|DELETE)\b/i.test(s)) {
      throw new Error(`PGDUMP: refusing destructive statement "${s.slice(0, 120)}"`);
    }
    // One statement per line, ending the line: a second `;` could smuggle a
    // statement past the shape and table checks below.
    if (!/^[^;]*;$/.test(s)) {
      throw new Error(`PGDUMP: expected exactly one statement ending the line: "${s.slice(0, 120)}"`);
    }
    if (!DUMP_STATEMENT_SHAPES.some((re) => re.test(s))) {
      throw new Error(`PGDUMP: unexpected statement shape: "${s.slice(0, 120)}"`);
    }
    if (!s.includes(this.quoted) && !s.includes(this.literal)) {
      throw new Error(`PGDUMP: statement does not target ${this.spec.table}: "${s.slice(0, 120)}"`);
    }
    const col = /^ALTER TABLE "public"\."[a-z0-9_]+" ADD COLUMN "([a-z0-9_]+)" ([^;]+);$/.exec(s);
    if (col) this.columns.push(`${col[1]} ${col[2]}`);
    const geom = /^SELECT AddGeometryColumn\('public','[a-z0-9_]+','([a-z0-9_]+)',(\d+),'([A-Z]+)',(\d)\);$/.exec(s);
    if (geom) this.columns.push(`${geom[1]} geometry(${geom[3]},${geom[2]})`);
    if (/^COPY "public"\."[a-z0-9_]+" \(.*\) FROM STDIN;$/.test(s)) {
      this.copies++;
      this.inCopy = true;
    }
    return line;
  }

  get rowCount(): number {
    return this.rows;
  }

  /** Validate the dump's shape once ogr2ogr has exited. */
  finish(): LayerStreamResult {
    const t = this.spec.table;
    if (this.inCopy) throw new Error(`PGDUMP ${t}: stream ended inside COPY (no \\. terminator)`);
    if (this.begins !== 1 || this.commits !== 1) {
      throw new Error(`PGDUMP ${t}: expected one BEGIN;/COMMIT; pair, got ${this.begins}/${this.commits}`);
    }
    if (this.copies !== 1) throw new Error(`PGDUMP ${t}: expected one COPY block, got ${this.copies}`);
    if (this.rows !== this.spec.expectedRows) {
      throw new Error(`PGDUMP ${t}: ${this.rows} COPY rows, expected ${this.spec.expectedRows}`);
    }
    const missing = this.probes.filter((p) => !this.found.has(p.label)).map((p) => p.label);
    if (missing.length > 0) {
      throw new Error(`PGDUMP ${t}: encoding probes not found in COPY data: ${missing.join(", ")}`);
    }
    return { rows: this.rows, columns: [...this.columns], probesFound: [...this.found] };
  }
}

/** Split a byte stream on LF without ever holding more than one line. */
export async function* splitLines(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  for await (const chunk of src) {
    let start = 0;
    let idx: number;
    while ((idx = chunk.indexOf(0x0a, start)) !== -1) {
      const piece = chunk.subarray(start, idx);
      if (parts.length === 0) yield piece;
      else {
        parts.push(piece);
        yield Buffer.concat(parts);
        parts = [];
      }
      start = idx + 1;
    }
    if (start < chunk.length) parts.push(Buffer.from(chunk.subarray(start)));
  }
  if (parts.length > 0) yield Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Sinks: psql stdin (live) or a byte counter (dry run)
// ---------------------------------------------------------------------------

interface Sink {
  write(data: Buffer | string): Promise<void>;
}

const NL = Buffer.from("\n");

class DryRunSink implements Sink {
  bytes = 0;
  readonly head: string[] = [];
  private cur = "";

  constructor(private readonly maxLines = 40) {}

  async write(data: Buffer | string): Promise<void> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    this.bytes += buf.length;
    if (this.head.length >= this.maxLines) return;
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(0x0a, start)) !== -1 && this.head.length < this.maxLines) {
      this.appendCur(buf.subarray(start, idx));
      this.head.push(this.cur);
      this.cur = "";
      start = idx + 1;
    }
    if (this.head.length < this.maxLines && start < buf.length) this.appendCur(buf.subarray(start));
  }

  private appendCur(b: Buffer): void {
    if (this.cur.length >= 160) return;
    this.cur += b.subarray(0, 200).toString("utf-8");
    if (this.cur.length > 160) this.cur = `${this.cur.slice(0, 160)}…`;
  }
}

class PsqlSink implements Sink {
  private closedErr: Error | null = null;
  private readonly closed: Promise<never>;

  constructor(private readonly stdin: Writable, exited: Promise<number>) {
    this.closed = exited.then((code) => {
      this.closedErr = new Error(`psql exited (code ${code}) before the stream ended; transaction rolled back`);
      throw this.closedErr;
    });
    this.closed.catch(() => undefined);
    stdin.on("error", () => undefined); // EPIPE after psql exits: surfaced via `closed`
  }

  async write(data: Buffer | string): Promise<void> {
    if (this.closedErr) throw this.closedErr;
    if (!this.stdin.write(data)) {
      await Promise.race([new Promise<void>((r) => this.stdin.once("drain", () => r())), this.closed]);
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const log = (msg: string): void => console.log(`[load-mg2025] ${msg}`);
const secs = (t0: number): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    h.update(chunk as Buffer);
  }
  return h.digest("hex");
}

async function streamLayer(zip: string, spec: LayerSpec, sink: Sink, t0: number): Promise<LayerStreamResult> {
  const ogr = spawn("ogr2ogr", ogr2ogrArgs(zip, spec), { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number>((res, rej) => {
    ogr.on("error", rej);
    ogr.on("close", (code) => res(code ?? -1));
  });
  let stderrTail = "";
  ogr.stderr.on("data", (d: Buffer) => {
    process.stderr.write(d);
    stderrTail = (stderrTail + d.toString("utf-8")).slice(-2000);
  });
  const filter = new PgdumpFilter(spec);
  const every = Math.max(1, Math.round(spec.expectedRows / 10));
  try {
    for await (const line of splitLines(ogr.stdout as AsyncIterable<Buffer>)) {
      const out = filter.push(line);
      if (out === null) continue;
      await sink.write(out);
      await sink.write(NL);
      if (filter.rowCount > 0 && filter.rowCount % every === 0) {
        log(`${spec.table}: ${filter.rowCount.toLocaleString()} / ${spec.expectedRows.toLocaleString()} rows streamed (${secs(t0)})`);
      }
    }
    const code = await exited;
    if (code !== 0) throw new Error(`ogr2ogr exited ${code} for ${spec.shp}: ${stderrTail.trim()}`);
  } finally {
    if (ogr.exitCode === null && ogr.signalCode === null) ogr.kill("SIGTERM");
  }
  return filter.finish();
}

function existingTables(container: string, specs: readonly LayerSpec[]): string[] {
  assertSafeContainer(container);
  const list = specs.map((s) => `'${s.table}'`).join(",");
  const out = execFileSync(
    "docker",
    [
      "exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
      `SELECT n FROM unnest(ARRAY[${list}]::text[]) AS n WHERE to_regclass('public.' || n) IS NOT NULL ORDER BY n;`,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );
  return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** No silent overwrite: an existing target table needs --force. */
export function assertOverwriteAllowed(present: readonly string[], force: boolean, container: string): void {
  if (present.length > 0 && !force) {
    throw new Error(`${present.join(", ")} already exist(s) in ${container}; re-run with --force to replace (no silent overwrite)`);
  }
}

function rowCounts(container: string, specs: readonly LayerSpec[]): Map<string, number> {
  const sql = specs.map((s) => `SELECT '${s.table}', count(*) FROM public.${s.table}`).join(" UNION ALL ");
  const out = execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-t", "-A", "-F", "|", "-c", `${sql};`],
    { encoding: "utf-8", timeout: 60_000 },
  );
  const m = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [t, n] = line.trim().split("|");
    if (t && n) m.set(t, Number.parseInt(n, 10));
  }
  return m;
}

export function ledgerCommand(rows: number): string {
  return `npx tsx scripts/record-dataset-version.ts --dataset=marco_geoestadistico --edition="MG 2025" --source="INEGI MG 2025, UPC ${MG2025_UPC}, ${MG2025_ZIP_NAME} sha256 ${MG2025_ZIP_SHA256}" --rows=${rows} --note="loaded alongside MG 2020 as *_polygons_2025" --apply`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.zip) || !statSync(args.zip).isFile()) {
    throw new Error(`zip not found: ${args.zip}`);
  }
  log(`zip ${args.zip} (${statSync(args.zip).size.toLocaleString()} B); layers ${args.layers.map((s) => s.layer).join(",")}${args.dryRun ? " [dry-run]" : ""}`);
  const sha = await sha256File(args.zip);
  if (sha !== MG2025_ZIP_SHA256) {
    throw new Error(`sha256 mismatch: ${sha}, expected ${MG2025_ZIP_SHA256} (raw/mg2025/SHA256SUMS)`);
  }
  log(`sha256 OK (${secs(t0)})`);

  if (args.dryRun) {
    const sink = new DryRunSink();
    await sink.write(preludeSql(args.layers, args.force));
    const posts: string[] = [];
    for (const spec of args.layers) {
      const before = sink.bytes;
      const r = await streamLayer(args.zip, spec, sink, t0);
      const post = postStepsSql(spec);
      posts.push(post);
      await sink.write(post);
      log(`${spec.table}: ${r.rows.toLocaleString()} rows, ${(sink.bytes - before).toLocaleString()} B of SQL (${secs(t0)})`);
      log(`${spec.table} columns: ${r.columns.join(", ")}`);
      if (r.probesFound.length > 0) log(`${spec.table} encoding probes in COPY data: ${r.probesFound.join(" | ")}`);
    }
    await sink.write("COMMIT;\n");
    log(`total script ${sink.bytes.toLocaleString()} B; first ${sink.head.length} lines:`);
    for (const l of sink.head) console.log(`  ${l}`);
    log("post-load SQL:");
    for (const p of posts) console.log(p);
    log(`dry run done in ${secs(t0)}; nothing sent to psql`);
    return;
  }

  const container = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  assertSafeContainer(container);
  const present = existingTables(container, args.layers);
  assertOverwriteAllowed(present, args.force, container);
  if (present.length > 0) {
    log(`--force: ${present.join(", ")} will be dropped and re-created in the transaction`);
    log("--force: the DROP holds ACCESS EXCLUSIVE until COMMIT; readers (street-geometry on mun_polygons_2025) block for the whole load");
  }

  const psql = spawn(
    "docker",
    ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-f", "-"],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const exited = new Promise<number>((res, rej) => {
    psql.on("error", rej);
    psql.on("close", (code) => res(code ?? -1));
  });
  const sink = new PsqlSink(psql.stdin, exited);
  let total = 0;
  try {
    await sink.write(preludeSql(args.layers, args.force));
    for (const spec of args.layers) {
      const r = await streamLayer(args.zip, spec, sink, t0);
      total += r.rows;
      log(`${spec.table}: ${r.rows.toLocaleString()} rows streamed; post-steps (repair, indexes, grants, assertions) ... (${secs(t0)})`);
      await sink.write(postStepsSql(spec));
    }
    await sink.write("COMMIT;\n");
  } catch (err) {
    // No COMMIT was written: ending stdin makes psql exit with the
    // transaction open, which the server rolls back.
    psql.stdin.end();
    await exited.catch(() => undefined);
    throw err;
  }
  psql.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`psql exited ${code}; the transaction was rolled back`);
  const counts = rowCounts(container, args.layers);
  for (const spec of args.layers) log(`${spec.table}: ${counts.get(spec.table)?.toLocaleString()} rows committed`);
  log(`done in ${secs(t0)} (${total.toLocaleString()} rows)`);
  log(`next: ${API_ROLE_LINE}   # from this branch's checkout (main's copy revokes the 2025 grants until the merge)`);
  log(`after the merge, before the service restart: re-run it from main (or scripts/migrations/028-mg2025-polygons-grants.sql) to prove the grant on main's copy`);
  if (args.layers.length === LAYER_ORDER.length) log(`then: ${ledgerCommand(total)}`);
  else log("ledger: record MG 2025 once BOTH layers are loaded (--rows = mun + ageb)");
}

const isMain = import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[load-mg2025] ✗ ${msg}`);
    process.exit(1);
  });
}
