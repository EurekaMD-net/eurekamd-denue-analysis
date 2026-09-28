import { describe, it, expect, vi } from "vitest";
import { parseArgs, prewarm, type PrewarmDeps } from "./osm-prewarm.js";
import { OsmLockHeldError, type Bbox } from "../src/osm/osmium.js";

const SMALL: Bbox = { minLon: -99.18, minLat: 19.39, maxLon: -99.12, maxLat: 19.46 };
// 06009 (islands): 11.14° x 0.78° → ~8.96 deg² padded.
const HUGE: Bbox = { minLon: -114.8, minLat: 18.3, maxLon: -103.66, maxLat: 19.08 };

function deps(bboxes: Record<string, Bbox | null>, over: Partial<PrewarmDeps> = {}) {
  const log: string[] = [];
  const err: string[] = [];
  const d = {
    isCacheHot: vi.fn(() => false),
    fetchMunBbox: vi.fn(async (cve: string) => bboxes[cve] ?? null),
    extract: vi.fn(async (cve: string) => ({
      path: `/cache/${cve}.roads.geojsonseq`,
      bytes: 1e6,
      duration_ms: 1000,
    })),
    log: (m: string) => log.push(m),
    error: (m: string) => err.push(m),
    ...over,
  };
  return { d, log, err };
}

describe("parseArgs", () => {
  it("reads targets and --force in any position", () => {
    expect(parseArgs(["09015", "09014"])).toEqual({
      force: false,
      targets: ["09015", "09014"],
    });
    expect(parseArgs(["06009", "--force"])).toEqual({
      force: true,
      targets: ["06009"],
    });
    expect(parseArgs(["--force", "06009"])).toEqual({
      force: true,
      targets: ["06009"],
    });
  });

  it("reads --estado NN with or without --force", () => {
    expect(parseArgs(["--estado", "09"])).toEqual({ force: false, estado: "09" });
    expect(parseArgs(["--estado", "06", "--force"])).toEqual({
      force: true,
      estado: "06",
    });
  });

  it("rejects bad input", () => {
    for (const argv of [
      [],
      ["--force"],
      ["0901"],
      ["09015", "../x"],
      ["--estado"],
      ["--estado", "9"],
      ["--estado", "09", "09015"],
      ["--frce", "09015"],
    ]) {
      expect(parseArgs(argv), argv.join(" ")).toHaveProperty("error");
    }
  });
});

describe("prewarm", () => {
  it("skips a > 1 deg² municipio without --force and extracts the rest", async () => {
    const { d, log } = deps({ "06009": HUGE, "09015": SMALL });
    const failed = await prewarm(["06009", "09015"], false, d);
    expect(failed).toBe(0);
    expect(d.extract).toHaveBeenCalledTimes(1);
    expect(d.extract).toHaveBeenCalledWith("09015", SMALL);
    expect(log[0]).toMatch(/^06009 skip: bbox 8\.\d\d deg² > 1 deg² \(usa --force/);
  });

  it("with --force warns with the area, then extracts one at a time", async () => {
    let active = 0;
    let peak = 0;
    const { d, log } = deps(
      { "06009": HUGE, "09015": SMALL },
      {
        extract: vi.fn(async (cve: string) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return { path: `/cache/${cve}`, bytes: 1, duration_ms: 1 };
        }),
      },
    );
    const failed = await prewarm(["06009", "09015"], true, d);
    expect(failed).toBe(0);
    expect(d.extract).toHaveBeenCalledTimes(2);
    expect(d.extract).toHaveBeenNthCalledWith(1, "06009", HUGE);
    expect(peak).toBe(1);
    const warn = log.findIndex((m) => m.startsWith("06009 WARNING: bbox 8."));
    const ok = log.findIndex((m) => m.startsWith("06009 ok"));
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(ok).toBeGreaterThan(warn);
  });

  it("skips hot entries and held locks; counts unknown municipios and failures", async () => {
    const { d, log, err } = deps(
      { "09014": SMALL, "09016": SMALL },
      {
        isCacheHot: vi.fn((cve: string) => cve === "09015"),
        extract: vi.fn(async (cve: string) => {
          if (cve === "09014") throw new OsmLockHeldError(cve, "123 456");
          throw Object.assign(new Error("osmium export falló"), {
            stderrTail: "tail",
          });
        }),
      },
    );
    const failed = await prewarm(["09015", "09014", "99999", "09016"], false, d);
    expect(failed).toBe(2); // 99999 unknown + 09016 failed; the lock is a skip
    expect(log).toContain("09015 hot (skip)");
    expect(log.some((m) => m.startsWith("09014 skip: extracción de 09014 en curso"))).toBe(true);
    expect(err).toContain("99999 no existe en mun_polygons");
    expect(err.some((m) => m.startsWith("09016 FAILED: osmium export falló"))).toBe(true);
  });
});
