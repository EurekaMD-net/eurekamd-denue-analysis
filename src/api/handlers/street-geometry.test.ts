import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../middleware/error.js";
import type { ApiServerConfig } from "../types.js";
import {
  COLD_EXTRACT_LIMIT,
  HOT_CONCURRENCY,
  MAX_PENDING,
  createStreetGeometryHandler,
  type StreetGeometryDeps,
} from "./street-geometry.js";
import { createExtractQueue } from "../../osm/extract-queue.js";
import { OsmExtractError, OsmLockHeldError } from "../../osm/osmium.js";
import type { StreetLookupResult } from "../../osm/street-index.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const BBOX = { minLon: -99.18, minLat: 19.39, maxLon: -99.12, maxLat: 19.46 };
const HOT_RESULT: StreetLookupResult = {
  matches: [
    {
      name: "Paseo de la Reforma",
      highway: ["primary"],
      length_m: 2100,
      segments: 1,
      geometry: {
        type: "MultiLineString",
        coordinates: [[[-99.17, 19.43], [-99.15, 19.43]]],
      },
    },
  ],
  truncated: false,
  malformed: 0,
};

function setup(overrides: Partial<StreetGeometryDeps> = {}) {
  const deps = {
    sourceAvailable: vi.fn(() => true),
    cacheBudgetOk: vi.fn(() => true),
    sweep: vi.fn(),
    isCacheHot: vi.fn(() => false),
    findStreets: vi.fn(async () => HOT_RESULT),
    fetchMunBbox: vi.fn(async () => BBOX),
    extract: vi.fn(async () => undefined as unknown),
    queue: createExtractQueue(),
    cachePath: (cve: string) => `/cache/${cve}.roads.geojsonseq`,
    ...overrides,
  };
  const handler = createStreetGeometryHandler(deps);
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/analytics/street-geometry", (c) => handler(c, CONFIG));
  const get = (qs: string, headers?: Record<string, string>) =>
    app.request(`/analytics/street-geometry?${qs}`, { headers });
  return { deps, get };
}

afterEach(() => vi.restoreAllMocks());

describe("GET /analytics/street-geometry — validation", () => {
  it.each([
    ["missing", "q=reforma"],
    ["4 digits", "cve_mun=0901&q=reforma"],
    ["6 digits", "cve_mun=090155&q=reforma"],
    ["traversal", `cve_mun=${encodeURIComponent("../../etc")}&q=reforma`],
    ["trailing newline", `cve_mun=${encodeURIComponent("09015\n")}&q=reforma`],
  ])("400 validation.cve_mun (%s)", async (_label, qs) => {
    const { deps, get } = setup();
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "validation.cve_mun",
    );
    expect(deps.isCacheHot).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "cve_mun=09015"],
    ["too short after trim", "cve_mun=09015&q=%20abc%20"],
    ["3 chars", "cve_mun=09015&q=ref"],
    ["too long", `cve_mun=09015&q=${"a".repeat(81)}`],
    ["3 chars once accents are stripped", `cve_mun=09015&q=${encodeURIComponent("a\u0301b\u0301c\u0301")}`],
    ["control char", "cve_mun=09015&q=refor%01ma"],
    ["NUL", "cve_mun=09015&q=refor%00ma"],
  ])("400 validation.q (%s)", async (_label, qs) => {
    const { get } = setup();
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation.q");
  });

  it("accepts q of exactly 80 chars and trims it", async () => {
    const { deps, get } = setup({ isCacheHot: vi.fn(() => true) });
    const res = await get(`cve_mun=09015&q=${"a".repeat(80)}`);
    expect(res.status).toBe(200);
    // 100 code units, 50 once the combining accents are stripped.
    const accented = "e\u0301".repeat(50);
    expect((await get(`cve_mun=09015&q=${encodeURIComponent(accented)}`)).status).toBe(200);
    const res2 = await get("cve_mun=09015&q=%20%20reforma%20");
    expect(((await res2.json()) as { q: string }).q).toBe("reforma");
    expect(deps.findStreets).toHaveBeenLastCalledWith(
      "/cache/09015.roads.geojsonseq",
      "reforma",
    );
  });
});

