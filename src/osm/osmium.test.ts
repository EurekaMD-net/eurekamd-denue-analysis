import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockRunJson } = vi.hoisted(() => ({ mockRunJson: vi.fn() }));
vi.mock("../api/db/psql-runner.js", () => ({ runJson: mockRunJson }));
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  CACHE_DIR,
  OsmLockHeldError,
  STALE_MS,
  acquireLock,
  bboxArg,
  cachePaths,
  checkCacheBudget,
  extractMunicipioRoads,
  fetchMunBbox,
  isBboxTooLarge,
  isCacheHot,
  listEstadoMunicipios,
  lockPath,
  padBbox,
  paddedBboxAreaDeg2,
  pbfFingerprint,
  sweepStaleTemps,
  type StepRunner,
} from "./osmium.js";

const BBOX = {
  minLon: -99.1843,
  minLat: 19.3998,
  maxLon: -99.1222,
  maxLat: 19.4658,
};

let dir: string;
let cacheDir: string;
let pbfPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osmium-test-"));
  cacheDir = join(dir, "cache");
  pbfPath = join(dir, "fake.osm.pbf");
  writeFileSync(pbfPath, "pbf-v1");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Fake osmium: writes each step's `-o` file; export emits RS-prefixed records. */
function fakeRunner(calls: string[][], failOn?: string): StepRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === failOn) throw new Error(`boom in ${failOn}`);
    const out = args[args.indexOf("-o") + 1]!;
    if (args[0] === "export") {
      const rec = (name: string) =>
        `\x1e${JSON.stringify({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[-99.1, 19.4], [-99.2, 19.4]] },
          properties: { highway: "primary", name },
        })}\n`;
      writeFileSync(out, rec("Paseo de la Reforma") + rec("Calle Río"));
    } else {
      writeFileSync(out, `pbf from ${args[0]}`);
    }
  };
}

describe("cachePaths", () => {
  it("builds <cve_mun>.roads.geojsonseq (+ .done) inside the cache dir", () => {
    const p = cachePaths("09015");
    expect(p.geojson).toBe(join(CACHE_DIR, "09015.roads.geojsonseq"));
    expect(p.done).toBe(`${p.geojson}.done`);
    expect(dirname(p.geojson)).toBe(CACHE_DIR);
  });

  it("rejects anything but exactly 5 digits (no path traversal)", () => {
    for (const bad of [
      "../../etc/passwd",
      "09015/../../x",
      "..",
      "0901",
      "090155",
      "09015\n",
      " 09015",
      "0901a",
      "",
    ]) {
      expect(() => cachePaths(bad), bad).toThrow(/cve_mun inválido/);
    }
  });
});

describe("padBbox / bboxArg", () => {
  it("pads 0.01° and formats LEFT,BOTTOM,RIGHT,TOP with 6 decimals", () => {
    expect(bboxArg(padBbox(BBOX))).toBe(
      "-99.194300,19.389800,-99.112200,19.475800",
    );
  });

  it("rejects non-finite, inverted or out-of-Mexico boxes", () => {
    expect(() => padBbox({ ...BBOX, minLon: Number.NaN })).toThrow();
    expect(() =>
      padBbox({ ...BBOX, minLon: "1;rm -rf /" as unknown as number }),
    ).toThrow();
    expect(() => padBbox({ ...BBOX, minLon: -98, maxLon: -99 })).toThrow();
    expect(() => padBbox({ ...BBOX, minLat: 40, maxLat: 41 })).toThrow();
  });
});

describe("extractMunicipioRoads", () => {
  it("runs extract → tags-filter → export, strips RS, writes .done, removes temps", async () => {
    const calls: string[][] = [];
    const r = await extractMunicipioRoads("09015", BBOX, {
      cacheDir,
      pbfPath,
      run: fakeRunner(calls),
    });

    expect(calls.map((c) => c[0])).toEqual(["extract", "tags-filter", "export"]);
    expect(calls[0]).toEqual([
      "extract",
      "--bbox",
      "-99.194300,19.389800,-99.112200,19.475800",
      "--strategy",
      "simple",
      "--overwrite",
      "-o",
      join(cacheDir, `09015.tmp-extract.${process.pid}.osm.pbf`),
      pbfPath,
    ]);
    expect(calls[1]).toContain("w/highway");
    expect(calls[2]).toContain("geojsonseq");
    expect(calls[2]).toContain("--geometry-types=linestring");

    const p = cachePaths("09015", cacheDir);
    expect(r.path).toBe(p.geojson);
    const body = readFileSync(p.geojson, "utf-8");
    expect(body).not.toContain("\x1e");
    expect(body.trim().split("\n")).toHaveLength(2);
    expect(body).toContain("Calle Río"); // UTF-8 survives the byte filter
    expect(readFileSync(p.done, "utf-8").trim()).toBe(pbfFingerprint(pbfPath));
    expect(readdirSync(cacheDir).sort()).toEqual([
      "09015.roads.geojsonseq",
      "09015.roads.geojsonseq.done",
    ]);
    expect(isCacheHot("09015", { cacheDir, pbfPath })).toBe(true);
  });

  it("on a failed step: rethrows, leaves no .done and no temps", async () => {
    const calls: string[][] = [];
    await expect(
      extractMunicipioRoads("09015", BBOX, {
        cacheDir,
        pbfPath,
        run: fakeRunner(calls, "tags-filter"),
      }),
    ).rejects.toThrow(/boom in tags-filter/);
    expect(readdirSync(cacheDir)).toEqual([]);
    expect(isCacheHot("09015", { cacheDir, pbfPath })).toBe(false);
  });

  it("refuses an invalid cve_mun before running anything", async () => {
    const calls: string[][] = [];
    await expect(
      extractMunicipioRoads("../x1", BBOX, { cacheDir, pbfPath, run: fakeRunner(calls) }),
    ).rejects.toThrow(/cve_mun inválido/);
    expect(calls).toEqual([]);
  });
});

