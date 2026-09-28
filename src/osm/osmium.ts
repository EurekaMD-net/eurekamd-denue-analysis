/**
 * Per-municipio road extract from the local Mexico PBF.
 *
 * Cache layout (git-ignored): data/osm-cache/mun/<cve_mun>.roads.geojsonseq
 * plus `<file>.done`, which holds the PBF fingerprint `size=<bytes>
 * mtimeMs=<int>` (same convention as scripts/load-osm-ageb.ts). The marker
 * is written last, so a partial extract is never taken for a finished one,
 * and a PBF refresh (new size/mtime) makes every entry cold again.
 *
 * Build = one pass over the 626 MB PBF, all under `nice -n 19`:
 *   1. osmium extract --bbox <padded municipio bbox> --strategy simple
 *   2. osmium tags-filter w/highway
 *   3. osmium export -f geojsonseq --geometry-types=linestring
 *   4. strip the RFC 8142 RS (0x1E) prefix while copying to the cache file
 * Temps live next to the cache file, carry the builder's pid, and are
 * removed on success and failure. An O_EXCL `<cve_mun>.lock` (pid + start
 * time) keeps the API and the prewarm CLI from building the same
 * municipio at once; sweepStaleTemps() clears leftovers of dead runs.
 *
 * SECURITY: osmium argv is built only from a validated 5-digit cve_mun,
 * finite in-range bbox numbers and fixed paths; execFile (no shell).
 */

import { execFile } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { runJson, type RunSqlOptions } from "../api/db/psql-runner.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PBF_PATH = join(PROJECT_ROOT, "raw/osm/mexico-latest.osm.pbf");
export const CACHE_DIR = join(PROJECT_ROOT, "data/osm-cache/mun");
export const CVE_MUN_RE = /^\d{5}$/;
export const BBOX_PAD_DEG = 0.01;
export const STEP_TIMEOUT_MS = 10 * 60_000;
/**
 * A lock or temp older than this belongs to a dead run. It is the longest a
 * live build can take (3 osmium steps x STEP_TIMEOUT_MS) plus slack, so a
 * slow but live build is never taken over mid-way.
 */
export const STALE_MS = 3 * STEP_TIMEOUT_MS + 60_000;
/** Padded bboxes above this are refused on the request path (islands, huge rural municipios). */
export const MAX_BBOX_AREA_DEG2 = 1;
/** A cold extraction needs this much free space on the cache filesystem... */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
/** ...and the cache may hold at most this much. */
export const MAX_CACHE_BYTES = 20 * 1024 ** 3;
const STDERR_TAIL_CHARS = 2_000;
// Mexico's bbox (same bounds as search.ts), plus the pad.
const MX_LON_MIN = -119;
const MX_LON_MAX = -86;
const MX_LAT_MIN = 14;
const MX_LAT_MAX = 33;

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface CachePaths {
  geojson: string;
  done: string;
}

/** Cache file paths for a cve_mun. Throws unless it is exactly 5 digits. */
export function cachePaths(cveMun: string, cacheDir = CACHE_DIR): CachePaths {
  if (!CVE_MUN_RE.test(cveMun)) {
    throw new Error(`cve_mun inválido "${cveMun}"`);
  }
  const geojson = join(cacheDir, `${cveMun}.roads.geojsonseq`);
  return { geojson, done: `${geojson}.done` };
}

/** PBF identity recorded in the `.done` marker: size + whole-ms mtime. */
export function pbfFingerprint(pbfPath = PBF_PATH): string {
  const st = statSync(pbfPath);
  return `size=${st.size} mtimeMs=${Math.trunc(st.mtimeMs)}`;
}

/** True when the extract exists and its marker matches the current PBF. */
export function isCacheHot(
  cveMun: string,
  opts: { cacheDir?: string; pbfPath?: string } = {},
): boolean {
  const p = cachePaths(cveMun, opts.cacheDir);
  if (!existsSync(p.geojson) || !existsSync(p.done)) return false;
  return (
    readFileSync(p.done, "utf-8").trim() === pbfFingerprint(opts.pbfPath)
  );
}

/** Pad a bbox and verify every edge is a finite number inside Mexico. */
export function padBbox(b: Bbox, pad = BBOX_PAD_DEG): Bbox {
  const out: Bbox = {
    minLon: b.minLon - pad,
    minLat: b.minLat - pad,
    maxLon: b.maxLon + pad,
    maxLat: b.maxLat + pad,
  };
  const ok =
    Object.values(out).every((n) => typeof n === "number" && Number.isFinite(n)) &&
    out.minLon >= MX_LON_MIN - pad &&
    out.maxLon <= MX_LON_MAX + pad &&
    out.minLat >= MX_LAT_MIN - pad &&
    out.maxLat <= MX_LAT_MAX + pad &&
    out.minLon < out.maxLon &&
    out.minLat < out.maxLat;
  if (!ok) throw new Error(`bbox inválido ${JSON.stringify(b)}`);
  return out;
}