describe("GET /analytics/street-geometry — hot cache", () => {
  it("200 with matches, no DB or extraction", async () => {
    const { deps, get } = setup({ isCacheHot: vi.fn(() => true) });
    const res = await get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cve_mun: "09015",
      q: "reforma",
      status: "ok",
      matches: HOT_RESULT.matches,
    });
    expect(deps.fetchMunBbox).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("200 with matches: [] when nothing matches; truncated flag passes through", async () => {
    const { get } = setup({
      isCacheHot: vi.fn(() => true),
      findStreets: vi.fn(async () => ({
        matches: [],
        truncated: false,
        malformed: 0,
      })),
    });
    const res = await get("cve_mun=09015&q=zzzz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches: unknown[] }).matches).toEqual([]);

    const t = setup({
      isCacheHot: vi.fn(() => true),
      findStreets: vi.fn(async () => ({ ...HOT_RESULT, truncated: true })),
    });
    const body = (await (await t.get("cve_mun=09015&q=reforma")).json()) as {
      truncated?: boolean;
    };
    expect(body.truncated).toBe(true);
  });
});

describe("GET /analytics/street-geometry — cold cache", () => {
  it("202 + Retry-After, kicks one extraction; 202 again while in flight", async () => {
    let finish!: () => void;
    const extract = vi.fn(
      () => new Promise<unknown>((ok) => (finish = () => ok(undefined))),
    );
    const { deps, get } = setup({ extract });

    const res = await get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({
      status: "extracting",
      cve_mun: "09015",
      retry_after_s: 30,
    });
    expect(deps.fetchMunBbox).toHaveBeenCalledWith("09015", CONFIG);

    const res2 = await get("cve_mun=09015&q=insurgentes");
    expect(res2.status).toBe(202);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    expect(extract).toHaveBeenCalledWith("09015", BBOX);
    expect(deps.fetchMunBbox).toHaveBeenCalledTimes(1);
    finish();
  });

  it("two simultaneous cold requests start one extraction", async () => {
    const extract = vi.fn(async () => undefined as unknown);
    const { get } = setup({ extract });
    const [a, b] = await Promise.all([
      get("cve_mun=09015&q=reforma"),
      get("cve_mun=09015&q=reforma"),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
  });

  it("404 municipio.not_found when mun_polygons_2025 has no such cvegeo", async () => {
    const { deps, get } = setup({ fetchMunBbox: vi.fn(async () => null) });
    const res = await get("cve_mun=99999&q=reforma");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      "municipio.not_found",
    );
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("502 osm.extract_failed once after a failed extraction (stderr logged, not returned), then retries", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const extract = vi
      .fn<(cve: string, bbox: typeof BBOX) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new OsmExtractError("osmium extract falló", "SECRET-STDERR-TAIL"),
      )
      .mockResolvedValue(undefined);
    const { get } = setup({ extract });

    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
    await vi.waitFor(() =>
      expect(
        stderr.mock.calls.some((c) => String(c[0]).includes("SECRET-STDERR-TAIL")),
      ).toBe(true),
    );

    const failed = await get("cve_mun=09015&q=reforma");
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text).code).toBe("osm.extract_failed");
    expect(text).not.toContain("SECRET-STDERR-TAIL");
    expect(text).not.toContain("osmium");

    const retry = await get("cve_mun=09015&q=reforma");
    expect(retry.status).toBe(202);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
  });
});

