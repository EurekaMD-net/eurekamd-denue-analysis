import { describe, it, expect, vi, afterEach } from "vitest";
import { coverageReport, formatCoverageReport } from "./coverage-report.js";
import type { CoverageRow } from "./coverage-report.js";

const BASE_CONFIG = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
};

const SAMPLE_ROWS: CoverageRow[] = [
  {
    entidad: "06",
    loaded: 45000,
    with_geom: 44000,
    with_telefono: 12000,
    with_correo_e: 3000,
    first_loaded_at: "2026-05-03T12:00:00Z",
    last_updated_at: "2026-05-03T14:00:00Z",
  },
  {
    entidad: "09",
    loaded: 98711,
    with_geom: 97000,
    with_telefono: 30000,
    with_correo_e: 8000,
    first_loaded_at: "2026-05-03T10:00:00Z",
    last_updated_at: "2026-05-03T11:00:00Z",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coverageReport", () => {
  it("returns rows, sums total_loaded, and calls mv_coverage endpoint with auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE_ROWS });
    vi.stubGlobal("fetch", mockFetch);

    const report = await coverageReport(BASE_CONFIG);

    expect(report.rows).toHaveLength(2);
    expect(report.total_loaded).toBe(45000 + 98711);
    expect(report.entidades_loaded).toBe(2);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/mv_coverage");
    const headers = opts.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("test-key");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => "relation does not exist",
    }));
    await expect(coverageReport(BASE_CONFIG)).rejects.toThrow("HTTP 404");
  });
});

describe("formatCoverageReport", () => {
  it("renders TOTAL line, per-entidad rows, geo%, and '—' for null dates", () => {
    const rowNoDate: CoverageRow = {
      entidad: "32", loaded: 0, with_geom: 0, with_telefono: 0,
      with_correo_e: 0, first_loaded_at: null, last_updated_at: null,
    };
    const report = {
      rows: [...SAMPLE_ROWS, rowNoDate],
      total_loaded: 143711,
      entidades_loaded: 3,
    };
    const out = formatCoverageReport(report);

    expect(out).toContain("143711");
    expect(out).toContain("3 entidades");
    expect(out).toContain("09");
    // geo% for entidad 06: 44000/45000 = 97.8%
    expect(out).toContain("97.8");
    // null date → em-dash
    expect(out).toContain("—");
    // zero loaded → no NaN/Infinity
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("Infinity");
  });
});