/** `LEFT,BOTTOM,RIGHT,TOP` for osmium, from numbers only. */
export function bboxArg(b: Bbox): string {
  return [b.minLon, b.minLat, b.maxLon, b.maxLat]
    .map((n) => n.toFixed(6))
    .join(",");
}

/** Area in square degrees of the bbox after padding. */
export function paddedBboxAreaDeg2(b: Bbox): number {
  const p = padBbox(b);
  return (p.maxLon - p.minLon) * (p.maxLat - p.minLat);
}

/** True when the padded bbox exceeds MAX_BBOX_AREA_DEG2 (too costly to extract on demand). */
export function isBboxTooLarge(b: Bbox): boolean {
  return paddedBboxAreaDeg2(b) > MAX_BBOX_AREA_DEG2;
}

export interface CacheBudget {
  ok: boolean;
  freeBytes: number;
  usedBytes: number;
}

/** Free space on the cache filesystem and bytes already cached, against the budget. */
export function checkCacheBudget(cacheDir = CACHE_DIR): CacheBudget {
  mkdirSync(cacheDir, { recursive: true });
  const fs = statfsSync(cacheDir);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  let usedBytes = 0;
  for (const name of readdirSync(cacheDir)) {
    try {
      usedBytes += statSync(join(cacheDir, name)).size;
    } catch {
      // removed concurrently
    }
  }
  return {
    ok: freeBytes >= MIN_FREE_BYTES && usedBytes <= MAX_CACHE_BYTES,
    freeBytes,
    usedBytes,
  };
}

/** The cache budget was exceeded when a queued extraction was about to start. */
export class OsmCacheBudgetError extends Error {
  constructor() {
    super("osm-cache budget exceeded (free space < 5 GB or cache > 20 GB)");
    this.name = "OsmCacheBudgetError";
  }
}

export class OsmLockHeldError extends Error {
  constructor(cveMun: string, holder: string) {
    super(`extracción de ${cveMun} en curso (lock ${holder})`);
    this.name = "OsmLockHeldError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock is stale when its pid is dead or it is older than STALE_MS. An
 * unparseable lock (e.g. caught between O_EXCL create and write) is stale
 * only once its mtime is more than a few seconds old.
 */
export function isLockStale(
  content: string,
  mtimeMs: number,
  now = Date.now(),
): boolean {
  const m = /^(\d+) (\d+)$/.exec(content.trim());
  if (!m) return now - mtimeMs > 10_000;
  return now - Number(m[2]) > STALE_MS || !pidAlive(Number(m[1]));
}

function lockIsStale(path: string, now = Date.now()): boolean {
  return isLockStale(readFileSync(path, "utf-8"), statSync(path).mtimeMs, now);
}

/** `<cve_mun>.lock` in the cache dir (cve_mun validated by cachePaths). */
export function lockPath(cveMun: string, cacheDir = CACHE_DIR): string {
  cachePaths(cveMun, cacheDir);
  return join(cacheDir, `${cveMun}.lock`);
}

/** Take `<cve_mun>.lock` with O_EXCL; replace it once if stale. Returns a release function. */
export function acquireLock(cveMun: string, cacheDir = CACHE_DIR): () => void {
  const path = lockPath(cveMun, cacheDir);
  const mine = `${process.pid} ${Date.now()}`;
  mkdirSync(cacheDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, mine);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf-8") === mine) rmSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let held = "";
      let stale = false;
      try {
        held = readFileSync(path, "utf-8");
        stale = lockIsStale(path);
      } catch {
        continue; // released between open and read
      }
      if (attempt === 0 && stale) {
        rmSync(path, { force: true });
        continue;
      }
      throw new OsmLockHeldError(cveMun, held.trim());
    }
  }
  throw new OsmLockHeldError(cveMun, "?");
}

const LEFTOVER_RE = /^\d{5}\.(?:tmp-.*|.*\.part|lock)$/;

/**
 * Delete leftovers of dead runs: `*.tmp-*` / `*.part` older than STALE_MS
 * and stale `*.lock` files. Called once at process start (API handler
 * factory, prewarm CLI). Returns the removed names.
 */
