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
  it("returns rows and sums total_loaded correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => SAMPLE_ROWS,
      }),
    );

    const report = await coverageReport(BASE_CONFIG);
    expect(report.rows).toHaveLength(2);
    expect(report.total_loaded).toBe(45000 + 98711);
    expect(report.entidades_loaded).toBe(2);
  });

  it("calls the mv_coverage endpoint with correct URL and auth headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);

    await coverageReport(BASE_CONFIG);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/mv_coverage");
    expect(url).toContain("order=entidad.asc");
    const headers = opts.headers as Record<string, string>;
    expect(headers["apikey"]).toBe("test-key");
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("throws a descriptive error on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "relation does not exist",
      }),
    );

    await expect(coverageReport(BASE_CONFIG)).rejects.toThrow("HTTP 404");
  });

  it("handles empty result (no states loaded yet)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    const report = await coverageReport(BASE_CONFIG);
    expect(report.total_loaded).toBe(0);
    expect(report.entidades_loaded).toBe(0);
  });
});

describe("formatCoverageReport", () => {
  it("includes a TOTAL line with correct sum", () => {
    const report = { rows: SAMPLE_ROWS, total_loaded: 143711, entidades_loaded: 2 };
    const out = formatCoverageReport(report);
    expect(out).toContain("143711");
    expect(out).toContain("2 entidades");
  });

  it("includes a row for each entidad", () => {
    const report = { rows: SAMPLE_ROWS, total_loaded: 143711, entidades_loaded: 2 };
    const out = formatCoverageReport(report);
    expect(out).toContain("06");
    expect(out).toContain("09");
    expect(out).toContain("98711");
  });

  it("formats geo% correctly (2 decimal places)", () => {
    const singleRow: CoverageRow = {
      entidad: "01",
      loaded: 1000,
      with_geom: 750,
      with_telefono: 500,
      with_correo_e: 100,
      first_loaded_at: null,
      last_updated_at: null,
    };
    const out = formatCoverageReport({ rows: [singleRow], total_loaded: 1000, entidades_loaded: 1 });
    expect(out).toContain("75.0");
  });

  it("handles zero loaded without dividing by zero", () => {
    const zeroRow: CoverageRow = {
      entidad: "32",
      loaded: 0,
      with_geom: 0,
      with_telefono: 0,
      with_correo_e: 0,
      first_loaded_at: null,
      last_updated_at: null,
    };
    const out = formatCoverageReport({ rows: [zeroRow], total_loaded: 0, entidades_loaded: 1 });
    expect(out).toContain("0.0");
  });

  it("shows '—' for missing first_loaded_at", () => {
    const noDate: CoverageRow = {
      entidad: "15",
      loaded: 50,
      with_geom: 50,
      with_telefono: 10,
      with_correo_e: 2,
      first_loaded_at: null,
      last_updated_at: null,
    };
    const out = formatCoverageReport({ rows: [noDate], total_loaded: 50, entidades_loaded: 1 });
    expect(out).toContain("—");
  });
});