describe(".done fingerprint", () => {
  it("is size=<bytes> mtimeMs=<int>", () => {
    expect(pbfFingerprint(pbfPath)).toMatch(/^size=6 mtimeMs=\d+$/);
  });

  it("a PBF change makes the entry cold and a rebuild re-arms it", async () => {
    const calls: string[][] = [];
    const opts = { cacheDir, pbfPath, run: fakeRunner(calls) };
    await extractMunicipioRoads("09015", BBOX, opts);
    expect(isCacheHot("09015", opts)).toBe(true);

    writeFileSync(pbfPath, "pbf-v2-bigger");
    utimesSync(pbfPath, new Date(), new Date(Date.now() + 5_000));
    expect(isCacheHot("09015", opts)).toBe(false);

    await extractMunicipioRoads("09015", BBOX, opts);
    expect(calls).toHaveLength(6);
    expect(isCacheHot("09015", opts)).toBe(true);
    expect(
      readFileSync(cachePaths("09015", cacheDir).done, "utf-8"),
    ).toContain("size=13 ");
  });

  it("fingerprints the PBF before step 1: a refresh mid-build leaves the entry cold", async () => {
    const calls: string[][] = [];
    const inner = fakeRunner(calls);
    const v1 = pbfFingerprint(pbfPath);
    await extractMunicipioRoads("09015", BBOX, {
      cacheDir,
      pbfPath,
      run: async (args) => {
        await inner(args);
        if (args[0] === "extract") {
          writeFileSync(pbfPath, "pbf-v2-bigger");
          utimesSync(pbfPath, new Date(), new Date(Date.now() + 5_000));
        }
      },
    });
    expect(readFileSync(cachePaths("09015", cacheDir).done, "utf-8").trim()).toBe(v1);
    expect(isCacheHot("09015", { cacheDir, pbfPath })).toBe(false);
  });

  it("an extract without its .done marker is cold", async () => {
    await extractMunicipioRoads("09015", BBOX, {
      cacheDir,
      pbfPath,
      run: fakeRunner([]),
    });
    rmSync(cachePaths("09015", cacheDir).done);
    expect(existsSync(cachePaths("09015", cacheDir).geojson)).toBe(true);
    expect(isCacheHot("09015", { cacheDir, pbfPath })).toBe(false);
  });
});

describe("bbox area guard", () => {
  it("measures the padded bbox and refuses > 1 deg²", () => {
    // 09015 Cuauhtémoc: ~0.007 deg² padded.
    expect(paddedBboxAreaDeg2(BBOX)).toBeCloseTo(0.0082 * 0.86, 2);
    expect(isBboxTooLarge(BBOX)).toBe(false);
    // 06009 (islands): 11.14° x 0.78°.
    const islands = { minLon: -114.8, minLat: 18.3, maxLon: -103.66, maxLat: 19.08 };
    expect(paddedBboxAreaDeg2(islands)).toBeGreaterThan(8);
    expect(isBboxTooLarge(islands)).toBe(true);
    // Just under / over the edge (padding included).
    const sq = (side: number) => ({ minLon: -100, minLat: 20, maxLon: -100 + side, maxLat: 20 + side });
    expect(isBboxTooLarge(sq(0.97))).toBe(false);
    expect(isBboxTooLarge(sq(0.99))).toBe(true);
  });
});

describe("checkCacheBudget", () => {
  it("sums cached bytes and reports free space", () => {
    const b0 = checkCacheBudget(cacheDir); // creates the dir
    expect(b0.usedBytes).toBe(0);
    writeFileSync(join(cacheDir, "09015.roads.geojsonseq"), "x".repeat(1000));
    const b = checkCacheBudget(cacheDir);
    expect(b.usedBytes).toBe(1000);
    expect(b.freeBytes).toBeGreaterThan(0);
    expect(b.ok).toBe(b.freeBytes >= 5 * 1024 ** 3);
  });
});

