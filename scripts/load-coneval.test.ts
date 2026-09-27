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
// Keep the real readFileSync: _psql-tx reads perf-matviews.sql / sage-role.sql.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
}));

import { loadConeval, POST_LOAD_SQL_FOR_TEST } from "./load-coneval.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

/**
 * Stub fs.openSync/readSync/closeSync so loadConeval can read header lines
 * without an actual filesystem. The headers stubbed here match the real
 * INEGI/CONEVAL formats — pre-cleaned utf-8 + zero-padded cve_mun.
 */
function stubHeaders(pobrezaHeader: string, irsHeader: string): void {
  let call = 0;
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation(
    (
      _fd: number,
      buf: Buffer,
      _offset: number,
      _length: number,
      _pos: number,
    ) => {
      const text = (call++ === 0 ? pobrezaHeader : irsHeader) + "\n";
      buf.write(text, 0, "utf-8");
      return Buffer.byteLength(text, "utf-8");
    },
  );
  mockClose.mockReturnValue(undefined);
}

const VALID_POBREZA_HEADER =
  "clave_entidad,entidad_federativa,clave_municipio,municipio,poblacion,pobreza,pobreza_pob,pobreza_e";
const VALID_IRS_HEADER =
  "cve_ent,entidad,cve_mun_local,municipio,pob_total,analfabeta_15ymas,irs_indice,irs_grado,irs_lugar_nacional";

type ExecOpts = { input?: string } | undefined;

/**
 * Dispatch docker calls by shape: cp / rm → "", the single-transaction
 * reload → "COPY", the to_regclass assertion → `missing`, counts → "2469".
 */
function stubDocker(missing = ""): void {
  mockExec.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === "cp" || args.includes("rm")) return "";
    if (args.includes("--single-transaction")) return "COPY 2469\n";
    if ((args.at(-1) ?? "").includes("to_regclass")) return missing;
    return "2469\n";
  });
}

function reloadScript(): string {
  const call = mockExec.mock.calls.find((c) =>
    (c[1] as string[]).includes("--single-transaction"),
  );
  return (call?.[2] as ExecOpts)?.input ?? "";
}

