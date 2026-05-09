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
      .mockReturnValueOnce("716\n") // count panel
      .mockReturnValueOnce("32\n"); // count latest

    const result = await loadBienestarPadron({
      csvPath: "/data/padron.csv",
      dbContainer: "supabase-db",
    });
    expect(result.panel_rows).toBe(716);
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
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /intervenciones::numeric\s+AS intervenciones/,
    );
  });

  it("casts beneficiarios + dependencias + padrones + programas as ::int", () => {
    // These columns are clean integers in the CSV; ::int is safe.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/beneficiarios::int/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/dependencias::int/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/padrones::int/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/programas::int/);
  });

  it("casts fecha to date type", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/fecha::date\s+AS fecha/);
  });

  it("uses ROW_NUMBER() with deterministic tiebreaker for latest-quarter slice", () => {
    // PARTITION BY cve_ent + ORDER BY fecha DESC + periodo_cve DESC tiebreaker
    // guarantees one row per entidad even if two share fecha.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/PARTITION BY cve_ent/);
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /ORDER BY fecha DESC NULLS LAST, periodo_cve DESC/,
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
});
