/**
 * Warm the per-municipio OSM road cache used by GET /analytics/street-geometry.
 *
 *   npx tsx scripts/osm-prewarm.ts 09014 09015 ...
 *   npx tsx scripts/osm-prewarm.ts --estado 09
 *   npx tsx scripts/osm-prewarm.ts 06009 --force
 *
 * Sequential (one osmium pass over the 626 MB PBF per municipio, already
 * under `nice -n 19`); hot entries whose `.done` matches the PBF are
 * skipped. A whole estado is many passes (CDMX, 16 alcaldías ≈ 30 min):
 * run it in a transient unit, e.g.
 *   systemd-run --unit=osm-prewarm-09 --nice=19 -p WorkingDirectory=$PWD npx tsx scripts/osm-prewarm.ts --estado 09
 *
 * Municipios whose padded bbox exceeds MAX_BBOX_AREA_DEG2 (e.g. 06009 with
 * its islands; the API refuses them with 409) are printed and skipped
 * unless `--force` is given, in which case they are extracted after a
 * warning (still one at a time, still under the per-municipio lock).
 * Municipios whose lock is held by a running extraction (the API or
 * another prewarm) are logged and skipped.
 *
 * Reads mun_polygons read-only as the postgres role (operator tool, like
 * the scripts/load-* loaders), so it needs no denue_api grant. Never
 * downloads anything.
 */

import {
  CVE_MUN_RE,
  MAX_BBOX_AREA_DEG2,
  OsmLockHeldError,
  extractMunicipioRoads,
  fetchMunBbox,
  isBboxTooLarge,
  isCacheHot,
  listEstadoMunicipios,
  paddedBboxAreaDeg2,
  sweepStaleTemps,
  type Bbox,
  type ExtractResult,
} from "../src/osm/osmium.js";

const DB = {
  container: process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db",
  user: "postgres",
};

export type PrewarmArgs =
  | { force: boolean; estado: string }
  | { force: boolean; targets: string[] };

/** Parse argv (without node + script). Returns an error string on bad input. */
export function parseArgs(argv: string[]): PrewarmArgs | { error: string } {
  const force = argv.includes("--force");
  const rest = argv.filter((a) => a !== "--force");
  const usage =
    "uso: osm-prewarm.ts <cve_mun 5 dígitos>... | --estado <NN>  [--force]";
  if (rest[0] === "--estado") {
    if (rest.length !== 2 || !/^\d{2}$/.test(rest[1]!)) return { error: usage };
    return { force, estado: rest[1]! };
  }
  const bad = rest.filter((t) => !CVE_MUN_RE.test(t));
  if (rest.length === 0 || bad.length > 0) {
    return { error: `${usage}${bad.length ? ` (inválidos: ${bad.join(" ")})` : ""}` };
  }
  return { force, targets: rest };
}

export interface PrewarmDeps {
  isCacheHot: (cve: string) => boolean;
  fetchMunBbox: (cve: string) => Promise<Bbox | null>;
  extract: (cve: string, bbox: Bbox) => Promise<ExtractResult>;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/** Warm `targets` one at a time. Returns the number of failures. */
export async function prewarm(
  targets: string[],
  force: boolean,
  deps: PrewarmDeps,
): Promise<number> {
  let failed = 0;
  for (const cve of targets) {
    if (deps.isCacheHot(cve)) {
      deps.log(`${cve} hot (skip)`);
      continue;
    }
    const bbox = await deps.fetchMunBbox(cve);
    if (bbox === null) {
      deps.error(`${cve} no existe en mun_polygons`);
      failed++;
      continue;
    }
    if (isBboxTooLarge(bbox)) {
      const area = `${paddedBboxAreaDeg2(bbox).toFixed(2)} deg² > ${MAX_BBOX_AREA_DEG2} deg²`;
      if (!force) {
        deps.log(`${cve} skip: bbox ${area} (usa --force para extraerlo)`);
        continue;
      }
      deps.log(
        `${cve} WARNING: bbox ${area}; --force: extrayendo (paso largo sobre el PBF, más RAM y disco)`,
      );
    }
    try {
      const r = await deps.extract(cve, bbox);
      deps.log(
        `${cve} ok ${(r.duration_ms / 1000).toFixed(1)} s ${(r.bytes / 1e6).toFixed(2)} MB ${r.path}`,
      );
    } catch (err) {
      if (err instanceof OsmLockHeldError) {
        deps.log(`${cve} skip: ${err.message}`);
        continue;
      }
      failed++;
      const e = err as Error & { stderrTail?: string };
      deps.error(`${cve} FAILED: ${e.message}\n${e.stderrTail ?? ""}`);
    }
  }
  return failed;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }
  const swept = sweepStaleTemps();
  if (swept.length > 0) console.log(`swept stale leftovers: ${swept.join(" ")}`);
  let targets: string[];
  if ("estado" in args) {
    targets = await listEstadoMunicipios(args.estado, DB);
    if (targets.length === 0) {
      console.error(`sin municipios para estado "${args.estado}"`);
      return 2;
    }
  } else {
    targets = args.targets;
  }
  const failed = await prewarm(targets, args.force, {
    isCacheHot: (cve) => isCacheHot(cve),
    fetchMunBbox: (cve) => fetchMunBbox(cve, DB),
    extract: (cve, bbox) => extractMunicipioRoads(cve, bbox),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  return failed > 0 ? 1 : 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
