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
  loadBienestarPadron,
  POST_LOAD_SQL_FOR_TEST,
} from "./load-bienestar-padron.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const VALID_HEADER =
  "CVEENT,entidad,beneficiarios,intervenciones,dependencias,padrones,programas,periodo,periodo_cve,trimestre,anio,fecha,entidad_etiqueta,entidad_etq";

function stubHeader(headerLine: string): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation(
    (
      _fd: number,
      buf: Buffer,
      _offset: number,
      _length: number,
      _pos: number,
    ) => {
      const text = headerLine + "\n";
      buf.write(text, 0, "utf-8");
      return Buffer.byteLength(text, "utf-8");
    },
  );
  mockClose.mockReturnValue(undefined);
}

describe("loadBienestarPadron (orchestration)", () => {
  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(
      loadBienestarPadron({
        csvPath: "/p.csv",
        dbContainer: "--rm",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadBienestarPadron({
        csvPath: "/p.csv",
        dbContainer: "",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("rejects csvPath beginning with '-'", async () => {
    await expect(
      loadBienestarPadron({
        csvPath: "--rm-volumes",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/csvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects unsafe column names in CSV header", async () => {
    stubHeader("cveent,entidad,beneficiarios,bad name with spaces");
    await expect(
      loadBienestarPadron({
        csvPath: "/p.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/unsafe column name/);
  });

  it("rejects header missing required column", async () => {
    // Drop only `anio` from the otherwise-valid header.
    stubHeader(
      "CVEENT,entidad,beneficiarios,intervenciones,dependencias,padrones,programas,periodo,periodo_cve,trimestre,fecha,entidad_etiqueta,entidad_etq",
    );
    await expect(
      loadBienestarPadron({
        csvPath: "/p.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/missing required column "anio"/);
  });

  it("passes csvPath positionally with `--` separator to docker cp", async () => {
    stubHeader(VALID_HEADER);
    mockExec
      .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // raw DDL
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("COPY 748\n") // \copy
      .mockReturnValueOnce("") // rm
      .mockReturnValueOnce("CREATE VIEW\n") // post-load
      .mockReturnValueOnce("736\n") // count panel
      .mockReturnValueOnce("32\n") // count latest
      .mockReturnValueOnce("0\n"); // duplicate guard (zero corruption)

    const result = await loadBienestarPadron({
      csvPath: "/data/padron.csv",
      dbContainer: "supabase-db",
    });
    expect(result.panel_rows).toBe(736);
    expect(result.latest_rows).toBe(32);

    const cpCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args[0] === "cp";
    });
    expect(cpCalls.length).toBe(1);
    const cpArgs = cpCalls[0]?.[1] as string[];
    expect(cpArgs[0]).toBe("cp");
    expect(cpArgs[1]).toBe("--"); // flag-injection defense
  });

  it("hard-fails the load when (cve_ent, fecha) duplicates exist", async () => {
    // Producer invariant: one row per (entidad, quarter). The latest-quarter
    // view has no terminal tiebreaker (no field can deduplicate a corrupted
    // source), so the post-load duplicate guard is the only line of defense.
    stubHeader(VALID_HEADER);
    mockExec
      .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // raw DDL
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("COPY 750\n") // \copy (extra rows)
      .mockReturnValueOnce("") // rm
      .mockReturnValueOnce("CREATE VIEW\n") // post-load
      .mockReturnValueOnce("738\n") // count panel
      .mockReturnValueOnce("32\n") // count latest
      .mockReturnValueOnce("2\n"); // duplicate guard fires

    await expect(
      loadBienestarPadron({
        csvPath: "/data/padron.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(
      /producer invariant violated.*2 \(cve_ent, fecha\) groups/,
    );
  });

  it("cleans up in-container temp file even when \\copy fails", async () => {
    stubHeader(VALID_HEADER);
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.some((a) => a.includes("\\copy"))) {
        throw new Error("psql copy failed");
      }
      return "";
    });
    await expect(
      loadBienestarPadron({
        csvPath: "/p.csv",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/psql copy failed/);

    const rmCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args.includes("rm");
    });
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("POST_LOAD_SQL invariants", () => {
  it("filters CVEENT=99 (national-rolled row) from panel view", () => {
    // Defense-in-depth pattern from v0.2.10 (entidad <> '00' in censo_entidades).
    // National-rolled bienestar row stays in raw table for future surface-up
    // but never leaks into entidad-grain consumers.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/cveent::int <> 99/);
  });

  it("filters non-numeric cveent values defensively", () => {
    // Drops any blank-row drift / future header pollution from the panel.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/cveent ~ '\^\[0-9\]\+\$'/);
  });

  it("normalizes cve_ent via LPAD to 2-char zero-padded", () => {
    // Source CSV ships CVEENT as integer (1..32). Censo entidades convention
    // is '01'..'32'. View must normalize so JOINs work.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /LPAD\(cveent, 2, '0'\)\s+AS cve_ent/,
    );
  });

  it("casts intervenciones via ::numeric (decimal-formatted-int CSV quirk)", () => {
    // CSV ships intervenciones as 1851607.0 — direct ::int throws.
    // After W3 audit (ronda 2 sentinel-canon fix), wrapped in NULLIF guards
    // matching project canon: '', 'N/D', 'n.d'.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/intervenciones,/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /'n\.d'\)::numeric\s+AS intervenciones/,
    );
  });

  it("casts beneficiarios + dependencias + padrones + programas as ::int", () => {
    // These columns are clean integers in the CSV; ::int is safe.
    // After W3 audit, all wrapped in NULLIF guards matching project canon
    // ('', 'N/D', 'n.d'); here we just pin the final cast + alias.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/'n\.d'\)::int\s+AS beneficiarios/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/'n\.d'\)::int\s+AS dependencias/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/'n\.d'\)::int\s+AS padrones/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/'n\.d'\)::int\s+AS programas/);
  });

  it("casts fecha to date type", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /NULLIF\(fecha, ''\)::date\s+AS fecha/,
    );
  });

  it("uses ROW_NUMBER() with single-column ORDER BY (W1 ronda 2 fix)", () => {
    // No terminal tiebreaker — periodo_cve and cveent_raw are co-derived
    // with fecha and the partition key, so neither can break a tie.
    // Producer guarantees one-row-per-(entidad, quarter); the post-load
    // duplicate guard hard-fails the load if that invariant is violated.
    // (cveent_raw is still SELECTed in the panel view as a passthrough alias
    // for cveent — but it must NOT appear in the latest-slice ORDER BY.)
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/PARTITION BY cve_ent/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /ORDER BY fecha DESC NULLS LAST\s*\) AS rn/,
    );
    // Drift guard: no theatrical tiebreakers in the ORDER BY itself.
    expect(POST_LOAD_SQL_FOR_TEST).not.toMatch(
      /ORDER BY fecha DESC NULLS LAST,\s*(periodo_cve|cveent_raw|cveent)/,
    );
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/WHERE rn = 1/);
  });

  it("uses DROP+CREATE pattern (consumers don't exist yet)", () => {
    // Brand-new views — DROP IF EXISTS + CREATE is safe and clearer than
    // CREATE OR REPLACE for first-deploy.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /DROP VIEW IF EXISTS bienestar_estatal_trimestral CASCADE/,
    );
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /DROP VIEW IF EXISTS bienestar_estatal_latest CASCADE/,
    );
  });

  it("guards every numeric cast with project-canon sentinels '' / 'N/D' / 'n.d' (W3 ronda 2)", () => {
    // Source CSV is currently semantically clean (zero suppression sentinels)
    // but a future quarterly refresh could ship the project-canonical
    // sentinels per feedback_inegi_view_patterns.md: '' (universal), 'N/D'
    // (INEGI uppercase), 'n.d' (CONEVAL lowercase). The CONEVAL '*' sentinel
    // is omitted because Bienestar isn't a CONEVAL pipeline. Belt-and-
    // suspenders even when the producer is currently clean.
    const numericCols = [
      "beneficiarios",
      "intervenciones",
      "dependencias",
      "padrones",
      "programas",
    ];
    for (const col of numericCols) {
      const re = new RegExp(
        `NULLIF\\(NULLIF\\(NULLIF\\(${col}, ''\\), 'N/D'\\), 'n\\.d'\\)::(int|numeric)`,
      );
      expect(POST_LOAD_SQL_FOR_TEST).toMatch(re);
    }
    // anio + fecha get the simpler ''-only NULLIF (sentinel-free in source,
    // but a header row leak would drop into raw with empty strings).
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/NULLIF\(anio, ''\)::int/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/NULLIF\(fecha, ''\)::date/);
    // Drift guard: ronda 1 used 'NaN' (not a real Bienestar/INEGI sentinel,
    // JS-only artifact). Ronda 2 swapped to 'n.d' for canon. Pin the absence.
    expect(POST_LOAD_SQL_FOR_TEST).not.toMatch(/'NaN'\)::(int|numeric|date)/);
  });
});

describe("RAW_DDL column-order pin (R2 audit)", () => {
  it("raw table column order matches CSV header positionally (\\copy is positional)", async () => {
    // \\copy ... WITH (FORMAT csv, HEADER true) consumes the header row but
    // does NOT realign columns by name — values are loaded by file position
    // into the table's declared column order. If the producer reorders the
    // CSV columns (e.g. swaps `intervenciones` and `dependencias`),
    // expectSafeIdentList still passes (all required cols present) but the
    // VALUES land in the wrong fields and silently corrupt every metric
    // downstream. Pin the canonical order here so a CSV-shape change has to
    // bump the test in lockstep.
    const expectedOrder = [
      "cveent",
      "entidad",
      "beneficiarios",
      "intervenciones",
      "dependencias",
      "padrones",
      "programas",
      "periodo",
      "periodo_cve",
      "trimestre",
      "anio",
      "fecha",
      "entidad_etiqueta",
      "entidad_etq",
    ];
    // Re-import RAW_DDL via the orchestration entry — it lives only inside
    // the loader module. Stub the side effects so the SQL string is
    // captured without actually running.
    stubHeader(VALID_HEADER);
    const sqlCalls: string[] = [];
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      const lastArg = args[args.length - 1] ?? "";
      if (lastArg.includes("CREATE TABLE")) sqlCalls.push(lastArg);
      // Return mock count values for the verification phase
      return /\d+\n/.test("0") ? "0\n" : "";
    });
    try {
      await loadBienestarPadron({
        csvPath: "/data/p.csv",
        dbContainer: "supabase-db",
      });
    } catch {
      // We don't care about completion — just need the CREATE TABLE call
    }
    expect(sqlCalls.length).toBeGreaterThanOrEqual(1);
    const ddl = sqlCalls[0] ?? "";
    // Extract column names from inside CREATE TABLE (...) body only.
    // Anchoring to the parenthesized body prevents false-positive matches
    // from any line outside the column-list (e.g. CHECK constraints, future
    // CREATE INDEX statements, or comment lines that happen to contain
    // "<ident> TEXT" patterns).
    const body = ddl.match(/CREATE TABLE\s+\w+\s*\(([\s\S]+?)\);/)?.[1] ?? "";
    const colMatches = [...body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+TEXT/gm)];
    const declaredOrder = colMatches.map((m) => m[1]);
    // Pin count explicitly so a DDL re-format that breaks the per-line regex
    // (e.g. compact `cveent TEXT, entidad TEXT,` form) fails loudly with
    // "got 0, expected 14" instead of silently passing on empty arrays.
    expect(declaredOrder.length).toBe(expectedOrder.length);
    expect(declaredOrder).toEqual(expectedOrder);
  });
});
