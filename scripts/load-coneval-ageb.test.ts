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
// Keep the real readFileSync: _psql-tx reads sage-role.sql for the grants.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
  statSync: mockStat,
}));

import {
  CREATE_TABLE_SQL,
  POST_LOAD_SQL,
  buildConevalAgebReloadSql,
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
  it("CREATE_TABLE_SQL drops + creates the staging table with 21 TEXT columns", () => {
    expect(CREATE_TABLE_SQL).toContain(
      "DROP TABLE IF EXISTS coneval_grs_ageb_raw_staging;",
    );
    expect(CREATE_TABLE_SQL).not.toMatch(/CASCADE/);
    expect(CREATE_TABLE_SQL).toContain("CREATE TABLE coneval_grs_ageb_raw_staging (");
    expect(CREATE_TABLE_SQL).toContain("cvegeo TEXT NOT NULL");
    expect(CREATE_TABLE_SQL).toContain("grado TEXT");
    // 17 indicator columns + cvegeo + pobtot + vivpar_hab + grado = 21
    const matches = CREATE_TABLE_SQL.match(/\b\w+ TEXT/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(21);
  });

  it("POST_LOAD_SQL carries no BEGIN/COMMIT: it runs inside the reload's single transaction (qa-audit C3, audit #145)", () => {
    expect(POST_LOAD_SQL).not.toMatch(/\b(BEGIN|COMMIT);/);
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

describe("buildConevalAgebReloadSql (audit #145)", () => {
  it("staging \\copy before any live DROP; explicit view drop; swap; view; grants", () => {
    const sql = buildConevalAgebReloadSql("/tmp/coneval_grs_ageb.csv");
    const copy = sql.indexOf(
      "\\copy coneval_grs_ageb_raw_staging FROM '/tmp/coneval_grs_ageb.csv' WITH (FORMAT csv, HEADER true, NULL '*')",
    );
    const dropView = sql.indexOf("DROP VIEW IF EXISTS coneval_grs_ageb;");
    const dropRaw = sql.indexOf("DROP TABLE IF EXISTS coneval_grs_ageb_raw;");
    const swap = sql.indexOf(
      "ALTER TABLE coneval_grs_ageb_raw_staging RENAME TO coneval_grs_ageb_raw;",
    );
    const view = sql.indexOf("CREATE OR REPLACE VIEW coneval_grs_ageb");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(dropView);
    expect(dropView).toBeLessThan(dropRaw);
    expect(dropRaw).toBeLessThan(swap);
    expect(swap).toBeLessThan(view);
    expect(sql).not.toMatch(/CASCADE/);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT);/);
    expect(sql).toContain("GRANT SELECT ON coneval_grs_ageb TO denue_sage;");
  });
});

describe("loadConevalAgeb — C1 force-required-on-populated guard", () => {
  it("refuses to drop a populated table without --force", async () => {
    mockFsHeader(VALID_HEADER);
    // to_regclass says present; COUNT(*) returns 50000 — populated.
    mockExec.mockImplementation((_cmd, args) => {
      if (!Array.isArray(args)) return "";
      const sql = (args as string[]).join(" ");
      if (sql.includes("to_regclass('coneval_grs_ageb_raw')")) return "t\n";
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

  it("proceeds when to_regclass reports the table absent (first load)", async () => {
    mockFsHeader(VALID_HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      if (!Array.isArray(args)) return "";
      const sql = (args as string[]).join(" ");
      if (sql.includes("to_regclass('coneval_grs_ageb_raw') IS NOT NULL")) {
        return "f\n";
      }
      if (sql.includes("to_regclass")) return "";
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
    // Audit #145: the reload is ONE single-transaction psql session.
    const txs = mockExec.mock.calls.filter((c) =>
      (c[1] as string[]).includes("--single-transaction"),
    );
    expect(txs).toHaveLength(1);
    expect((txs[0]?.[2] as { input: string }).input).toBe(
      buildConevalAgebReloadSql("/tmp/coneval_grs_ageb.csv"),
    );
  });

  it("rethrows a failed COUNT probe instead of treating it as 'absent' (audit #157)", async () => {
    mockFsHeader(VALID_HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      if (!Array.isArray(args)) return "";
      const sql = (args as string[]).join(" ");
      if (sql.includes("to_regclass('coneval_grs_ageb_raw')")) return "t\n";
      if (sql.includes("SELECT COUNT(*) FROM coneval_grs_ageb_raw")) {
        throw new Error("canceling statement due to statement timeout");
      }
      return "";
    });
    await expect(
      loadConevalAgeb({ csvPath: "/tmp/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/statement timeout/);
    expect(
      mockExec.mock.calls.some((c) => (c[2] as { input?: string })?.input),
    ).toBe(false);
  });

  it("--force allows re-load even with populated table", async () => {
    mockFsHeader(VALID_HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      if (!Array.isArray(args)) return "";
      const sql = (args as string[]).join(" ");
      if (sql.includes("to_regclass")) return "";
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
  it("emits \\copy with NULL '*' so INEGI confidentiality sentinels collapse to NULL", () => {
    const copySql = buildConevalAgebReloadSql("/tmp/coneval_grs_ageb.csv")
      .split("\n")
      .find((l) => l.startsWith("\\copy"));
    expect(copySql).toBeDefined();
    expect(copySql).toContain("FORMAT csv");
    expect(copySql).toContain("HEADER true");
    expect(copySql).toContain("NULL '*'");
  });
});
