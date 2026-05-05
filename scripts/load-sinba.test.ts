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
  buildPostLoadSql,
  buildSinbaCreateTable,
  loadSinba,
} from "./load-sinba.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
  mockStat.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const HEADER =
  "CLAVE_ENTIDAD,ENTIDAD,CLAVE_MUNICIPIO,MUNICIPIO,CLUES,NOMBRE_CLUES,MES,ANIO,ADL02,ADL03,ADM02,ADM03,ADM04,AHA02,AHA03,AOB02,AOB03,FRS01,HBA01,PDM02,RUN01";

function mockHeaderFs(line: string, sizeBytes = 50_000_000): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation((_fd, buf) => {
    const bytes = Buffer.from(line + "\n", "utf-8");
    bytes.copy(buf);
    return bytes.length;
  });
  mockClose.mockReturnValue(undefined);
  mockStat.mockReturnValue({ size: sizeBytes });
}

describe("buildSinbaCreateTable", () => {
  it("lowercases columns and quotes them as TEXT", () => {
    const sql = buildSinbaCreateTable(HEADER);
    expect(sql).toContain("DROP TABLE IF EXISTS sinba_ec_raw CASCADE");
    expect(sql).toContain('"clave_entidad" TEXT');
    expect(sql).toContain('"clave_municipio" TEXT');
    expect(sql).toContain('"adm02" TEXT');
    expect(sql).toContain('"aha02" TEXT');
  });

  it("rejects header missing clave_entidad / clave_municipio / anio", () => {
    expect(() =>
      buildSinbaCreateTable(
        "FOO,BAR,BAZ,QUX,CLUES,NOMBRE_CLUES,MES,ANO,ADM02,ADM03,AHA02,AHA03,AOB02,AOB03,FRS01,HBA01,PDM02,RUN01,X,Y",
      ),
    ).toThrow(/missing required column/);
  });

  it("rejects header with too few columns", () => {
    expect(() => buildSinbaCreateTable("a,b,c,d")).toThrow(/expected ≥20/);
  });

  it("rejects unsafe column name (SQL injection guard)", () => {
    const bad = HEADER.replace("ADM02", "x;DROP TABLE");
    expect(() => buildSinbaCreateTable(bad)).toThrow(/unsafe column name/);
  });
});

