import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

const { mockOpen, mockRead, mockClose, mockStat } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockRead: vi.fn(),
  mockClose: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("node:fs", () => ({
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
  statSync: mockStat,
}));

import {
  CREATE_TABLE_SQL,
  POST_LOAD_SQL,
  loadCofepris,
} from "./load-cofepris.js";

const HEADER =
  "consec,nombre,giro,calle,colonia,colonia_norm,cp,localidad,localidad_norm,entidad,cve_ent,licencia,fecha_expedicion,lineas_autorizadas,estatus_licencia,estatus_establecimiento,observaciones,has_estupefacientes,has_psicotropicos,has_vacunas,has_toxoides,has_sueros_antitoxinas,has_hemoderivados,cve_mun,cvegeo_ageb,geocode_method";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
  mockStat.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function mockHeaderFs(line: string, sizeBytes = 500_000): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from(line + "\n", "utf-8");
    bytes.copy(buf);
    return bytes.length;
  });
  mockClose.mockReturnValue(undefined);
  mockStat.mockReturnValue({ size: sizeBytes });
}

describe("CREATE_TABLE_SQL", () => {
  it("declares all 26 columns with correct types", () => {
    expect(CREATE_TABLE_SQL).toContain(
      "DROP TABLE IF EXISTS cofepris_farmacias",
    );
    expect(CREATE_TABLE_SQL).toContain("CREATE TABLE cofepris_farmacias");
    expect(CREATE_TABLE_SQL).toMatch(/consec\s+TEXT NOT NULL/);
    expect(CREATE_TABLE_SQL).toMatch(/licencia\s+TEXT NOT NULL/);
    expect(CREATE_TABLE_SQL).toMatch(/fecha_expedicion\s+DATE/);
    expect(CREATE_TABLE_SQL).toMatch(
      /has_estupefacientes\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toMatch(
      /has_psicotropicos\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toMatch(
      /has_vacunas\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toMatch(
      /has_toxoides\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toMatch(
      /has_sueros_antitoxinas\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toMatch(
      /has_hemoderivados\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(CREATE_TABLE_SQL).toContain("cve_mun                   TEXT");
    expect(CREATE_TABLE_SQL).toContain("cvegeo_ageb               TEXT");
    expect(CREATE_TABLE_SQL).toContain("geocode_method            TEXT");
  });
});

describe("POST_LOAD_SQL", () => {
  it("creates 2 partial-on-Vigente indexes for the hot path (qa-audit M2 R1)", () => {
    expect(POST_LOAD_SQL).toContain("idx_cofepris_cve_mun_vigente");
    expect(POST_LOAD_SQL).toContain("idx_cofepris_cvegeo_vigente");
    // partial WHERE-clauses must match the planner predicate exactly
    expect(POST_LOAD_SQL).toMatch(
      /idx_cofepris_cve_mun_vigente[\s\S]*WHERE estatus_licencia = 'Vigente' AND cve_mun IS NOT NULL/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /idx_cofepris_cvegeo_vigente[\s\S]*WHERE estatus_licencia = 'Vigente' AND cvegeo_ageb IS NOT NULL/,
    );
    // The standalone status index from R0 was useless on a 3-cardinality column
    expect(POST_LOAD_SQL).not.toContain("idx_cofepris_status");
  });

  it("muni view counts only Vigente licenses", () => {
    expect(POST_LOAD_SQL).toContain(
      "CREATE OR REPLACE VIEW cofepris_farmacias_by_municipio",
    );
    expect(POST_LOAD_SQL).toMatch(/WHERE estatus_licencia = 'Vigente'/);
    expect(POST_LOAD_SQL).toContain("cve_mun ~ '^[0-9]{5}$'");
  });

  it("muni view exposes 6 controlados-class counts + 3 giro counts", () => {
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_estupefacientes\)\s+AS con_estupefacientes/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_psicotropicos\)\s+AS con_psicotropicos/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_vacunas\)\s+AS con_vacunas/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_toxoides\)\s+AS con_toxoides/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_sueros_antitoxinas\)\s+AS con_sueros_antitoxinas/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /COUNT\(\*\) FILTER \(WHERE has_hemoderivados\)\s+AS con_hemoderivados/,
    );
    expect(POST_LOAD_SQL).toMatch(/AS hospitalarias/);
    expect(POST_LOAD_SQL).toMatch(/AS boticas/);
    expect(POST_LOAD_SQL).toMatch(/AS droguerias/);
  });

  it("ageb view accepts both rural (9-char) and urban (13-char) cvegeo", () => {
    expect(POST_LOAD_SQL).toContain(
      "CREATE OR REPLACE VIEW cofepris_farmacias_by_ageb",
    );
    expect(POST_LOAD_SQL).toContain(
      "cvegeo_ageb ~ '^([0-9A-Z]{9}|[0-9A-Z]{13})$'",
    );
  });

  it("ageb view bundles controlados into single con_controlados flag", () => {
    expect(POST_LOAD_SQL).toMatch(
      /has_estupefacientes OR has_psicotropicos[\s\S]*has_vacunas OR has_hemoderivados/,
    );
  });

  it("wrapped in BEGIN/COMMIT (qa-audit C3 — atomic view replace)", () => {
    expect(POST_LOAD_SQL.trim().startsWith("BEGIN;")).toBe(true);
    expect(POST_LOAD_SQL.trim().endsWith("COMMIT;")).toBe(true);
  });
});

