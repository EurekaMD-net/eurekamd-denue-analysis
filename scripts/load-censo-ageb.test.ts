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
// Keep the real readFileSync: _psql-tx reads sage-role.sql for the grants.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
}));

import {
  POST_LOAD_SQL,
  buildCensoAgebAppendSql,
  buildCensoAgebCreateTable,
  buildCensoAgebReloadSql,
  loadCensoAgeb,
  runPostLoad,
} from "./load-censo-ageb.js";

type Call = [string, string[], { input?: string } | undefined];
const calls = (): Call[] => mockExec.mock.calls as Call[];
/** The script a runPsqlScript call piped in (undefined for plain -c calls). */
const txInput = (i: number): string | undefined => calls()[i]?.[2]?.input;

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
    expect(sql).toContain("DROP TABLE IF EXISTS censo_ageb_raw;");
    expect(sql).not.toContain("CASCADE");
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

  it("carries no COMMIT of its own: it runs inside the reload's single transaction (qa-audit C3, audit #145)", () => {
    // An inner COMMIT would end runPsqlScript's --single-transaction early
    // and leave the rest of the reload autocommitted.
    expect(POST_LOAD_SQL).not.toMatch(/\bCOMMIT;/);
    expect(POST_LOAD_SQL).not.toMatch(/\bBEGIN;/);
  });
});

