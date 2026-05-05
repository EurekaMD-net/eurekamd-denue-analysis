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
  loadConevalAgeb,
} from "./load-coneval-ageb.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
  mockStat.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const VALID_HEADER =
  "cvegeo,pobtot,vivpar_hab,ind_analfabeta,ind_no_escuela_6_14,ind_no_escuela_15_24,ind_basica_incompleta,ind_sin_salud,ind_hacinamiento,ind_sin_agua,ind_sin_excusado,ind_sin_drenaje,ind_sin_luz,ind_piso_tierra,ind_sin_lavadora,ind_sin_refri,ind_sin_telfijo,ind_sin_celular,ind_sin_compu,ind_sin_internet,grado";

function mockFsHeader(line: string, sizeBytes = 5_000_000): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from(line + "\n", "utf-8");
    bytes.copy(buf);
    return bytes.length;
  });
  mockClose.mockReturnValue(undefined);
  mockStat.mockReturnValue({ size: sizeBytes });
}

describe("CREATE_TABLE_SQL + POST_LOAD_SQL constants", () => {
  it("CREATE_TABLE_SQL drops + creates raw table with 21 TEXT columns", () => {
    expect(CREATE_TABLE_SQL).toContain(
      "DROP TABLE IF EXISTS coneval_grs_ageb_raw CASCADE",
    );
    expect(CREATE_TABLE_SQL).toContain("CREATE TABLE coneval_grs_ageb_raw");
    expect(CREATE_TABLE_SQL).toContain("cvegeo TEXT NOT NULL");
    expect(CREATE_TABLE_SQL).toContain("grado TEXT");
    // 17 indicator columns + cvegeo + pobtot + vivpar_hab + grado = 21
    const matches = CREATE_TABLE_SQL.match(/\b\w+ TEXT/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(21);
  });

  it("POST_LOAD_SQL is wrapped in BEGIN/COMMIT (qa-audit C3)", () => {
    expect(POST_LOAD_SQL.trim().startsWith("BEGIN;")).toBe(true);
    expect(POST_LOAD_SQL.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("POST_LOAD_SQL creates btree on cvegeo (LEFT JOIN hot path)", () => {
    expect(POST_LOAD_SQL).toContain(
      "CREATE INDEX IF NOT EXISTS idx_coneval_grs_ageb_raw_cvegeo",
    );
    expect(POST_LOAD_SQL).toContain("ON coneval_grs_ageb_raw(cvegeo)");
  });

  it("POST_LOAD_SQL view casts indicators to numeric and filters grado allowlist", () => {
    expect(POST_LOAD_SQL).toContain("CREATE OR REPLACE VIEW coneval_grs_ageb");
    expect(POST_LOAD_SQL).toContain("NULLIF(pobtot, '*')::int");
    expect(POST_LOAD_SQL).toContain("NULLIF(ind_analfabeta, '*')::numeric");
    expect(POST_LOAD_SQL).toContain(
      "WHERE grado IN ('Muy bajo', 'Bajo', 'Medio', 'Alto', 'Muy alto')",
    );
  });

  it("uses CREATE OR REPLACE VIEW for idempotency (no DROP+CREATE race)", () => {
    expect(POST_LOAD_SQL).toContain("CREATE OR REPLACE VIEW");
    expect(POST_LOAD_SQL).not.toContain("DROP VIEW");
  });
});

describe("loadConevalAgeb — input validation", () => {
  it("rejects unsafe dbContainer", async () => {
    mockFsHeader(VALID_HEADER);
    await expect(
      loadConevalAgeb({
        csvPath: "/tmp/c.csv",
        dbContainer: "rm -rf /; supabase",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects csvPath starting with -", async () => {
    await expect(
      loadConevalAgeb({ csvPath: "-fake", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects empty csvPath", async () => {
    await expect(
      loadConevalAgeb({ csvPath: "", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects CSV with wrong header (catches XLSX→CSV converter drift)", async () => {
    // A header that swaps two columns — TEXT load wouldn't catch this until
    // the view cast fails. Pre-flight check fails first with a clear message.
    mockFsHeader(
      "cvegeo,vivpar_hab,pobtot,ind_analfabeta,ind_no_escuela_6_14,ind_no_escuela_15_24,ind_basica_incompleta,ind_sin_salud,ind_hacinamiento,ind_sin_agua,ind_sin_excusado,ind_sin_drenaje,ind_sin_luz,ind_piso_tierra,ind_sin_lavadora,ind_sin_refri,ind_sin_telfijo,ind_sin_celular,ind_sin_compu,ind_sin_internet,grado",
    );
    await expect(
      loadConevalAgeb({ csvPath: "/tmp/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/CSV header mismatch/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects suspiciously small CSV (converter emitted only header)", async () => {
    mockFsHeader(VALID_HEADER, 100);
    await expect(
      loadConevalAgeb({ csvPath: "/tmp/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/suspiciously small/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("loadConevalAgeb — C1 force-required-on-populated guard", () => {
  it("refuses to drop a populated table without --force", async () => {
    mockFsHeader(VALID_HEADER);
    // First call: COUNT(*) returns 50000 — table exists + populated.
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw")) {
        return "50000\n";
      }
      return "";
    });
    await expect(
      loadConevalAgeb({
        csvPath: "/tmp/c.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/already has 50000 rows.*--force/);
    // Should NEVER reach the DROP TABLE call.
    const dropCalls = mockExec.mock.calls.filter((c) =>
      ((c[1] as string[]) ?? []).join(" ").includes("DROP TABLE"),
    );
    expect(dropCalls.length).toBe(0);
  });

  it("proceeds when COUNT errors (relation does not exist — first load)", async () => {
    mockFsHeader(VALID_HEADER);
    let callIdx = 0;
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      callIdx++;
      if (
        sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw") &&
        callIdx === 1
      ) {
        // Simulate "relation does not exist" — load proceeds with create.
        throw new Error("relation does not exist");
      }
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw")) {
        return "61430\n";
      }
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb")) {
        return "61430\n";
      }
      return "COPY 61430\n";
    });
    const result = await loadConevalAgeb({
      csvPath: "/tmp/c.csv",
      dbContainer: "supabase-db",
    });
    expect(result.rows_loaded).toBe(61430);
    expect(result.rows_in_view).toBe(61430);
  });

  it("--force allows re-load even with populated table", async () => {
    mockFsHeader(VALID_HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw")) {
        return "61430\n";
      }
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb")) {
        return "61430\n";
      }
      return "COPY 61430\n";
    });
    const result = await loadConevalAgeb({
      csvPath: "/tmp/c.csv",
      dbContainer: "supabase-db",
      force: true,
    });
    expect(result.rows_loaded).toBe(61430);
    // C1 guard skipped — no rejection.
  });
});

describe("loadConevalAgeb — \\copy command shape", () => {
  it("emits \\copy with NULL '*' so INEGI confidentiality sentinels collapse to NULL", async () => {
    mockFsHeader(VALID_HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw")) {
        // first call (C1 guard) — table absent, error
        if (mockExec.mock.calls.length === 1) {
          throw new Error("relation does not exist");
        }
        return "61430\n";
      }
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb")) {
        return "61430\n";
      }
      return "COPY 61430\n";
    });
    await loadConevalAgeb({
      csvPath: "/tmp/c.csv",
      dbContainer: "supabase-db",
    });
    const copyCall = mockExec.mock.calls.find((c) =>
      ((c[1] as string[]) ?? []).some((arg) => arg.includes("\\copy")),
    );
    expect(copyCall).toBeDefined();
    const copySql = (copyCall![1] as string[]).find((a) =>
      a.includes("\\copy"),
    );
    expect(copySql).toContain("FORMAT csv");
    expect(copySql).toContain("HEADER true");
    expect(copySql).toContain("NULL '*'");
  });
});