export function sweepStaleTemps(cacheDir = CACHE_DIR, now = Date.now()): string[] {
  if (!existsSync(cacheDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(cacheDir)) {
    if (!LEFTOVER_RE.test(name)) continue;
    const path = join(cacheDir, name);
    try {
      const stale = name.endsWith(".lock")
        ? lockIsStale(path, now)
        : now - statSync(path).mtimeMs > STALE_MS;
      if (stale) {
        rmSync(path, { force: true });
        removed.push(name);
      }
    } catch {
      // removed concurrently
    }
  }
  return removed;
}

/** Municipio bbox from mun_polygons (read-only), or null when the cvegeo is unknown. */
export async function fetchMunBbox(
  cveMun: string,
  opts: RunSqlOptions,
): Promise<Bbox | null> {
  if (!CVE_MUN_RE.test(cveMun)) throw new Error(`cve_mun inválido "${cveMun}"`);
  const sql = `SELECT json_agg(json_build_object('minLon', ST_XMin(e), 'minLat', ST_YMin(e), 'maxLon', ST_XMax(e), 'maxLat', ST_YMax(e))) FROM (SELECT ST_Extent(geom) AS e FROM mun_polygons WHERE cvegeo = '${cveMun}') t WHERE e IS NOT NULL;`;
  const rows = await runJson<Bbox[] | null>(sql, { ...opts, readOnly: true });
  return rows && rows.length > 0 ? rows[0]! : null;
}

/** 5-digit cvegeo list of an estado, from mun_polygons (read-only). */
export async function listEstadoMunicipios(
  cveEnt: string,
  opts: RunSqlOptions,
): Promise<string[]> {
  if (!/^\d{2}$/.test(cveEnt)) throw new Error(`estado inválido "${cveEnt}"`);
  const sql = `SELECT json_agg(cvegeo ORDER BY cvegeo) FROM mun_polygons WHERE cvegeo LIKE '${cveEnt}%';`;
  const rows = await runJson<string[] | null>(sql, { ...opts, readOnly: true });
  return (rows ?? []).filter((c) => CVE_MUN_RE.test(c));
}

export class OsmExtractError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
  ) {
    super(message);
    this.name = "OsmExtractError";
  }
}

/** Runs one osmium step; injectable for tests. */
export type StepRunner = (args: string[]) => Promise<void>;

/** Default runner: `nice -n 19 osmium <args>` via execFile, 10-min timeout. */
export const niceOsmium: StepRunner = (args) =>
  new Promise((ok, fail) => {
    execFile(
      "nice",
      ["-n", "19", "osmium", ...args],
      { timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return ok();
        const tail = String(stderr ?? "").slice(-STDERR_TAIL_CHARS);
        fail(
          new OsmExtractError(
            `osmium ${args[0]} falló: ${err.message.split("\n")[0]}`,
            tail,
          ),
        );
      },
    );
  });

/** Copy src → dest dropping every RS (0x1E) byte (only ever the RFC 8142 prefix: JSON escapes control chars). */
async function stripRs(src: string, dest: string): Promise<void> {
  const strip = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, chunk.includes(0x1e) ? chunk.filter((b) => b !== 0x1e) : chunk);
    },
  });
  await pipeline(createReadStream(src), strip, createWriteStream(dest));
}

export interface ExtractOptions {
  cacheDir?: string;
  pbfPath?: string;
  run?: StepRunner;
}

export interface ExtractResult {
  path: string;
  bytes: number;
  duration_ms: number;
}

/** Build the road extract of one municipio. Never call concurrently — go through extract-queue.ts. */
export async function extractMunicipioRoads(
  cveMun: string,
  bbox: Bbox,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const pbfPath = opts.pbfPath ?? PBF_PATH;
  const run = opts.run ?? niceOsmium;
  const p = cachePaths(cveMun, cacheDir);
  const box = bboxArg(padBbox(bbox));
  const started = Date.now();
  // Fingerprint the PBF before reading it: a refresh during the build then
  // leaves a marker that no longer matches, so the extract is rebuilt.
  const fingerprint = pbfFingerprint(pbfPath);
  mkdirSync(cacheDir, { recursive: true });

  // Throws OsmLockHeldError while another process builds this municipio.
  const release = acquireLock(cveMun, cacheDir);
  const pid = process.pid;
  const tmpExtract = join(cacheDir, `${cveMun}.tmp-extract.${pid}.osm.pbf`);
  const tmpRoads = join(cacheDir, `${cveMun}.tmp-roads.${pid}.osm.pbf`);
  const tmpJson = join(cacheDir, `${cveMun}.tmp-export.${pid}.geojsonseq`);
  const tmpFinal = `${p.geojson}.${pid}.part`;
  const temps = [tmpExtract, tmpRoads, tmpJson, tmpFinal];

  try {
    // A stale marker must not vouch for the extract this run is about to redo.
    rmSync(p.done, { force: true });
    await run([
      "extract",
      "--bbox",
      box,
      "--strategy",
      "simple",
      "--overwrite",
      "-o",
      tmpExtract,
      pbfPath,
    ]);
    await run(["tags-filter", "--overwrite", "-o", tmpRoads, tmpExtract, "w/highway"]);
    await run([
      "export",
      "--overwrite",
      "-f",
      "geojsonseq",
      "--geometry-types=linestring",
      "-o",
      tmpJson,
      tmpRoads,
    ]);
    await stripRs(tmpJson, tmpFinal);
    renameSync(tmpFinal, p.geojson);
    writeFileSync(p.done, `${fingerprint}\n`);
  } finally {
    for (const t of temps) rmSync(t, { force: true });
    release();
  }
  return {
    path: p.geojson,
    bytes: statSync(p.geojson).size,
    duration_ms: Date.now() - started,
  };
}