describe("loadConeval (orchestration)", () => {
  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "/i.csv",
        dbContainer: "--rm",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "/i.csv",
        dbContainer: "",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("rejects pobrezaCsvPath beginning with '-'", async () => {
    await expect(
      loadConeval({
        pobrezaCsvPath: "--rm-volumes",
        irsCsvPath: "/i.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/pobrezaCsvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects irsCsvPath beginning with '-'", async () => {
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "-evil",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/irsCsvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects unsafe column names in CSV header", async () => {
    stubHeaders(
      "clave_entidad,clave_municipio,poblacion,pobreza,bad name with spaces",
      VALID_IRS_HEADER,
    );
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "/i.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/unsafe column name/);
  });

  it("rejects header missing required column", async () => {
    stubHeaders(
      "clave_entidad,entidad_federativa,municipio,poblacion,pobreza",
      VALID_IRS_HEADER,
    );
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "/i.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/missing required column "clave_municipio"/);
  });

  it("passes csvPath positionally with `--` separator to docker cp", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    stubDocker();

    const result = await loadConeval({
      pobrezaCsvPath: "/data/p.csv",
      irsCsvPath: "/data/irs.csv",
      dbContainer: "supabase-db",
    });
    expect(result.pobreza_rows).toBe(2469);
    expect(result.irs_rows).toBe(2469);

    // Verify both `cp --` invocations
    const cpCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args[0] === "cp";
    });
    expect(cpCalls.length).toBe(2);
    for (const c of cpCalls) {
      const args = c[1] as string[];
      expect(args[0]).toBe("cp");
      expect(args[1]).toBe("--"); // flag-injection defense
    }
  });

  it("guards every numeric cast against 'n.d' (audit C1 regression)", () => {
    // CONEVAL flags ~3-5 municipios per indicator as 'n.d' (no disponible).
    // BOTH the % column AND the paired *_pob personas column carry 'n.d'
    // when the indicator is missing. Every numeric cast in the view must
    // strip the marker, otherwise SELECTs on the view will blow up.
    const sql = POST_LOAD_SQL_FOR_TEST;
    // Every cast that produces an int must NULLIF on 'n.d'.
    const intCastsRequiringNd = ["poblacion", "pobreza_pob", "pobreza_e_pob"];
    for (const col of intCastsRequiringNd) {
      // Match: NULLIF(NULLIF(REPLACE(<col>, ',', ''), ''), 'n.d')::int
      const re = new RegExp(
        `NULLIF\\(NULLIF\\(REPLACE\\(${col}, ',', ''\\), ''\\), 'n\\.d'\\)::int`,
      );
      expect(sql).toMatch(re);
    }
    // Every numeric % cast must NULLIF 'n.d'.
    const numericCastsRequiringNd = [
      "pobreza",
      "pobreza_e",
      "pobreza_m",
      "vul_car",
      "vul_ing",
      "npnv",
      "ic_rezedu",
      "ic_asalud",
      "ic_segsoc",
      "ic_cv",
      "ic_sbv",
      "ic_ali",
      "plp",
      "irs_indice",
      "irs_lugar_nacional",
    ];
    for (const col of numericCastsRequiringNd) {
      expect(sql).toMatch(new RegExp(`NULLIF\\(${col}, 'n\\.d'\\)`));
    }
    // irs_grado is text but still gets NULLIF for symmetry
    expect(sql).toMatch(/NULLIF\(irs_grado, 'n\.d'\)/);
  });

  it("cleans up in-container temp file even when \\copy fails", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    mockExec.mockImplementation(
      (_bin: string, _args: string[], opts: ExecOpts) => {
        // Throw on the \copy transaction, succeed on everything else
        if (opts?.input?.includes("\\copy")) {
          throw new Error("psql copy failed");
        }
        return "";
      },
    );
    await expect(
      loadConeval({
        pobrezaCsvPath: "/p.csv",
        irsCsvPath: "/i.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/psql copy failed/);

    // The transaction failed — both staged CSVs are still removed.
    const rmCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args.includes("rm");
    });
    expect(rmCalls.length).toBe(2);
  });
});

describe("loadConeval reload keeps dependents alive (audit #144)", () => {
  const cfg = {
    pobrezaCsvPath: "/data/p.csv",
    irsCsvPath: "/data/irs.csv",
    dbContainer: "supabase-db",
  };

  it("never DROPs with CASCADE (old code: DROP TABLE ... _raw CASCADE)", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    stubDocker();
    await loadConeval(cfg);
    for (const c of mockExec.mock.calls) {
      const sql = `${(c[1] as string[]).join(" ")} ${(c[2] as ExecOpts)?.input ?? ""}`;
      expect(sql).not.toMatch(/DROP (TABLE|VIEW)[^;]*CASCADE/);
    }
  });

  it("loads, swaps and rebuilds in ONE transaction, \\copy before any live DROP", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    stubDocker();
    await loadConeval(cfg);
    const psqlCalls = mockExec.mock.calls.filter((c) =>
      (c[1] as string[]).includes("psql"),
    );
    // 1 reload transaction + 2 counts + 1 to_regclass assertion.
    expect(psqlCalls.length).toBe(4);
    const sql = reloadScript();
    const firstLiveDrop = sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_sector_grade_matrix;");
    expect(sql.lastIndexOf("\\copy coneval_irs_municipal_raw_staging")).toBeLessThan(firstLiveDrop);
    expect(sql.indexOf("DROP VIEW IF EXISTS coneval_irs_municipal;")).toBeLessThan(
      sql.indexOf("DROP TABLE IF EXISTS coneval_irs_municipal_raw;"),
    );
    expect(sql).toContain(
      "ALTER TABLE coneval_irs_municipal_raw_staging RENAME TO coneval_irs_municipal_raw;",
    );
  });

  it("rebuilds mv_sector_grade_matrix + mv_national_treemap and re-grants them", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    stubDocker();
    await loadConeval(cfg);
    const sql = reloadScript();
    // Old code never recreated these MVs after its CASCADE dropped them.
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW mv_sector_grade_matrix AS/);
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW mv_national_treemap AS/);
    expect(sql).toContain("GRANT SELECT ON mv_sector_grade_matrix TO denue_sage;");
    expect(sql).toContain("GRANT SELECT ON coneval_irs_municipal TO denue_sage;");
    expect(sql).toContain(
      "REVOKE ALL ON coneval_pobreza_municipal_raw FROM anon, authenticated, trustr_app;",
    );
    // Views must exist before the MVs that read them.
    expect(sql.indexOf("CREATE VIEW coneval_irs_municipal AS")).toBeLessThan(
      sql.indexOf("CREATE MATERIALIZED VIEW mv_sector_grade_matrix AS"),
    );
  });

  it("fails loud when an analytics MV/view is missing after the load", async () => {
    stubHeaders(VALID_POBREZA_HEADER, VALID_IRS_HEADER);
    stubDocker("censo_localidades\n");
    await expect(loadConeval(cfg)).rejects.toThrow(
      /missing after load: censo_localidades/,
    );
  });
});