describe("lock", () => {
  const DEAD_PID = 99_999_999; // above any pid_max: kill(pid, 0) → ESRCH

  it("is exclusive while held and released by its owner", () => {
    const release = acquireLock("09015", cacheDir);
    expect(readFileSync(lockPath("09015", cacheDir), "utf-8")).toMatch(
      new RegExp(`^${process.pid} \\d+$`),
    );
    expect(() => acquireLock("09015", cacheDir)).toThrow(OsmLockHeldError);
    release();
    expect(existsSync(lockPath("09015", cacheDir))).toBe(false);
    acquireLock("09015", cacheDir)();
  });

  it("replaces a lock whose pid is dead or that is older than STALE_MS", () => {
    checkCacheBudget(cacheDir);
    const lp = lockPath("09015", cacheDir);
    writeFileSync(lp, `${DEAD_PID} ${Date.now()}`);
    acquireLock("09015", cacheDir)();
    writeFileSync(lp, `1 ${Date.now() - STALE_MS - 1000}`); // pid 1 is alive
    acquireLock("09015", cacheDir)();
    // Live pid, fresh timestamp → held.
    writeFileSync(lp, `1 ${Date.now()}`);
    expect(() => acquireLock("09015", cacheDir)).toThrow(OsmLockHeldError);
  });

  it("an extraction refuses to start while another live process holds the lock", async () => {
    const calls: string[][] = [];
    const opts = { cacheDir, pbfPath, run: fakeRunner(calls) };
    await extractMunicipioRoads("09015", BBOX, opts);
    writeFileSync(lockPath("09015", cacheDir), `1 ${Date.now()}`);
    await expect(extractMunicipioRoads("09015", BBOX, opts)).rejects.toBeInstanceOf(
      OsmLockHeldError,
    );
    expect(calls).toHaveLength(3); // nothing ran the second time
    // The finished extract (and its .done) was not touched.
    expect(isCacheHot("09015", opts)).toBe(true);
  });

  it("lockPath rejects an invalid cve_mun", () => {
    expect(() => lockPath("../x", cacheDir)).toThrow(/cve_mun inválido/);
  });
});

describe("sweepStaleTemps", () => {
  it("removes old temps/parts and stale locks, keeps fresh ones and the cache", () => {
    checkCacheBudget(cacheDir);
    const old = new Date(Date.now() - STALE_MS - 60_000);
    const put = (name: string, body = "x", mtime?: Date) => {
      const p = join(cacheDir, name);
      writeFileSync(p, body);
      if (mtime) utimesSync(p, mtime, mtime);
    };
    put("09015.tmp-extract.123.osm.pbf", "x", old);
    put("09015.roads.geojsonseq.123.part", "x", old);
    put("09014.tmp-roads.456.osm.pbf"); // fresh: a live run's temp
    put("09016.lock", `99999999 ${Date.now()}`); // dead pid
    put("09017.lock", `1 ${Date.now()}`); // live pid 1
    put("09015.roads.geojsonseq", "x", old);
    put("09015.roads.geojsonseq.done", "x", old);

    const removed = sweepStaleTemps(cacheDir).sort();
    expect(removed).toEqual([
      "09015.roads.geojsonseq.123.part",
      "09015.tmp-extract.123.osm.pbf",
      "09016.lock",
    ]);
    expect(readdirSync(cacheDir).sort()).toEqual([
      "09014.tmp-roads.456.osm.pbf",
      "09015.roads.geojsonseq",
      "09015.roads.geojsonseq.done",
      "09017.lock",
    ]);
  });

  it("is a no-op when the cache dir does not exist", () => {
    expect(sweepStaleTemps(join(dir, "nope"))).toEqual([]);
  });
});

// MG 2025 bridge step 3: the municipio key list and bbox come from the MG 2025
// edition (a superset of MG 2020's keys), so the 9 municipios created since
// 2020 stop answering 404 on /analytics/street-geometry.
describe("municipio lookups read mun_polygons_2025", () => {
  const OPTS = { container: "supabase-db" };
  beforeEach(() => mockRunJson.mockReset());

  it("fetchMunBbox reads the MG 2025 table read-only", async () => {
    mockRunJson.mockResolvedValueOnce([BBOX]);
    await expect(fetchMunBbox("12083", OPTS)).resolves.toEqual(BBOX);
    const [sql, opts] = mockRunJson.mock.calls[0]!;
    expect(sql).toContain("FROM mun_polygons_2025 WHERE cvegeo = '12083'");
    expect(sql).not.toMatch(/\bmun_polygons\b(?!_2025)/);
    expect(opts).toEqual({ container: "supabase-db", readOnly: true });
  });

  it("fetchMunBbox returns null for an unknown cvegeo", async () => {
    mockRunJson.mockResolvedValueOnce(null);
    await expect(fetchMunBbox("99999", OPTS)).resolves.toBeNull();
  });

  it("listEstadoMunicipios reads the MG 2025 table read-only", async () => {
    mockRunJson.mockResolvedValueOnce(["12082", "12083", "bad"]);
    await expect(listEstadoMunicipios("12", OPTS)).resolves.toEqual(["12082", "12083"]);
    const [sql, opts] = mockRunJson.mock.calls[0]!;
    expect(sql).toContain("FROM mun_polygons_2025 WHERE cvegeo LIKE '12%'");
    expect(sql).not.toMatch(/\bmun_polygons\b(?!_2025)/);
    expect(opts).toEqual({ container: "supabase-db", readOnly: true });
  });
});
