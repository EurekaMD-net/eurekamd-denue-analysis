import { describe, it, expect, vi, afterEach } from "vitest";
import {
  coverageReport,
  formatCoverageReport,
  loadInegiCounts,
  statusFor,
  type CoverageRow,
} from "./coverage-report.js";

const BASE_CONFIG = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
};

const SAMPLE_ROWS: CoverageRow[] = [
  {
    entidad: "06",
    loaded: 41745,
    with_geom: 41745,
    with_telefono: 12000,
    with_correo_e: 3000,
    first_loaded_at: "2026-05-03T18:00:00Z",
    last_updated_at: "2026-05-03T18:30:00Z",
  },
  {
    entidad: "29",
    loaded: 98692,
    with_geom: 98692,
    with_telefono: 30000,
    with_correo_e: 8000,
    first_loaded_at: "2026-05-03T17:53:00Z",
    last_updated_at: "2026-05-03T18:00:00Z",
  },
  {
    entidad: "01",
    loaded: 30000,
    with_geom: 30000,
    with_telefono: 10000,
    with_correo_e: 1000,
    first_loaded_at: "2026-05-03T18:48:00Z",
    last_updated_at: "2026-05-03T18:50:00Z",
  },
];

const SAMPLE_INEGI = {
  _verified_at: "2026-05-03",
  counts: {
    "06": 41756, // green: 41745/41756 = 99.97%
    "29": 98711, // green: 98692/98711 = 99.98%
    "01": null, // unverified
  } as Record<string, number | null>,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("statusFor", () => {
  it("returns 'unverified' when inegi_total is null", () => {
    expect(statusFor(50000, null)).toBe("unverified");
  });
  it("returns 'green' at exactly 99% coverage", () => {
    expect(statusFor(99, 100)).toBe("green");
  });
  it("returns 'yellow' between 90-99%", () => {
    expect(statusFor(95, 100)).toBe("yellow");
  });
  it("returns 'red' below 90%", () => {
    expect(statusFor(50, 100)).toBe("red");
  });
});

describe("loadInegiCounts", () => {
  it("loads the actual JSON file shipped at src/db/inegi_authoritative_counts.json", () => {
    const counts = loadInegiCounts();
    expect(counts.counts["06"]).toBe(41756); // Colima — verified today
    expect(counts.counts["29"]).toBe(98711); // Tlaxcala — verified today
    expect(counts.counts["09"]).toBeNull(); // CDMX — not verified yet
    expect(counts._verified_at).toBe("2026-05-03");
  });

  it("respects override path (for tests)", () => {
    expect(() => loadInegiCounts("/nonexistent/path.json")).toThrow();
  });
});

describe("coverageReport", () => {
  it("enriches each row with inegi_total + coverage_pct + status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE_ROWS }),
    );
    const report = await coverageReport(BASE_CONFIG, SAMPLE_INEGI);

    expect(report.rows).toHaveLength(3);
    expect(report.verified_at).toBe("2026-05-03");

    const colima = report.rows.find((r) => r.entidad === "06")!;
    expect(colima.inegi_total).toBe(41756);
    expect(colima.coverage_pct).toBeCloseTo(99.97, 1);
    expect(colima.status).toBe("green");

    const tlaxcala = report.rows.find((r) => r.entidad === "29")!;
    expect(tlaxcala.coverage_pct).toBeCloseTo(99.98, 1);
    expect(tlaxcala.status).toBe("green");

    const aguascalientes = report.rows.find((r) => r.entidad === "01")!;
    expect(aguascalientes.inegi_total).toBeNull();
    expect(aguascalientes.coverage_pct).toBeNull();
    expect(aguascalientes.status).toBe("unverified");
  });

  it("hits mv_coverage with auth headers", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);
    await coverageReport(BASE_CONFIG, SAMPLE_INEGI);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/mv_coverage");
    const headers = opts.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("test-key");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "relation does not exist",
      }),
    );
    await expect(coverageReport(BASE_CONFIG, SAMPLE_INEGI)).rejects.toThrow(
      "HTTP 404",
    );
  });
});

describe("formatCoverageReport", () => {
  it("renders status glyphs, INEGI totals, coverage%, and unverified rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE_ROWS }),
    );
    const report = await coverageReport(BASE_CONFIG, SAMPLE_INEGI);
    const out = formatCoverageReport(report);

    // Verified rows show numeric coverage
    expect(out).toContain("99.97%");
    expect(out).toContain("99.98%");
    // Unverified row shows em-dash for both inegi total and coverage
    expect(out.split("\n").find((l) => l.includes("01"))).toContain("—");
    // Green status glyph (✅) appears for entidades 06 + 29
    expect((out.match(/✅/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Unverified glyph for 01
    expect(out).toContain("❓");
    // No NaN/Infinity from the unverified row
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("Infinity");
    // Verified date in footer
    expect(out).toContain("2026-05-03");
  });
});
