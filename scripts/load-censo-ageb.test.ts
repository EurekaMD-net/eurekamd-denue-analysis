import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

const { mockOpen, mockRead, mockClose } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockRead: vi.fn(),
  mockClose: vi.fn(),
}));
vi.mock("node:fs", () => ({
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
}));

import {
  POST_LOAD_SQL,
  buildCensoAgebCreateTable,
  loadCensoAgeb,
  runPostLoad,
} from "./load-censo-ageb.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const HEADER = "ENTIDAD,NOM_ENT,MUN,NOM_MUN,LOC,NOM_LOC,AGEB,MZA,POBTOT,POBFEM";

/** Mock fs to return a 2-line CSV: header + one data row starting "21,..." */
function mockFsForState(entidad: string): void {
  const csv = `${HEADER}\n${entidad},Puebla,114,Puebla,0001,Heroica Puebla,0412,000,1234,600\n`;
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from(csv, "utf-8");
    bytes.copy(buf);
    return bytes.length;
  });
  mockClose.mockReturnValue(undefined);
}

describe("buildCensoAgebCreateTable", () => {
  it("strips BOM, lowercases, quotes columns, requires entidad/mun/loc/ageb/mza", () => {
    const sql = buildCensoAgebCreateTable("﻿" + HEADER);
    expect(sql).toContain("DROP TABLE IF EXISTS censo_ageb_raw CASCADE");
    expect(sql).toContain('"entidad" TEXT');
    expect(sql).toContain('"ageb" TEXT');
    expect(sql).toContain('"mza" TEXT');
    expect(sql).toContain('"pobtot" TEXT');
  });

  it("rejects header with too few columns", () => {
    expect(() => buildCensoAgebCreateTable("a,b,c,d,e,f,g")).toThrow(
      /≥8 columns/,
    );
  });

  it("rejects header missing required keys", () => {
    expect(() =>
      buildCensoAgebCreateTable(
        "entidad,nom_ent,mun,nom_mun,loc,nom_loc,ageb,pobtot",
      ),
    ).toThrow(/missing required column "mza"/);
  });

  it("rejects unsafe column names (defense against malformed header)", () => {
    expect(() =>
      buildCensoAgebCreateTable(
        "entidad,mun,loc,ageb,mza,nom_loc,pob;DROP TABLE--,extra",
      ),
    ).toThrow(/unsafe column name/);
  });
});

