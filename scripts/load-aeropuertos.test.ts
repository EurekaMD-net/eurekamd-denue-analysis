import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

// Audit #165: importing the loader must not run it (isMain guard, no
// top-level `await main()`). A regression would call execFileSync here.
import {
  buildAeropuertosReloadScript,
  CREATE_SCHEMA_SQL,
  loadAeropuertos,
  LOOKUP_DDL,
  POST_LOAD_SQL,
  RAW_COPY_CMD,
  type LookupEntry,
} from "./load-aeropuertos.js";

const importCalls = mockExec.mock.calls.length;

const ENTRIES: LookupEntry[] = [
  { airport_name: "Cancún", cve_mun: "23005", cve_ent: "23" },
  { airport_name: "O'Hare-ish", cve_mun: "09015", cve_ent: "09" },
];
const CSV =
  "airport_name,operator,ano,mar_flights\nCancún,ASUR,2026,100\nCancún,ASUR,2019,80\n";

let dir = "";
let csvPath = "";
let lookupPath = "";

beforeEach(() => {
  mockExec.mockReset();
  dir = mkdtempSync(join(tmpdir(), "aero-test-"));
  csvPath = join(dir, "aero.csv");
  lookupPath = join(dir, "lookup.json");
  writeFileSync(csvPath, CSV);
  writeFileSync(lookupPath, JSON.stringify({ entries: ENTRIES }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function args(force: boolean) {
  return { csv: csvPath, lookup: lookupPath, force, container: "supabase-db" };
}

/** schema → COUNT → ONE reload transaction → stats. */
function stubRun(existingRows: number): void {
  mockExec
    .mockReturnValueOnce("CREATE TABLE\n") // CREATE_SCHEMA_SQL
    .mockReturnValueOnce(`${existingRows}\n`) // COUNT(*) guard
    .mockReturnValueOnce("COPY 2\n") // reload transaction
    .mockReturnValueOnce("2|1|1\n"); // stats
}

function reloadCall(): { argv: string[]; script: string } {
  const call = mockExec.mock.calls[2];
  return {
    argv: call?.[1] as string[],
    script: String((call?.[2] as { input: Buffer }).input),
  };
}

describe("load-aeropuertos module (audit #165)", () => {
  it("does not run the loader at import time", () => {
    expect(importCalls).toBe(0);
  });

  it("POST_LOAD_SQL carries no BEGIN/COMMIT (it runs inside the reload transaction)", () => {
    expect(POST_LOAD_SQL).not.toMatch(/\b(BEGIN|COMMIT);/);
    expect(POST_LOAD_SQL).toContain(
      "CREATE OR REPLACE VIEW aeropuertos_movements_yearly AS",
    );
    expect(POST_LOAD_SQL).toContain(
      "CREATE OR REPLACE VIEW aeropuertos_by_municipio AS",
    );
  });

  it("CREATE_SCHEMA_SQL is idempotent (IF NOT EXISTS)", () => {
    expect(CREATE_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS aeropuertos_movements_raw",
    );
  });
});

describe("buildAeropuertosReloadScript (audits #146, #150)", () => {
  const script = buildAeropuertosReloadScript(ENTRIES, Buffer.from(CSV)).toString(
    "utf-8",
  );

  it("drops the views first, never drops the lookup, and rebuilds it with TRUNCATE + INSERT", () => {
    const dropMuni = script.indexOf("DROP VIEW IF EXISTS aeropuertos_by_municipio;");
    const dropYearly = script.indexOf(
      "DROP VIEW IF EXISTS aeropuertos_movements_yearly;",
    );
    const lookupDdl = script.indexOf(LOOKUP_DDL);
    const truncLookup = script.indexOf("TRUNCATE TABLE aeropuertos_cvemun_lookup;");
    const insert = script.indexOf("INSERT INTO aeropuertos_cvemun_lookup");
    expect(dropMuni).toBe(0);
    expect(dropMuni).toBeLessThan(dropYearly);
    expect(dropYearly).toBeLessThan(lookupDdl);
    expect(lookupDdl).toBeLessThan(truncLookup);
    expect(truncLookup).toBeLessThan(insert);
    expect(script).not.toMatch(/DROP TABLE/);
    expect(LOOKUP_DDL).toContain(
      "CREATE TABLE IF NOT EXISTS aeropuertos_cvemun_lookup",
    );
    // Values are SQL-quoted.
    expect(script).toContain("VALUES ('O''Hare-ish', '09015', '09');");
  });

  it("TRUNCATE + \\copy with the CSV inline, then the views, then grants", () => {
    const truncRaw = script.indexOf("TRUNCATE TABLE aeropuertos_movements_raw;");
    const copy = script.indexOf(RAW_COPY_CMD);
    const data = script.indexOf("Cancún,ASUR,2026,100\n");
    const end = script.indexOf("\n\\.\n");
    const yearly = script.indexOf("CREATE OR REPLACE VIEW aeropuertos_movements_yearly");
    const muni = script.indexOf("CREATE OR REPLACE VIEW aeropuertos_by_municipio");
    const grants = script.indexOf(
      "REVOKE ALL ON aeropuertos_by_municipio FROM anon, authenticated, trustr_app;",
    );
    expect(truncRaw).toBeGreaterThan(script.indexOf("INSERT INTO aeropuertos_cvemun_lookup"));
    expect(truncRaw).toBeLessThan(copy);
    expect(copy).toBeLessThan(data);
    expect(data).toBeLessThan(end);
    expect(end).toBeLessThan(yearly);
    expect(yearly).toBeLessThan(muni);
    expect(muni).toBeLessThan(grants);
    expect(script).not.toMatch(/\b(BEGIN|COMMIT);/);
  });
});

describe("loadAeropuertos orchestration", () => {
  it("first run: schema → COUNT 0 → ONE single-transaction reload → stats", async () => {
    stubRun(0);
    await expect(loadAeropuertos(args(false))).resolves.toBe("2|1|1");
    expect(mockExec).toHaveBeenCalledTimes(4);
    expect(mockExec.mock.calls[0]?.[2]).toMatchObject({ input: CREATE_SCHEMA_SQL });
    expect((mockExec.mock.calls[1]?.[1] as string[]).join(" ")).toContain(
      "SELECT COUNT(*) FROM aeropuertos_movements_raw;",
    );
    const { argv, script } = reloadCall();
    expect(argv).toContain("--single-transaction");
    expect(argv).toContain("ON_ERROR_STOP=1");
    expect(script).toBe(
      buildAeropuertosReloadScript(ENTRIES, Buffer.from(CSV)).toString("utf-8"),
    );
    expect((mockExec.mock.calls[3]?.[1] as string[]).join(" ")).toContain(
      "FROM aeropuertos_by_municipio",
    );
  });

  it("--force on a populated table runs the SAME reload (views dropped, lookup never dropped)", async () => {
    stubRun(0);
    await loadAeropuertos(args(false));
    const firstRun = reloadCall().script;

    mockExec.mockReset();
    stubRun(1234);
    await loadAeropuertos(args(true));
    const forced = reloadCall();
    expect(forced.argv).toContain("--single-transaction");
    expect(forced.script).toBe(firstRun);
    // Audit #150: the old per-step path issued `DROP TABLE IF EXISTS
    // aeropuertos_cvemun_lookup` while both views still depended on it.
    const everyInput = mockExec.mock.calls
      .map((c) => String((c[2] as { input?: unknown } | undefined)?.input ?? ""))
      .join("\n");
    expect(everyInput).not.toMatch(/DROP TABLE/);
  });

  it("refuses a populated table without --force (exit code 2) and never reloads", async () => {
    stubRun(1234);
    const err = await loadAeropuertos(args(false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/has 1234 rows\. Use --force/);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("a failed reload transaction propagates and skips the stats query", async () => {
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n")
      .mockReturnValueOnce("0\n")
      .mockImplementationOnce(() => {
        throw new Error('ERROR: invalid input syntax for type integer: "x"');
      });
    await expect(loadAeropuertos(args(true))).rejects.toThrow(/invalid input syntax/);
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("fails before any docker call when the CSV is missing", async () => {
    const err = await loadAeropuertos({ ...args(false), csv: join(dir, "nope.csv") }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/CSV not found/);
    expect((err as { exitCode?: number }).exitCode).toBe(1);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects an unsafe container name before running psql", async () => {
    await expect(
      loadAeropuertos({ ...args(false), container: "supabase db" }),
    ).rejects.toThrow(/unsafe container name/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