describe("GET /analytics/street-geometry — guards", () => {
  const code = async (res: Response) =>
    ((await res.json()) as { code: string }).code;

  it("sweeps stale leftovers once, when the handler is created", async () => {
    const { deps, get } = setup({ isCacheHot: vi.fn(() => true) });
    await get("cve_mun=09015&q=reforma");
    await get("cve_mun=09015&q=reforma");
    expect(deps.sweep).toHaveBeenCalledTimes(1);
  });

  it("503 osm.source_missing when the PBF is gone", async () => {
    const { deps, get } = setup({ sourceAvailable: vi.fn(() => false) });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const res = await get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("osm.source_missing");
    expect(deps.isCacheHot).not.toHaveBeenCalled();
  });

  it(`429 osm.queue_full + Retry-After 60 once ${MAX_PENDING} municipios are pending`, async () => {
    const queue = createExtractQueue();
    const never = () => new Promise<unknown>(() => undefined);
    for (const k of ["09002", "09003", "09004"].slice(0, MAX_PENDING)) {
      void queue.enqueue(k, never);
    }
    const { deps, get } = setup({ queue });
    const res = await get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await code(res)).toBe("osm.queue_full");
    expect(deps.fetchMunBbox).not.toHaveBeenCalled();
    // A municipio already in the queue still gets 202.
    expect((await get("cve_mun=09002&q=reforma")).status).toBe(202);
  });

  it("re-checks the cap after the bbox lookup (no overshoot under concurrency)", async () => {
    const queue = createExtractQueue();
    const never = () => new Promise<unknown>(() => undefined);
    void queue.enqueue("09002", never);
    void queue.enqueue("09003", never);
    const extract = vi.fn(never);
    const { get } = setup({ queue, extract });
    const [a, b] = await Promise.all([
      get("cve_mun=09015&q=reforma"),
      get("cve_mun=09016&q=reforma"),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 429]);
    expect(queue.size()).toBe(MAX_PENDING);
  });

  it("503 osm.cache_budget refuses a cold extraction but not a hot lookup", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cold = setup({ cacheBudgetOk: vi.fn(() => false) });
    const res = await cold.get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("osm.cache_budget");
    expect(cold.deps.extract).not.toHaveBeenCalled();

    const hot = setup({
      cacheBudgetOk: vi.fn(() => false),
      isCacheHot: vi.fn(() => true),
    });
    expect((await hot.get("cve_mun=09015&q=reforma")).status).toBe(200);
  });

  it("409 osm.bbox_too_large for a padded bbox > 1 deg² (06009 islands)", async () => {
    const { deps, get } = setup({
      fetchMunBbox: vi.fn(async () => ({
        minLon: -114.8,
        minLat: 18.3,
        maxLon: -103.66,
        maxLat: 19.08,
      })),
    });
    const res = await get("cve_mun=06009&q=reforma");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("osm.bbox_too_large");
    expect(body.error).toContain(
      "prewarm it with `scripts/osm-prewarm.ts 06009 --force`",
    );
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it(`429 osm.busy beyond ${HOT_CONCURRENCY} concurrent hot lookups; the slot frees afterwards`, async () => {
    const releases: Array<() => void> = [];
    const findStreets = vi.fn(
      () =>
        new Promise<StreetLookupResult>((ok) => releases.push(() => ok(HOT_RESULT))),
    );
    const { get } = setup({ isCacheHot: vi.fn(() => true), findStreets });
    const inflight = Array.from({ length: HOT_CONCURRENCY }, () =>
      get("cve_mun=09015&q=reforma"),
    );
    await vi.waitFor(() => expect(findStreets).toHaveBeenCalledTimes(HOT_CONCURRENCY));
    const busy = await get("cve_mun=09015&q=reforma");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect(await code(busy)).toBe("osm.busy");
    releases.forEach((r) => r());
    expect((await Promise.all(inflight)).map((r) => r.status)).toEqual(
      Array(HOT_CONCURRENCY).fill(200),
    );
    const after = get("cve_mun=09015&q=reforma");
    await vi.waitFor(() => expect(releases).toHaveLength(HOT_CONCURRENCY + 1));
    releases[HOT_CONCURRENCY]!();
    expect((await after).status).toBe(200);
  });

  it("a failed lookup frees its hot slot", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const findStreets = vi
      .fn<(p: string, q: string) => Promise<StreetLookupResult>>()
      .mockRejectedValue(new Error("EIO"));
    const { get } = setup({ isCacheHot: vi.fn(() => true), findStreets });
    for (let i = 0; i < HOT_CONCURRENCY + 1; i++) {
      expect((await get("cve_mun=09015&q=reforma")).status).toBe(500);
    }
  });

  it("re-checks the budget when the queued job starts: 503 osm.cache_budget once, no extraction", async () => {
    // Passes at admission, fails when the job runs (an earlier job filled the cache).
    const cacheBudgetOk = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const { deps, get } = setup({ cacheBudgetOk });
    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
    await vi.waitFor(() => expect(cacheBudgetOk).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.extract).not.toHaveBeenCalled();

    const res = await get("cve_mun=09015&q=reforma");
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("osm.cache_budget");
    // Reported once; the next request re-queues.
    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
    await vi.waitFor(() => expect(deps.extract).toHaveBeenCalledTimes(1));
  });

  it(`429 osm.cold_limit on the ${COLD_EXTRACT_LIMIT.max + 1}th cold admission per principal+IP; hits never count`, async () => {
    const extract = vi.fn(async () => undefined as unknown);
    let hot = false;
    const { deps, get } = setup({
      extract,
      isCacheHot: vi.fn(() => hot),
      coldKey: (c) => `p:${c.req.header("x-api-key") ? "apikey" : "-"}|ip:test`,
    });
    const cve = (i: number) => `09${String(100 + i).padStart(3, "0")}`;
    for (let i = 0; i < COLD_EXTRACT_LIMIT.max; i++) {
      // Sequential, and each job drains before the next, so the queue cap never bites.
      expect((await get(`cve_mun=${cve(i)}&q=reforma`)).status).toBe(202);
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(i + 1));
      await new Promise((r) => setTimeout(r, 0));
    }
    const res = await get(`cve_mun=${cve(99)}&q=reforma`);
    expect(res.status).toBe(429);
    expect(await code(res)).toBe("osm.cold_limit");
    const retry = Number(res.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(3500);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(deps.fetchMunBbox).toHaveBeenCalledTimes(COLD_EXTRACT_LIMIT.max);

    // Hot lookups are served and never counted.
    hot = true;
    for (let i = 0; i < 5; i++) {
      expect((await get(`cve_mun=${cve(i)}&q=reforma`)).status).toBe(200);
    }
    // Another principal has its own bucket; the X-Api-Key is not exempt.
    hot = false;
    const key = { "x-api-key": "k" };
    for (let i = 0; i < COLD_EXTRACT_LIMIT.max; i++) {
      expect((await get(`cve_mun=${cve(20 + i)}&q=reforma`, key)).status).toBe(202);
      await vi.waitFor(() =>
        expect(extract).toHaveBeenCalledTimes(COLD_EXTRACT_LIMIT.max + i + 1),
      );
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((await get(`cve_mun=${cve(98)}&q=reforma`, key)).status).toBe(429);
  });

  it("hot lookups do not consume cold admissions", async () => {
    const { deps, get } = setup({ isCacheHot: vi.fn(() => true) });
    for (let i = 0; i < COLD_EXTRACT_LIMIT.max + 5; i++) {
      expect((await get("cve_mun=09015&q=reforma")).status).toBe(200);
    }
    (deps.isCacheHot as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
  });

  it("a lock held by the prewarm CLI is not reported as a failure", async () => {
    const extract = vi
      .fn<(cve: string, bbox: typeof BBOX) => Promise<unknown>>()
      .mockRejectedValueOnce(new OsmLockHeldError("09015", "123 456"))
      .mockResolvedValue(undefined);
    const { get } = setup({ extract });
    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect((await get("cve_mun=09015&q=reforma")).status).toBe(202);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
  });
});