describe("loadCofepris — input validation", () => {
  it("rejects unsafe dbContainer", async () => {
    mockHeaderFs(HEADER);
    await expect(
      loadCofepris({
        csvPath: "/tmp/cofepris/farmacias_geocoded.csv",
        dbContainer: "rm -rf /; supabase",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects csvPath starting with -", async () => {
    await expect(
      loadCofepris({ csvPath: "-fake", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects empty csvPath", async () => {
    await expect(
      loadCofepris({ csvPath: "", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects header mismatch (catches schema drift)", async () => {
    mockHeaderFs("consec,nombre,WRONG_COLUMN,calle");
    await expect(
      loadCofepris({
        csvPath: "/tmp/cofepris/farmacias_geocoded.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/header mismatch/);
  });

  it("rejects suspiciously small CSV", async () => {
    mockHeaderFs(HEADER, 1000);
    await expect(
      loadCofepris({
        csvPath: "/tmp/cofepris/farmacias_geocoded.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/suspiciously small/);
  });
});

describe("loadCofepris — C1 force-required-on-populated guard", () => {
  it("refuses to drop populated table without --force", async () => {
    mockHeaderFs(HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM cofepris_farmacias"))
        return "2381\n";
      return "";
    });
    await expect(
      loadCofepris({
        csvPath: "/tmp/cofepris/farmacias_geocoded.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/already has 2381 rows.*--force/);
  });

  it("--force allows re-load and returns counts", async () => {
    mockHeaderFs(HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM cofepris_farmacias_by_municipio"))
        return "151\n";
      if (sql.includes("WHERE estatus_licencia = 'Vigente'")) return "2195\n";
      if (sql.includes("WHERE cve_mun IS NOT NULL")) return "2197\n";
      if (sql.includes("WHERE cvegeo_ageb IS NOT NULL")) return "2197\n";
      if (sql.includes("SELECT COUNT(*) FROM cofepris_farmacias"))
        return "2381\n";
      return "COPY 2381\n";
    });
    const result = await loadCofepris({
      csvPath: "/tmp/cofepris/farmacias_geocoded.csv",
      dbContainer: "supabase-db",
      force: true,
    });
    expect(result.rows_loaded).toBe(2381);
    expect(result.vigente).toBe(2195);
    expect(result.with_cve_mun).toBe(2197);
    expect(result.with_cvegeo_ageb).toBe(2197);
    expect(result.munis_in_view).toBe(151);
  });
});