describe("reload scripts (audit #145 / #147)", () => {
  it("first state: staging \\copy before any live DROP, explicit view drops, swap, views, grants", () => {
    const sql = buildCensoAgebReloadSql(HEADER, "/tmp/censo_ageb_21.csv");
    const copy = sql.indexOf("\\copy censo_ageb_raw_staging FROM '/tmp/censo_ageb_21.csv'");
    const dropManzana = sql.indexOf("DROP VIEW IF EXISTS censo_manzana;");
    const dropAgeb = sql.indexOf("DROP VIEW IF EXISTS censo_ageb;");
    const dropRaw = sql.indexOf("DROP TABLE IF EXISTS censo_ageb_raw;");
    const swap = sql.indexOf("ALTER TABLE censo_ageb_raw_staging RENAME TO censo_ageb_raw;");
    const views = sql.indexOf("CREATE OR REPLACE VIEW censo_ageb AS");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(dropManzana);
    expect(dropManzana).toBeLessThan(dropRaw);
    expect(dropAgeb).toBeLessThan(dropRaw);
    expect(dropRaw).toBeLessThan(swap);
    expect(swap).toBeLessThan(views);
    expect(sql).not.toMatch(/CASCADE/);
    expect(sql).toContain("GRANT SELECT ON censo_ageb TO denue_sage;");
    expect(sql).toContain("GRANT SELECT ON censo_manzana TO denue_sage;");
  });

  it("--append: DELETE and \\copy in the same script", () => {
    expect(buildCensoAgebAppendSql("09", "/tmp/censo_ageb_09.csv")).toBe(
      "DELETE FROM censo_ageb_raw WHERE entidad = '09';\n" +
        "\\copy censo_ageb_raw FROM '/tmp/censo_ageb_09.csv' WITH (FORMAT csv, HEADER true, NULL '*')",
    );
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

  it("first state: to_regclass says absent → cp → ONE reload transaction → cleanup → counts → relation check", async () => {
    mockFsForState("21");
    // Order: to_regclass probe, cp, reload tx, rm cleanup, state count,
    // total count, to_regclass assertion.
    mockExec
      .mockReturnValueOnce("f\n") // to_regclass('censo_ageb_raw') IS NOT NULL
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("COPY 5234") // reload transaction
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("5234") // state count
      .mockReturnValueOnce("5234") // total count
      .mockReturnValueOnce(""); // nothing missing

    const result = await loadCensoAgeb({
      csvPath: "/tmp/conjunto_de_datos_ageb_urbana_21_cpv2020.csv",
      dbContainer: "supabase-db",
      append: false,
    });

    expect(result.entidad).toBe("21");
    expect(result.rows_loaded_state).toBe(5234);
    expect(result.rows_loaded_total).toBe(5234);

    expect(calls()[0]?.[1].at(-1)).toBe(
      "SELECT to_regclass('censo_ageb_raw') IS NOT NULL;",
    );
    // Audit #145: DDL, \copy, swap and views are ONE psql session.
    expect(calls()[2]?.[1]).toContain("--single-transaction");
    expect(txInput(2)).toBe(
      buildCensoAgebReloadSql(HEADER, "/tmp/censo_ageb_21.csv"),
    );
  });

  it("REFUSES non-append load when table has data and --force is absent (qa-audit C1)", async () => {
    mockFsForState("21");
    // Relation exists and holds prior states. Without --force, the loader
    // must throw BEFORE anything is copied or dropped.
    mockExec.mockReturnValueOnce("t\n").mockReturnValueOnce("1500000");

    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/conjunto_de_datos_ageb_urbana_21_cpv2020.csv",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/already has 1,500,000 rows.*--append.*--force/);

    // Only the probe + COUNT ran — no \copy, no DROP.
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("a failing COUNT probe is rethrown, never read as 'table absent' (audit #157)", async () => {
    mockFsForState("21");
    // The old guard caught every error and proceeded to DROP ... CASCADE.
    mockExec.mockReturnValueOnce("t\n").mockImplementationOnce(() => {
      throw new Error("canceling statement due to statement timeout");
    });

    await expect(
      loadCensoAgeb({
        csvPath: "/tmp/x.csv",
        dbContainer: "supabase-db",
        append: false,
      }),
    ).rejects.toThrow(/statement timeout/);
    expect(mockExec).toHaveBeenCalledTimes(2);
    for (const c of calls()) {
      expect(c[2]?.input ?? "").not.toMatch(/DROP TABLE/);
    }
  });

  it("PROCEEDS with --force when table has data (overrides C1 guard)", async () => {
    mockFsForState("21");
    mockExec
      .mockReturnValueOnce("") // cp (probe skipped because force=true)
      .mockReturnValueOnce("COPY 5234") // reload transaction
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("5234")
      .mockReturnValueOnce("5234")
      .mockReturnValueOnce(""); // nothing missing

    const result = await loadCensoAgeb({
      csvPath: "/tmp/x.csv",
      dbContainer: "supabase-db",
      append: false,
      force: true,
    });

    expect(result.entidad).toBe("21");
    // 1st call is the docker cp directly (no probe).
    expect(calls()[0]?.[1][0]).toBe("cp");
    expect(txInput(1)).toContain("DROP TABLE IF EXISTS censo_ageb_raw;");
  });

  it("subsequent state with --append: cp → DELETE + \\copy in ONE transaction → cleanup → counts", async () => {
    mockFsForState("09");
    mockExec
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("DELETE 0\nCOPY 28000") // DELETE + \copy transaction
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

    // Audit #147: the DELETE and the \copy share one single-transaction
    // session, so a failed copy can no longer leave the state empty.
    expect(calls()[1]?.[1]).toContain("--single-transaction");
    expect(txInput(1)).toBe(
      buildCensoAgebAppendSql("09", "/tmp/censo_ageb_09.csv"),
    );
    expect(txInput(1)).not.toContain("DROP TABLE");
    // No autocommitted DELETE anywhere else.
    const plainDeletes = calls().filter((c) =>
      c[1].some((a) => a.includes("DELETE FROM")),
    );
    expect(plainDeletes).toHaveLength(0);
  });

  it("uses per-entidad temp filename (concurrent-load safe)", async () => {
    mockFsForState("21");
    mockExec.mockReturnValue("");
    mockExec
      .mockReturnValueOnce("") // cp (force=true skips the probe)
      .mockReturnValueOnce("COPY 1") // reload transaction
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("1") // state count
      .mockReturnValueOnce("1"); // total count

    await loadCensoAgeb({
      csvPath: "/tmp/x.csv",
      dbContainer: "supabase-db",
      append: false,
      force: true,
    });

    // 1st call is `docker cp` — destination should include /tmp/censo_ageb_21.csv
    const cpArgs = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    expect(cpArgs?.[0]).toBe("cp");
    expect(cpArgs?.[3]).toMatch(/:\/tmp\/censo_ageb_21\.csv$/);
  });

  it("cleans up container temp file even if \\copy throws", async () => {
    mockFsForState("21");
    mockExec
      .mockReturnValueOnce("") // cp (force=true skips the probe)
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

    // 3rd call (mock index 2) should be rm cleanup
    const cleanupArgs = mockExec.mock.calls[2]?.[1] as string[] | undefined;
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

  it("runs POST_LOAD_SQL + grants as ONE single-transaction psql session", () => {
    mockExec.mockReturnValue("");
    const r = runPostLoad("supabase-db");
    expect(typeof r.duration_ms).toBe("number");
    expect(mockExec).toHaveBeenCalledOnce();
    expect(calls()[0]?.[1]).toContain("--single-transaction");
    const sql = txInput(0) ?? "";
    expect(sql).toContain("CREATE OR REPLACE VIEW censo_ageb");
    expect(sql).toContain("CREATE OR REPLACE VIEW censo_manzana");
    expect(sql).toContain("GRANT SELECT ON censo_ageb TO denue_sage;");
  });
});