describe("POST_LOAD_SQL", () => {
  it("filters censo_ageb view to AGEB-level rows (mza='000' AND ageb!='0000'/'*' AND loc/mun similar)", () => {
    // Equality predicates only — regex-based filters made the view
    // non-sargable on the cvegeo index (1s per single-cvegeo lookup vs
    // 5ms with equality + index). qa-audit W4 hardening relaxed.
    expect(POST_LOAD_SQL).toContain("mza = '000'");
    expect(POST_LOAD_SQL).toMatch(/ageb != '0000' AND ageb != '\*'/);
    expect(POST_LOAD_SQL).toMatch(/loc != '0000' AND loc != '\*'/);
    expect(POST_LOAD_SQL).toMatch(/mun != '000' AND mun != '\*'/);
  });

  it("derives cvegeo as ENTIDAD || MUN || LOC || AGEB (13 chars)", () => {
    expect(POST_LOAD_SQL).toContain("entidad || mun || loc || ageb");
  });

  it("creates separate censo_manzana view filtered to numeric mza only", () => {
    expect(POST_LOAD_SQL).toMatch(/CREATE OR REPLACE VIEW censo_manzana AS/);
    expect(POST_LOAD_SQL).toMatch(
      /mza != '000' AND mza != '\*' AND mza ~ '\^\[0-9\]\+\$'/,
    );
  });

  it("uses NULLIF on '*' INEGI null marker before int cast (no cast errors on missing data)", () => {
    expect(POST_LOAD_SQL).toMatch(/NULLIF\(pobtot, '\*'\)::int/);
    expect(POST_LOAD_SQL).toMatch(/NULLIF\(pea, '\*'\)::int/);
    expect(POST_LOAD_SQL).toMatch(/NULLIF\(graproes, '\*'\)::numeric/);
  });

  it("creates indexes idempotently (re-run safe)", () => {
    expect(POST_LOAD_SQL).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it("creates BOTH partial and non-partial cvegeo index (qa-audit C2)", () => {
    // Partial: AGEB-level fast path. Non-partial: LEFT JOIN cab.cvegeo = a.cvegeo
    // in agebFarmaciaOpportunitySql. Postgres planner doesn't always prove
    // the partial index's predicate matches the LEFT JOIN, so the non-partial
    // backup ensures the join is indexed regardless.
    expect(POST_LOAD_SQL).toMatch(
      /idx_censo_ageb_raw_cvegeo_ageb_only.*WHERE mza/s,
    );
    expect(POST_LOAD_SQL).toMatch(/idx_censo_ageb_raw_cvegeo[^_]/);
  });

  it("wraps everything in BEGIN/COMMIT for atomic readers (qa-audit C3)", () => {
    // Without the transaction, DROP VIEW + CREATE VIEW gives a ~10ms gap
    // where concurrent ageb-detail / ageb-farmacia-opportunity requests
    // would 502. CREATE OR REPLACE is also used (preserves OID), but the
    // BEGIN/COMMIT hardens against any future statement that DROPs first.
    expect(POST_LOAD_SQL).toMatch(/^\s*BEGIN;/);
    expect(POST_LOAD_SQL).toMatch(/COMMIT;\s*$/);
  });
});

describe("loadCensoAgeb", () => {
  it("rejects malformed dbContainer before any docker call", async () => {
    mockFsForState("21");
    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/x.csv",
        dbContainer: "bad container",
        append: false,
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects leading-dash csvPath (arg-injection defense)", async () => {
    await expect(
      loadCensoAgeb({
        csvPath: "-rm",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/csvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects empty csvPath", async () => {
    await expect(
      loadCensoAgeb({
        csvPath: "",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects CSV whose first data row has invalid ENTIDAD", async () => {
    const badCsv = `${HEADER}\nXX,Foo,114,Bar,0001,Baz,0412,000,1,2\n`;
    mockOpen.mockReturnValue(7);
    mockRead.mockImplementation((_fd, buf) => {
      const bytes = Buffer.from(badCsv, "utf-8");
      bytes.copy(buf);
      return bytes.length;
    });
    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/bad.csv",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/ENTIDAD invalid/);
  });

  it("first state: pre-flight COUNT (relation missing) → DROP+CREATE → cp → \\copy → cleanup → 2 counts", async () => {
    mockFsForState("21");
    // qa-audit C1 (2026-05-05): pre-flight COUNT runs BEFORE the DROP. On
    // a first-ever load the relation does not exist, so the COUNT throws
    // — the loader catches it, treats existingRows=0, and proceeds to DROP.
    // Order: COUNT (throws), createSql, cp, \copy, rm cleanup, state count, total count
    mockExec
      .mockImplementationOnce(() => {
        throw new Error('relation "censo_ageb_raw" does not exist');
      })
      .mockReturnValueOnce("") // createSql
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("COPY 5234") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("5234") // state count
      .mockReturnValueOnce("5234"); // total count

    const result = await loadCensoAgeb({
      csvPath: "/tmp/conjunto_de_datos_ageb_urbana_21_cpv2020.csv",
      dbContainer: "supabase-db",
      append: false,
    });

    expect(result.entidad).toBe("21");
    expect(result.rows_loaded_state).toBe(5234);
    expect(result.rows_loaded_total).toBe(5234);

    // 2nd call should be CREATE TABLE (1st was the pre-flight COUNT).
    const createSql =
      mockExec.mock.calls[1]?.[1]?.[mockExec.mock.calls[1]![1]!.length - 1];
    expect(createSql).toContain("DROP TABLE IF EXISTS censo_ageb_raw");
    expect(createSql).toContain("CREATE TABLE censo_ageb_raw");
  });

  it("REFUSES non-append load when table has data and --force is absent (qa-audit C1)", async () => {
    mockFsForState("21");
    // Pre-flight COUNT returns "1500000" — meaning prior states are loaded.
    // Without --force, the loader must throw BEFORE the DROP runs.
    mockExec.mockReturnValueOnce("1500000");

    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/conjunto_de_datos_ageb_urbana_21_cpv2020.csv",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/already has 1,500,000 rows.*--append.*--force/);

    // Only the COUNT was called — no DROP, no \copy.
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("PROCEEDS with --force when table has data (overrides C1 guard)", async () => {
    mockFsForState("21");
    mockExec
      .mockReturnValueOnce("") // createSql (COUNT pre-flight skipped because force=true)
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("COPY 5234") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("5234")
      .mockReturnValueOnce("5234");

    const result = await loadCensoAgeb({
      csvPath: "/tmp/x.csv",
      dbContainer: "supabase-db",
      append: false,
      force: true,
    });

    expect(result.entidad).toBe("21");
    // 1st call should be CREATE TABLE directly (no COUNT pre-flight).
    const firstSql =
      mockExec.mock.calls[0]?.[1]?.[mockExec.mock.calls[0]![1]!.length - 1];
    expect(firstSql).toContain("DROP TABLE IF EXISTS censo_ageb_raw");
  });

  it("subsequent state with --append: DELETE WHERE entidad → cp → \\copy → cleanup → counts", async () => {
    mockFsForState("09");
    mockExec
      .mockReturnValueOnce("DELETE 0") // DELETE WHERE entidad
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("COPY 28000") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("28000") // state count
      .mockReturnValueOnce("33234"); // total count (21 prior + 09)

    const result = await loadCensoAgeb({
      csvPath: "/tmp/conjunto_de_datos_ageb_urbana_09_cpv2020.csv",
      dbContainer: "supabase-db",
      append: true,
    });

    expect(result.entidad).toBe("09");
    expect(result.rows_loaded_state).toBe(28000);
    expect(result.rows_loaded_total).toBe(33234);

    // 1st call should be DELETE (NOT DROP TABLE)
    const firstSql =
      mockExec.mock.calls[0]?.[1]?.[mockExec.mock.calls[0]![1]!.length - 1];
    expect(firstSql).toContain(
      "DELETE FROM censo_ageb_raw WHERE entidad = '09'",
    );
    expect(firstSql).not.toContain("DROP TABLE");
  });

  it("uses per-entidad temp filename (concurrent-load safe)", async () => {
    mockFsForState("21");
    mockExec.mockReturnValue("");
    mockExec
      .mockReturnValueOnce("") // createSql (force=true skips pre-flight COUNT)
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("COPY 1") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("1") // state count
      .mockReturnValueOnce("1"); // total count

    await loadCensoAgeb({
      csvPath: "/tmp/x.csv",
      dbContainer: "supabase-db",
      append: false,
      force: true,
    });

    // 2nd call is `docker cp` — destination should include /tmp/censo_ageb_21.csv
    const cpArgs = mockExec.mock.calls[1]?.[1] as string[] | undefined;
    expect(cpArgs?.[0]).toBe("cp");
    expect(cpArgs?.[3]).toMatch(/:\/tmp\/censo_ageb_21\.csv$/);
  });

  it("cleans up container temp file even if \\copy throws", async () => {
    mockFsForState("21");
    mockExec
      .mockReturnValueOnce("") // createSql (force=true skips pre-flight COUNT)
      .mockReturnValueOnce("") // cp
      .mockImplementationOnce(() => {
        throw new Error("\\copy failed: bad row");
      });

    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/x.csv",
        dbContainer: "supabase-db",
        append: false,
        force: true,
      }),
    ).rejects.toThrow(/\\copy failed/);

    // 4th call (mock index 3) should be rm cleanup
    const cleanupArgs = mockExec.mock.calls[3]?.[1] as string[] | undefined;
    expect(cleanupArgs?.[0]).toBe("exec");
    expect(cleanupArgs?.[2]).toBe("rm");
    expect(cleanupArgs?.[3]).toBe("-f");
    expect(cleanupArgs?.[4]).toMatch(/\/tmp\/censo_ageb_21\.csv$/);
  });
});

describe("runPostLoad", () => {
  it("rejects malformed dbContainer", () => {
    expect(() => runPostLoad("bad container")).toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("invokes psql with POST_LOAD_SQL", () => {
    mockExec.mockReturnValue("");
    const r = runPostLoad("supabase-db");
    expect(typeof r.duration_ms).toBe("number");
    expect(mockExec).toHaveBeenCalledOnce();
    const sql =
      mockExec.mock.calls[0]?.[1]?.[mockExec.mock.calls[0]![1]!.length - 1];
    expect(sql).toContain("CREATE OR REPLACE VIEW censo_ageb");
    expect(sql).toContain("CREATE OR REPLACE VIEW censo_manzana");
  });
});
