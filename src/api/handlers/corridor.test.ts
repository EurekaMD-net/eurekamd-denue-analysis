import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunJson } = vi.hoisted(() => ({ mockRunJson: vi.fn() }));
vi.mock("../db/psql-runner.js", () => ({ runJson: mockRunJson }));

import { Hono } from "hono";
import { errorHandler } from "../middleware/error.js";
import type { ApiServerConfig } from "../types.js";
import {
  buildCorridorSql,
  bufferGeojsonFromRuns,
  corridorDensityHandler,
  coverCells,
  CORRIDOR_RATE_LIMIT,
  MAX_CANDIDATE_ROWS,
  validateCorridorRequest,
  type CorridorRequest,
} from "./corridor.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};

// ~1.1 km along Reforma (plan done-check line).
const REFORMA: [number, number][] = [
  [-99.1735, 19.4326],
  [-99.165, 19.427],
];
const line = (coordinates: unknown) => ({
  geometry: { type: "LineString", coordinates },
});

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.post("/analytics/corridor-density", (c) =>
    corridorDensityHandler(c, CONFIG),
  );
  return a;
}

function post(body: string, headers: Record<string, string> = {}) {
  return app().request("/analytics/corridor-density", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

beforeEach(() => {
  mockRunJson.mockReset();
});

describe("validateCorridorRequest", () => {
  it("accepts the plan's LineString and applies defaults", () => {
    const r = validateCorridorRequest(line(REFORMA));
    expect(r).toEqual({
      geometry: { type: "LineString", coordinates: REFORMA },
      buffer_m: 100,
      top: 10,
    });
  });

  it("accepts a MultiLineString with explicit options", () => {
    const r = validateCorridorRequest({
      geometry: { type: "MultiLineString", coordinates: [REFORMA, REFORMA] },
      buffer_m: 250,
      clase_prefix: "4641",
      top: 3,
    });
    expect(r.geometry.type).toBe("MultiLineString");
    expect(r.buffer_m).toBe(250);
    expect(r.clase_prefix).toBe("4641");
    expect(r.top).toBe(3);
  });

  it("returns fresh arrays, not the caller's references", () => {
    const coords = REFORMA.map((p) => [...p]);
    const r = validateCorridorRequest(line(coords));
    expect(r.geometry.coordinates).not.toBe(coords);
    expect(r.geometry.coordinates[0]).not.toBe(coords[0]);
  });

  it.each([
    ["non-object body", null, "validation.body"],
    ["array body", [], "validation.body"],
    ["missing geometry", {}, "validation.geometry"],
    [
      "Point type",
      { geometry: { type: "Point", coordinates: [-99, 19] } },
      "validation.geometry.type",
    ],
    [
      "Polygon type",
      { geometry: { type: "Polygon", coordinates: [REFORMA] } },
      "validation.geometry.type",
    ],
    [
      "type in lowercase",
      { geometry: { type: "linestring", coordinates: REFORMA } },
      "validation.geometry.type",
    ],
  ])("rejects %s", (_n, body, code) => {
    expect(codeOf(() => validateCorridorRequest(body))).toBe(code);
  });

  it.each([
    ["string coordinate", [["-99.1", 19.4], [-99.165, 19.427]]],
    ["string lat", [[-99.1735, "19.4326"], [-99.165, 19.427]]],
    ["NaN", [[NaN, 19.43], [-99.165, 19.427]]],
    ["Infinity", [[Infinity, 19.43], [-99.165, 19.427]]],
    ["1e400 (parses to Infinity)", JSON.parse("[[1e400, 19.43], [-99.165, 19.427]]")],
    ["null coordinate", [[null, 19.43], [-99.165, 19.427]]],
    ["3D position", [[-99.1735, 19.4326, 0], [-99.165, 19.427]]],
    ["1D position", [[-99.1735], [-99.165, 19.427]]],
    ["too deep (MultiLineString shape on LineString)", [REFORMA]],
    ["too shallow (flat pair)", [-99.1735, 19.4326]],
    ["object position", [{ lon: -99.1, lat: 19.4 }, [-99.165, 19.427]]],
    ["coordinates not an array", "LINESTRING(-99 19,-98 19)"],
    ["single vertex", [[-99.1735, 19.4326]]],
    ["empty", []],
  ])("rejects coordinates: %s", (_n, coords) => {
    expect(codeOf(() => validateCorridorRequest(line(coords)))).toBe(
      "validation.geometry.coordinates",
    );
  });

  it("rejects wrong depth on MultiLineString", () => {
    const body = {
      geometry: { type: "MultiLineString", coordinates: REFORMA },
    };
    expect(codeOf(() => validateCorridorRequest(body))).toBe(
      "validation.geometry.coordinates",
    );
    const empty = { geometry: { type: "MultiLineString", coordinates: [] } };
    expect(codeOf(() => validateCorridorRequest(empty))).toBe(
      "validation.geometry.coordinates",
    );
  });

  it.each([
    ["lon west of bbox", [[-118.6, 19.4], [-118.55, 19.4]]],
    ["lon east of bbox", [[-86.4, 19.4], [-86.45, 19.4]]],
    ["lat south of bbox", [[-99.1, 14.2], [-99.1, 14.25]]],
    ["lat north of bbox", [[-99.1, 32.9], [-99.1, 32.85]]],
    ["swapped lat,lon", [[19.4326, -99.1735], [19.427, -99.165]]],
  ])("rejects bbox: %s", (_n, coords) => {
    expect(codeOf(() => validateCorridorRequest(line(coords)))).toBe(
      "validation.geometry.bbox",
    );
  });

  it("accepts the bbox edges", () => {
    expect(() =>
      validateCorridorRequest(
        line([
          [-118.5, 14.3],
          [-118.4999, 14.3],
        ]),
      ),
    ).not.toThrow();
  });

  it("bounds vertex count at 5000", () => {
    // 5000 vertices ~5.5 m apart (27 km, inside the length/5 density cap).
    const ok = Array.from({ length: 5000 }, (_, i) => [-99.4 + i * 5.2e-5, 19.4]);
    expect(() => validateCorridorRequest(line(ok))).not.toThrow();
    const tooMany = Array.from({ length: 5001 }, (_, i) => [
      -99.4 + i * 5.2e-5,
      19.4,
    ]);
    expect(codeOf(() => validateCorridorRequest(line(tooMany)))).toBe(
      "validation.geometry.vertices",
    );
    // Across MultiLineString parts, the total counts.
    const half = ok.slice(0, 2600);
    const multi = {
      geometry: { type: "MultiLineString", coordinates: [half, half] },
    };
    expect(codeOf(() => validateCorridorRequest(multi))).toBe(
      "validation.geometry.vertices",
    );
  });

  it("bounds length 10 m .. 50 km", () => {
    // ~5.5 m
    const tooShort = [
      [-99.1735, 19.4326],
      [-99.1735, 19.43265],
    ];
    expect(codeOf(() => validateCorridorRequest(line(tooShort)))).toBe(
      "validation.geometry.length",
    );
    // Degenerate (repeated point) = 0 m: caught as a < 1 m segment.
    const zero = [
      [-99.1735, 19.4326],
      [-99.1735, 19.4326],
    ];
    expect(codeOf(() => validateCorridorRequest(line(zero)))).toBe(
      "validation.geometry.segment",
    );
    // ~55 km (0.5 deg lat)
    const tooLong = [
      [-99.1, 19.0],
      [-99.1, 19.5],
    ];
    expect(codeOf(() => validateCorridorRequest(line(tooLong)))).toBe(
      "validation.geometry.length",
    );
    // ~44 km (narrow buffer so the covered-area cap does not bind)
    const ok = [
      [-99.1, 19.0],
      [-99.1, 19.4],
    ];
    expect(() =>
      validateCorridorRequest({ ...line(ok), buffer_m: 10 }),
    ).not.toThrow();
  });

  it("rejects a segment shorter than 1 m", () => {
    const coords = [
      [-99.1735, 19.4326],
      [-99.1735, 19.432605], // ~0.55 m
      [-99.165, 19.427],
    ];
    expect(codeOf(() => validateCorridorRequest(line(coords)))).toBe(
      "validation.geometry.segment",
    );
  });

  it("rejects more than one vertex per 5 m of length", () => {
    // 100 vertices ~1.05 m apart = ~104 m, cap floor(104/5) = 20.
    const dense = Array.from({ length: 100 }, (_, i) => [-99.2 + i * 1e-5, 19.4]);
    expect(codeOf(() => validateCorridorRequest(line(dense)))).toBe(
      "validation.geometry.vertices",
    );
    // 20 vertices over the same span pass.
    const sparse = Array.from({ length: 20 }, (_, i) => [-99.2 + i * 5.2e-5, 19.4]);
    expect(() => validateCorridorRequest(line(sparse))).not.toThrow();
  });

  it("rejects an envelope diagonal over 60 km", () => {
    const coords = [
      [-99.5, 19.0],
      [-99.0, 19.4],
    ]; // ~69 km
    expect(codeOf(() => validateCorridorRequest(line(coords)))).toBe(
      "validation.geometry.extent",
    );
  });

  it("counts MultiLineString gaps toward the length bound (auditor grid)", () => {
    // 2500 disjoint 18 m parts on a 50x50 grid, 100 m apart: drawn length
    // 45 km would pass, the gaps between consecutive parts do not.
    const parts: number[][][] = [];
    for (let r = 0; r < 50; r++) {
      for (let k = 0; k < 50; k++) {
        const x = -99.2 + k * 0.001;
        const y = 19.4 + r * 0.0009;
        parts.push([
          [x, y],
          [x + 0.00017, y],
        ]);
      }
    }
    const body = { geometry: { type: "MultiLineString", coordinates: parts } };
    expect(codeOf(() => validateCorridorRequest(body))).toBe(
      "validation.geometry.length",
    );
  });

  it("rejects a corridor whose covered area exceeds the cap (49 km x 1000 m)", () => {
    const straight = [
      [-99.5, 19.4],
      [-99.5 + 49 / 105, 19.4],
    ];
    expect(
      codeOf(() => validateCorridorRequest({ ...line(straight), buffer_m: 1000 })),
    ).toBe("validation.geometry.area");
    // The same line with a 10 m buffer is fine.
    expect(() =>
      validateCorridorRequest({ ...line(straight), buffer_m: 10 }),
    ).not.toThrow();
  });

  it.each([
    [9, "validation.buffer_m"],
    [1001, "validation.buffer_m"],
    [100.5, "validation.buffer_m"],
    ["100", "validation.buffer_m"],
    [NaN, "validation.buffer_m"],
  ])("rejects buffer_m %s", (buffer_m, code) => {
    expect(
      codeOf(() => validateCorridorRequest({ ...line(REFORMA), buffer_m })),
    ).toBe(code);
  });

  it("accepts buffer_m bounds 10 and 1000", () => {
    for (const buffer_m of [10, 1000]) {
      expect(
        validateCorridorRequest({ ...line(REFORMA), buffer_m }).buffer_m,
      ).toBe(buffer_m);
    }
  });

  it.each([0, 51, 2.5, "10"])("rejects top %s", (top) => {
    expect(codeOf(() => validateCorridorRequest({ ...line(REFORMA), top }))).toBe(
      "validation.top",
    );
  });

  it("accepts top bounds 1 and 50", () => {
    for (const top of [1, 50]) {
      expect(validateCorridorRequest({ ...line(REFORMA), top }).top).toBe(top);
    }
  });

  it.each([
    "4",
    "1234567",
    "46a1",
    "4641%",
    "46'; DROP TABLE x; --",
    " 4641",
    "4641\n",
    4641,
  ])("rejects clase_prefix %j", (clase_prefix) => {
    expect(
      codeOf(() => validateCorridorRequest({ ...line(REFORMA), clase_prefix })),
    ).toBe("validation.clase_prefix");
  });

  it("accepts clase_prefix of 2 and 6 digits", () => {
    for (const p of ["46", "464111"]) {
      expect(
        validateCorridorRequest({ ...line(REFORMA), clase_prefix: p })
          .clase_prefix,
      ).toBe(p);
    }
  });
});

describe("buildCorridorSql", () => {
  const base = (extra: Partial<CorridorRequest> = {}): CorridorRequest => ({
    geometry: { type: "LineString", coordinates: REFORMA },
    buffer_m: 100,
    top: 10,
    ...extra,
  });

  it("embeds the geometry re-serialised from numbers", () => {
    const sql = buildCorridorSql(base());
    expect(sql).toContain(
      `ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[-99.1735,19.4326],[-99.165,19.427]]}')`,
    );
    expect(sql).toContain("e.geom && ST_MakeEnvelope(c.x0, c.y0, c.x1, c.y1, 4326)");
    expect(sql).toContain("g::geography AS gg");
    expect(sql).toContain("ST_DWithin(e.geom::geography, line.gg, 100)");
    expect(sql).toContain("LIMIT 10) t");
    expect(sql).toContain("'buffer_m', 100");
  });

  it("never calls GEOS buffering and never computes buffer_geojson in SQL", () => {
    const sql = buildCorridorSql(base());
    expect(sql).not.toContain("ST_Buffer");
    expect(sql).not.toContain("ST_Simplify");
    expect(sql).not.toContain("buffer_geojson");
  });

  it("caps candidates: LIMIT cap+1 on the cell scan, too_many_candidates branch before any result", () => {
    expect(MAX_CANDIDATE_ROWS).toBe(40_000);
    const sql = buildCorridorSql(base());
    const cand = sql.slice(sql.indexOf("cand AS"), sql.indexOf("hits AS"));
    expect(cand).toContain("e.geom && ST_MakeEnvelope(c.x0, c.y0, c.x1, c.y1, 4326)");
    expect(cand).toContain("LIMIT 40001");
    expect(cand).not.toContain("ST_DWithin");
    expect(sql).toContain("FROM cand e");
    expect(sql).toContain(
      "CASE WHEN (SELECT count(*) FROM cand) > 40000\n  THEN json_build_object('error', 'too_many_candidates')",
    );
    // The prefix filter applies after the cap (it saves no heap reads).
    const withPrefix = buildCorridorSql(base({ clase_prefix: "4641" }));
    const hits = withPrefix.slice(withPrefix.indexOf("hits AS"), withPrefix.indexOf("len AS"));
    expect(hits).toContain("LIKE '4641%'");
  });

  it("500-vertex zigzag at buffer 10: no ST_Buffer, buffer_geojson is a MultiPolygon of <= 500 runs", async () => {
    // 500 vertices, 6 m east per step, +-3 m north: ~3.4 km.
    const zig = Array.from({ length: 500 }, (_, i) => [
      -99.17 + (i * 6) / (111000 * Math.cos(19.43 * (Math.PI / 180))),
      19.43 + (i % 2 === 0 ? 3 : -3) / 111000,
    ]);
    const req = validateCorridorRequest({ ...line(zig), buffer_m: 10 });
    expect(buildCorridorSql(req)).not.toContain("ST_Buffer");

    mockRunJson.mockResolvedValue({ length_m: 3400, buffer_m: 10, total: 0, per_km: 0, by_clase: [] });
    const res = await post(JSON.stringify({ ...line(zig), buffer_m: 10 }));
    expect(res.status).toBe(200);
    const g = (await res.json()).buffer_geojson as {
      type: string;
      coordinates: number[][][][];
    };
    expect(g.type).toBe("MultiPolygon");
    expect(g.coordinates.length).toBeGreaterThan(0);
    expect(g.coordinates.length).toBeLessThanOrEqual(500);
    const runs = coverCells([req.geometry.coordinates as [number, number][]], 10).runs;
    expect(g.coordinates).toHaveLength(runs.length);
  });

  it("> 500 cell runs → buffer_geojson null (count still runs)", async () => {
    // Steep 100 m zigzag, 40 m apart, at buffer 10: every row crosses ~400 times.
    const zig = Array.from({ length: 401 }, (_, i) => [
      -99.17 + (i * 40) / (111000 * Math.cos(19.43 * (Math.PI / 180))),
      19.43 + (i % 2 === 0 ? 0 : 100) / 111000,
    ]);
    const req = validateCorridorRequest({ ...line(zig), buffer_m: 10 });
    const runs = coverCells([req.geometry.coordinates as [number, number][]], 10).runs;
    expect(runs.length).toBeGreaterThan(500);
    expect(bufferGeojsonFromRuns(runs)).toBeNull();

    mockRunJson.mockResolvedValue({ length_m: 43000, buffer_m: 10, total: 7, per_km: 0.16, by_clase: [] });
    const res = await post(JSON.stringify({ ...line(zig), buffer_m: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(7);
    expect(body.buffer_geojson).toBeNull();
  });

  it("a self-crossing 5000-vertex scribble in a 9 m circle is accepted but cheap (no ST_Buffer, few cells)", () => {
    // Chords of ~9.4 m round a 9 m-radius circle: 47 km, 18 m wide.
    const m = 9 / 111000;
    const scribble = Array.from({ length: 5000 }, (_, i) => [
      -99.17 + (m * Math.cos(i * 1.1)) / Math.cos(19.43 * (Math.PI / 180)),
      19.43 + m * Math.sin(i * 1.1),
    ]);
    const req = validateCorridorRequest({ ...line(scribble), buffer_m: 1000 });
    const sql = buildCorridorSql(req);
    expect(sql).not.toContain("ST_Buffer");
    const cover = coverCells([req.geometry.coordinates as [number, number][]], 1000);
    expect(cover.runs.length).toBeLessThanOrEqual(6);
    expect(cover.areaKm2).toBeLessThan(15);
  });

  it("serialises MultiLineString", () => {
    const sql = buildCorridorSql(
      base({ geometry: { type: "MultiLineString", coordinates: [REFORMA] } }),
    );
    expect(sql).toContain(
      `{"type":"MultiLineString","coordinates":[[[-99.1735,19.4326],[-99.165,19.427]]]}`,
    );
  });

  it("includes the prefix filter only when given", () => {
    expect(buildCorridorSql(base())).not.toContain("LIKE");
    const sql = buildCorridorSql(base({ clase_prefix: "4641" }));
    expect(sql).toContain("AND e.clase_actividad_id LIKE '4641%'");
  });

  it("drops unexpected properties from validated input", () => {
    const req = validateCorridorRequest({
      geometry: {
        type: "LineString",
        coordinates: REFORMA,
        crs: "'); DROP TABLE x; --",
      },
      evil: "'",
    });
    const sql = buildCorridorSql(req);
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("crs");
  });

  it("refuses non-finite numbers or an unsafe prefix even if validation was bypassed", () => {
    const nan = base({
      geometry: {
        type: "LineString",
        coordinates: [
          [NaN, 19.4],
          [-99.1, 19.4],
        ],
      },
    });
    expect(() => buildCorridorSql(nan)).toThrow();
    const strCoord = base({
      geometry: {
        type: "LineString",
        coordinates: [["-99.1", 19.4] as unknown as [number, number], [-99.1, 19.4]],
      },
    });
    expect(() => buildCorridorSql(strCoord)).toThrow();
    expect(() => buildCorridorSql(base({ clase_prefix: "4'--" }))).toThrow();
    expect(() => buildCorridorSql(base({ top: Infinity }))).toThrow();
    // num() backstop: |n| >= 1e6 never reaches the SQL text.
    expect(() => buildCorridorSql(base({ buffer_m: 1e6 }))).toThrow();
    const huge = base({
      geometry: {
        type: "LineString",
        coordinates: [
          [-99.1, 1e7],
          [-99.1, 19.4],
        ],
      },
    });
    expect(() => buildCorridorSql(huge)).toThrow();
  });
});

describe("coverCells", () => {
  // Every point within buffer_m of the line lies in exactly one half-open run.
  const cases: Array<[string, [number, number][], number]> = [
    ["Reforma, 100 m", REFORMA, 100],
    ["diagonal 10 km, 100 m", [[-99.2, 19.36], [-99.135, 19.425]], 100],
    ["N-S 3 km, 10 m", [[-99.1, 19.4], [-99.1, 19.427]], 10],
    ["E-W 5 km at lat 32.5, 1000 m", [[-115.5, 32.5], [-115.45, 32.5]], 1000],
  ];
  it.each(cases)("%s", (_n, l, b) => {
    const { runs } = coverCells([l], b);
    const [a, z] = l as [[number, number], [number, number]];
    for (let s = 0; s <= 50; s++) {
      const f = s / 50;
      const lon = a[0] + (z[0] - a[0]) * f;
      const lat = a[1] + (z[1] - a[1]) * f;
      for (let k = 0; k < 16; k++) {
        const ang = (k * Math.PI) / 8;
        const dLat = ((b * 0.999) / 111320) * Math.sin(ang);
        const dLon =
          ((b * 0.999) / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(ang);
        const x = lon + dLon;
        const y = lat + dLat;
        const inside = runs.filter(
          ([x0, x1, y0, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1,
        );
        expect(inside.length).toBe(1);
      }
    }
  });

  it("covers points just inside buffer_m at every cell-boundary phase", () => {
    // Axis-aligned lines at shifted positions put the cell boundary at
    // every phase relative to the line, so any shortfall in the expansion
    // shows up. Offsets are 0.99 of buffer_m in metres.
    const covered = (runs: ReturnType<typeof coverCells>["runs"], x: number, y: number) =>
      runs.filter(([x0, x1, y0, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1).length;
    for (const b of [10, 100, 1000]) {
      for (let k = 0; k < 40; k++) {
        const lat = 19 + k * 0.00073;
        const ew: [number, number][] = [[-99.2, lat], [-99.19, lat]];
        const dLat = (0.99 * b) / 110_574;
        const ewRuns = coverCells([ew], b).runs;
        for (const x of [-99.2, -99.195, -99.19]) {
          expect(covered(ewRuns, x, lat + dLat)).toBe(1);
          expect(covered(ewRuns, x, lat - dLat)).toBe(1);
        }
        const lon = -115 + k * 0.00073;
        const lat2 = 32.5;
        const ns: [number, number][] = [[lon, lat2 - 0.01], [lon, lat2]];
        const dLon = (0.99 * b) / (111_320 * Math.cos((lat2 * Math.PI) / 180));
        const nsRuns = coverCells([ns], b).runs;
        for (const y of [lat2 - 0.01, lat2 - 0.005, lat2]) {
          expect(covered(nsRuns, lon + dLon, y)).toBe(1);
          expect(covered(nsRuns, lon - dLon, y)).toBe(1);
        }
      }
    }
  });

  it("merges cells into disjoint runs", () => {
    const { runs } = coverCells([REFORMA], 100);
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const [a0, a1, b0, b1] = runs[i]!;
        const [c0, c1, d0, d1] = runs[j]!;
        const overlap = a0 < c1 && c0 < a1 && b0 < d1 && d0 < b1;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe("bufferGeojsonFromRuns", () => {
  it("one closed counter-clockwise lon/lat ring per run, 6 decimals; null above 500 runs", () => {
    const g = bufferGeojsonFromRuns([[-99.1234567, -99.12, 19.4, 19.4000004]]);
    expect(g).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [-99.123457, 19.4],
            [-99.12, 19.4],
            [-99.12, 19.4],
            [-99.123457, 19.4],
            [-99.123457, 19.4],
          ],
        ],
      ],
    });
    const run: [number, number, number, number] = [-99.2, -99.1, 19.4, 19.5];
    expect(bufferGeojsonFromRuns(Array(500).fill(run))!.coordinates).toHaveLength(500);
    expect(bufferGeojsonFromRuns(Array(501).fill(run))).toBeNull();
  });

  it("the runs of the Reforma line: each ring is closed and spans its run", () => {
    const { runs } = coverCells([REFORMA], 100);
    const g = bufferGeojsonFromRuns(runs)!;
    expect(g.coordinates).toHaveLength(runs.length);
    g.coordinates.forEach(([ring], k) => {
      expect(ring).toHaveLength(5);
      expect(ring![0]).toEqual(ring![4]);
      const [x0, x1, y0, y1] = runs[k]!;
      expect(ring![0]![0]).toBeCloseTo(x0, 6);
      expect(ring![1]![0]).toBeCloseTo(x1, 6);
      expect(ring![0]![1]).toBeCloseTo(y0, 6);
      expect(ring![2]![1]).toBeCloseTo(y1, 6);
    });
  });
});

describe("buildCorridorSql never emits ST_Buffer", () => {
  it.each([10, 100, 500, 1000])("buffer_m %i, LineString and MultiLineString", (buffer_m) => {
    for (const geometry of [
      { type: "LineString" as const, coordinates: REFORMA },
      { type: "MultiLineString" as const, coordinates: [REFORMA, REFORMA] },
    ]) {
      expect(buildCorridorSql({ geometry, buffer_m, top: 10 })).not.toMatch(/ST_Buffer/i);
    }
  });
});

describe("CORRIDOR_RATE_LIMIT", () => {
  it("is 20/min", () => {
    expect(CORRIDOR_RATE_LIMIT).toEqual({ max: 20, windowMs: 60_000 });
  });
});

describe("POST /analytics/corridor-density", () => {
  const RESULT = {
    length_m: 1105.2,
    buffer_m: 100,
    total: 12,
    per_km: 10.86,
    by_clase: [
      { clase_actividad_id: "464111", clase_actividad: "Farmacias sin minisúper", n: 9 },
    ],
  };

  it("returns the runJson object plus the TS-built buffer_geojson, one call, 15 s read-only", async () => {
    mockRunJson.mockResolvedValue(RESULT);
    const res = await post(
      JSON.stringify({ ...line(REFORMA), buffer_m: 100, clase_prefix: "4641" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...RESULT,
      buffer_geojson: bufferGeojsonFromRuns(coverCells([REFORMA], 100).runs),
    });
    expect(mockRunJson).toHaveBeenCalledTimes(1);
    const [sql, opts] = mockRunJson.mock.calls[0]!;
    expect(sql).toContain("LIKE '4641%'");
    expect(opts).toEqual({
      container: "test-supabase-db",
      readOnly: true,
      timeoutMs: 15_000,
    });
  });

  it("400 validation.body on invalid JSON, SQL never reached", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation.body");
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("400 validation.geometry.coordinates on a string coordinate", async () => {
    const res = await post(
      JSON.stringify(line([["-99.1", 19.4], [-99.165, 19.427]])),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation.geometry.coordinates");
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("400 validation.geometry.coordinates on 1e400 in the raw body", async () => {
    const res = await post(
      '{"geometry":{"type":"LineString","coordinates":[[1e400,19.4],[-99.165,19.427]]}}',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation.geometry.coordinates");
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("400 validation.geometry.length for an oversize line, SQL never reached", async () => {
    const res = await post(
      JSON.stringify(
        line([
          [-99.1, 19.0],
          [-99.1, 19.5],
        ]),
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation.geometry.length");
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("400 validation.geometry.area for a wide corridor, SQL never reached", async () => {
    const res = await post(
      JSON.stringify({
        ...line([
          [-99.5, 19.4],
          [-99.5 + 49 / 105, 19.4],
        ]),
        buffer_m: 1000,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation.geometry.area");
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("413 when content-length declares > 1 MB", async () => {
    const res = await post(JSON.stringify(line(REFORMA)), {
      "content-length": String(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("413 when the actual body exceeds 1 MB", async () => {
    const big = JSON.stringify({ ...line(REFORMA), pad: "x".repeat(1024 * 1024) });
    const res = await post(big);
    expect(res.status).toBe(413);
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it("400 validation.geometry.area when the statement reports too_many_candidates", async () => {
    mockRunJson.mockResolvedValue({ error: "too_many_candidates" });
    const res = await post(JSON.stringify(line(REFORMA)));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation.geometry.area");
    expect(body.error).toContain("40000");
    expect(body).not.toHaveProperty("buffer_geojson");
  });

  it("propagates an upstream 502 from the runner", async () => {
    const { HttpError } = await import("../middleware/error.js");
    mockRunJson.mockImplementation(async () => {
      throw new HttpError("Upstream query failed", 502, "postgres.error");
    });
    const res = await post(JSON.stringify(line(REFORMA)));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("postgres.error");
  });
});
