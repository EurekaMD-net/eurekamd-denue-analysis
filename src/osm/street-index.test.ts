import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_COLLECTED_VERTICES,
  MAX_MATCHES,
  MAX_VERTICES,
  findStreets,
  groupMatches,
  haversineM,
  lineLengthM,
  normalizeName,
  parseFeatureLine,
  readFeatures,
  type Position,
  type RoadFeature,
} from "./street-index.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/roads.sample.geojsonseq", import.meta.url),
);

const feat = (
  name: string,
  coords: Position[],
  extra: Record<string, unknown> = {},
): RoadFeature => ({
  properties: { highway: "residential", name, ...extra },
  coordinates: coords,
});

describe("normalizeName", () => {
  it("strips accents, lower-cases and collapses whitespace", () => {
    expect(normalizeName("  Calle   Álvaro\tObregón ")).toBe(
      "calle alvaro obregon",
    );
    expect(normalizeName("PEÑA")).toBe("pena");
    expect(normalizeName("Río Reforma")).toBe("rio reforma");
  });

  it("does not expand abbreviations (substring match only)", () => {
    const r = groupMatches(
      [feat("Av. Juárez", [[-99.1, 19.4], [-99.11, 19.4]])],
      "avenida juarez",
    );
    expect(r.matches).toEqual([]);
    const r2 = groupMatches(
      [feat("Av. Juárez", [[-99.1, 19.4], [-99.11, 19.4]])],
      "JUAREZ",
    );
    expect(r2.matches.map((m) => m.name)).toEqual(["Av. Juárez"]);
  });
});

describe("haversine", () => {
  it("measures ~111.2 km per degree of latitude", () => {
    expect(haversineM([-99, 19], [-99, 20])).toBeGreaterThan(111_100);
    expect(haversineM([-99, 19], [-99, 20])).toBeLessThan(111_300);
  });

  it("sums a polyline and is 0 for a single point", () => {
    const a: Position = [-99.17, 19.43];
    const b: Position = [-99.16, 19.43];
    const c: Position = [-99.15, 19.43];
    expect(lineLengthM([a, b, c])).toBeCloseTo(
      haversineM(a, b) + haversineM(b, c),
      6,
    );
    expect(lineLengthM([a])).toBe(0);
    // 0.01° of longitude at 19.43°N ≈ 1049 m
    expect(haversineM(a, b)).toBeGreaterThan(1040);
    expect(haversineM(a, b)).toBeLessThan(1060);
  });
});

describe("parseFeatureLine", () => {
  it("accepts an RS-prefixed LineString and rejects everything else", () => {
    const line = JSON.stringify({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[1, 2], [3, 4]] },
      properties: { name: "x" },
    });
    expect(parseFeatureLine(`\x1e${line}`)?.coordinates).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parseFeatureLine("{not json")).toBeNull();
    expect(
      parseFeatureLine(
        JSON.stringify({ geometry: { type: "Point", coordinates: [1, 2] } }),
      ),
    ).toBeNull();
    expect(
      parseFeatureLine(
        JSON.stringify({
          geometry: { type: "LineString", coordinates: [[1, "a"], [3, 4]] },
        }),
      ),
    ).toBeNull();
  });
});

describe("readFeatures (streaming)", () => {
  it("yields every valid record and counts the malformed line", async () => {
    const stats = { malformed: 0 };
    const names: unknown[] = [];
    for await (const f of readFeatures(FIXTURE, stats)) {
      names.push(f.properties["name"]);
    }
    expect(names).toHaveLength(9);
    expect(stats.malformed).toBe(1);
    expect(names).toContain("Calle Álvaro Obregón"); // RS-prefixed line
  });
});