describe("buildPostLoadSql", () => {
  it("produces SUM/12 averaging for ADM (DM2), AHA (HTA), AOB (obesidad)", () => {
    const sql = buildPostLoadSql(HEADER);
    // ADM has 3 columns in fixture (adm02, adm03, adm04)
    expect(sql).toContain("casos_dm2_promedio");
    expect(sql).toContain(
      "COALESCE(NULLIF(adm02, 'NULL')::int, 0) + COALESCE(NULLIF(adm03, 'NULL')::int, 0) + COALESCE(NULLIF(adm04, 'NULL')::int, 0)",
    );
    expect(sql).toContain("casos_hta_promedio");
    expect(sql).toContain(
      "COALESCE(NULLIF(aha02, 'NULL')::int, 0) + COALESCE(NULLIF(aha03, 'NULL')::int, 0)",
    );
    expect(sql).toContain("casos_obesidad_promedio");
    expect(sql).toContain(
      "COALESCE(NULLIF(aob02, 'NULL')::int, 0) + COALESCE(NULLIF(aob03, 'NULL')::int, 0)",
    );
    expect(sql).toContain("/ 12");
  });

  it("guards CVE_MUN composition against bad rows", () => {
    const sql = buildPostLoadSql(HEADER);
    expect(sql).toContain("clave_entidad ~ '^[0-9]{2}$'");
    expect(sql).toContain("clave_municipio ~ '^[0-9]{3}$'");
    expect(sql).toContain("anio ~ '^[0-9]{4}$'");
  });

  it("wraps in BEGIN/COMMIT (qa-audit C3 — atomic view replace)", () => {
    const sql = buildPostLoadSql(HEADER);
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("CREATE OR REPLACE VIEW (idempotent, no race)", () => {
    const sql = buildPostLoadSql(HEADER);
    expect(sql).toContain("CREATE OR REPLACE VIEW sinba_morbidity_municipal");
    expect(sql).not.toContain("DROP VIEW");
  });

  it("rejects header with no chronic-disease prefix columns", () => {
    expect(() =>
      buildPostLoadSql(
        "CLAVE_ENTIDAD,ENTIDAD,CLAVE_MUNICIPIO,MUNICIPIO,CLUES,NOMBRE_CLUES,MES,ANIO,X,Y,Z,A,B,C,D,E,F,G,H,I,J",
      ),
    ).toThrow(/missing chronic-disease prefix columns/);
  });
});

describe("buildPostLoadSql — anchored prefix match (qa-audit W5)", () => {
  it("ignores columns that share a prefix but aren't case-count format", () => {
    // Hypothetical drift: 2024 SINBA adds `admisiones` (admisiones hospitalarias).
    // Anchored regex /^adm\d+$/ excludes it — only adm02..adm99 contribute to DM2.
    const driftedHeader =
      "CLAVE_ENTIDAD,ENTIDAD,CLAVE_MUNICIPIO,MUNICIPIO,CLUES,NOMBRE_CLUES,MES,ANIO,ADM02,ADM03,ADMISIONES,ADM_EXTRA,AHA02,AHA03,AOB02,AOB03,FRS01,HBA01,PDM02,RUN01,X";
    const sql = buildPostLoadSql(driftedHeader);
    // ADM02 + ADM03 must appear; ADMISIONES + ADM_EXTRA must not
    expect(sql).toContain("NULLIF(adm02, 'NULL')");
    expect(sql).toContain("NULLIF(adm03, 'NULL')");
    expect(sql).not.toContain("admisiones");
    expect(sql).not.toContain("adm_extra");
  });
});

describe("loadSinba — input validation", () => {
  it("rejects unsafe dbContainer", async () => {
    mockHeaderFs(HEADER);
    await expect(
      loadSinba({
        csvPath: "/tmp/sinba.csv",
        dbContainer: "rm -rf /; supabase",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects csvPath starting with -", async () => {
    await expect(
      loadSinba({ csvPath: "-fake", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects header that doesn't start with expected prefix (catches schema drift)", async () => {
    mockHeaderFs("WRONG_HEADER,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T");
    await expect(
      loadSinba({ csvPath: "/tmp/sinba.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/CSV header doesn't start with expected/);
  });

  it("rejects suspiciously small CSV", async () => {
    mockHeaderFs(HEADER, 1000);
    await expect(
      loadSinba({ csvPath: "/tmp/sinba.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/suspiciously small/);
  });
});

describe("loadSinba — C1 force-required-on-populated guard", () => {
  it("refuses to drop populated table without --force", async () => {
    mockHeaderFs(HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM sinba_ec_raw")) return "141021\n";
      return "";
    });
    await expect(
      loadSinba({ csvPath: "/tmp/sinba.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/already has 141021 rows.*--force/);
  });

  it("--force allows re-load", async () => {
    mockHeaderFs(HEADER);
    mockExec.mockImplementation((_cmd, args) => {
      const sql = (args as string[]).join(" ");
      if (sql.includes("SELECT COUNT(*) FROM sinba_ec_raw")) return "141021\n";
      if (sql.includes("SELECT COUNT(*) FROM sinba_morbidity_municipal"))
        return "2204\n";
      return "COPY 141021\n";
    });
    const result = await loadSinba({
      csvPath: "/tmp/sinba.csv",
      dbContainer: "supabase-db",
      force: true,
    });
    expect(result.rows_loaded).toBe(141021);
    expect(result.munis_covered).toBe(2204);
  });
});