describe("findStreets on the fixture", () => {
  it("groups by exact normalised name, sorted by length desc", async () => {
    const r = await findStreets(FIXTURE, "reforma");
    expect(r.malformed).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.matches.map((m) => m.name)).toEqual([
      "Paseo de la Reforma",
      "Eje 2 Norte", // via alt_name "Calzada Reformadores"
      "Paseo de la Reforma Norte",
      "Calle Río Reforma",
    ]);
    const reforma = r.matches[0]!;
    expect(reforma.segments).toBe(2);
    expect(reforma.highway).toEqual(["primary", "trunk"]);
    expect(reforma.geometry.type).toBe("MultiLineString");
    expect(reforma.geometry.coordinates).toHaveLength(2);
    // 0.02° of longitude at 19.43°N ≈ 2.1 km
    expect(reforma.length_m).toBeGreaterThan(2080);
    expect(reforma.length_m).toBeLessThan(2120);
  });

  it("matches accent-insensitively and on alt_name", async () => {
    const r = await findStreets(FIXTURE, "ALVARO obregon");
    expect(r.matches.map((m) => m.name)).toEqual(["Calle Álvaro Obregón"]);
    const alt = await findStreets(FIXTURE, "manuel gonzález");
    expect(alt.matches.map((m) => m.name)).toEqual(["Eje 2 Norte"]);
  });

  it("returns no matches for an absent name", async () => {
    const r = await findStreets(FIXTURE, "zzz no existe");
    expect(r.matches).toEqual([]);
  });
});

describe("groupMatches caps", () => {
  it("rounds coordinates to 6 dp", () => {
    const r = groupMatches(
      [feat("Calle A", [[-99.123456789, 19.987654321], [-99.2, 19.9]])],
      "calle a",
    );
    expect(r.matches[0]!.geometry.coordinates[0]![0]).toEqual([
      -99.123457, 19.987654,
    ]);
  });

  it(`keeps at most ${MAX_MATCHES} groups, longest first`, () => {
    const fs = Array.from({ length: MAX_MATCHES + 5 }, (_, i) =>
      feat(`Calle ${i}`, [[-99, 19], [-99, 19 + (i + 1) * 0.001]]),
    );
    const r = groupMatches(fs, "calle");
    expect(r.matches).toHaveLength(MAX_MATCHES);
    expect(r.truncated).toBe(true);
    expect(r.matches[0]!.name).toBe(`Calle ${MAX_MATCHES + 4}`);
  });

  it(`drops later matches beyond ${MAX_VERTICES} vertices and clips only the first`, () => {
    const long = (n: number): Position[] =>
      Array.from({ length: n }, (_, i) => [-99 + i * 1e-4, 19] as Position);
    // A: 3 segments x 8000 vertices (longest); B: shorter.
    const fs = [
      feat("Calle A", long(8000)),
      feat("Calle A", long(8000)),
      feat("Calle A", long(8000)),
      feat("Calle B", long(100)),
    ];
    const r = groupMatches(fs, "calle");
    expect(r.truncated).toBe(true);
    expect(r.matches).toHaveLength(1);
    const a = r.matches[0]!;
    expect(a.truncated).toBe(true);
    expect(a.segments).toBe(3); // full street stats
    expect(a.geometry.coordinates).toHaveLength(2); // 16,000 vertices fit
  });

  it("drops a non-first match that does not fit", () => {
    const long = (n: number): Position[] =>
      Array.from({ length: n }, (_, i) => [-99 + i * 1e-3, 19] as Position);
    const fs = [
      feat("Calle A", long(15_000)),
      feat("Calle B", long(6_000)),
      feat("Calle C", long(10)),
    ];
    const r = groupMatches(fs, "calle");
    expect(r.matches.map((m) => m.name)).toEqual(["Calle A"]);
    expect(r.matches[0]!.truncated).toBeUndefined();
    expect(r.truncated).toBe(true);
  });
});

describe("findStreets collection cap", () => {
  it(`stops reading once hits exceed ${MAX_COLLECTED_VERTICES} vertices and flags truncated`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "street-index-"));
    try {
      const path = join(dir, "big.geojsonseq");
      const coords = Array.from({ length: 1000 }, (_, i) => [-99 + i * 1e-5, 19]);
      const n = MAX_COLLECTED_VERTICES / 1000 + 20; // 100 features, 100k vertices
      const lines = Array.from({ length: n }, (_, i) =>
        JSON.stringify({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: { highway: "residential", name: `Calle ${i}` },
        }),
      );
      // A malformed line after the cut is never reached.
      writeFileSync(path, lines.join("\n") + "\n{broken\n");
      const r = await findStreets(path, "calle");
      expect(r.truncated).toBe(true);
      expect(r.malformed).toBe(0);
      expect(r.matches.length).toBeLessThanOrEqual(MAX_MATCHES);
      const vertices = r.matches.reduce(
        (sum, m) => sum + m.geometry.coordinates.reduce((a, l) => a + l.length, 0),
        0,
      );
      expect(vertices).toBeLessThanOrEqual(MAX_VERTICES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
