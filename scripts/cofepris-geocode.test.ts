import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "cofepris-geocode.py");

// Fake `docker exec ... psql`. Mirrors real psql on the one point that
// matters (checked read-only against the live container 2026-09-27): a
// `-c` string is sent to the server as-is, so `:'list'` inside it is a
// syntax error. From stdin psql interpolates -v variables.
const FAKE_DOCKER = `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if "-c" in args:
    sql = args[args.index("-c") + 1]
    if "establecimientos" in sql:
        print("entidad,cp,area_geo,ageb,colonia")
        print("09,06700,09015,0901500010010,Roma Norte")
        print("09,06700,09015,0901500010025,Roma Norte")
        sys.exit(0)
    if ":'" in sql:
        print('ERROR:  syntax error at or near ":"', file=sys.stderr)
        sys.exit(1)
    sys.exit(1)
sql = sys.stdin.read()
lst = next(a[len("list="):] for a in args if a.startswith("list="))
assert ":'list'" in sql
n = len(lst.split("\\n"))
print(f"{n},{n if os.environ['FAKE_MATCH'] == 'all' else 0}")
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), "cofepris-geocode-"));
  const fake = join(dir, "docker");
  writeFileSync(fake, FAKE_DOCKER);
  chmodSync(fake, 0o755);
  const input = join(dir, "farmacias.csv");
  writeFileSync(
    input,
    "consec,cp,cve_ent,colonia_norm\n1,06700,09,ROMA NORTE\n2,99999,09,X\n",
  );
  return { dir, input, output: join(dir, "farmacias_geocoded.csv") };
}

function run(d: string, input: string, output: string, match: "all" | "none") {
  return spawnSync("python3", [SCRIPT, input, output], {
    cwd: d,
    env: {
      ...process.env,
      PATH: `${d}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE_MATCH: match,
    },
    encoding: "utf-8",
  });
}

describe("cofepris-geocode.py", () => {
  it("passes the integrity join when the cvegeos exist (it could never pass via psql -c)", () => {
    const { dir: d, input, output } = setup();
    const r = run(d, input, output, "all");
    expect(r.stderr).not.toMatch(/FAIL/);
    expect(r.status).toBe(0);
    const lines = readFileSync(output, "utf-8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("0901500010010");
    expect(lines[1]).toContain("cp_colonia");
    expect(existsSync(`${output}.tmp`)).toBe(false);
  }, 30_000);

  it("leaves no output behind when the integrity check refuses the dataset", () => {
    const { dir: d, input, output } = setup();
    const r = run(d, input, output, "none");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/match rate 0\.0% < 85%/);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.tmp`)).toBe(false);
  }, 30_000);

  it("keeps the previous good output when a re-run is refused", () => {
    const { dir: d, input, output } = setup();
    writeFileSync(output, "previous\n");
    const r = run(d, input, output, "none");
    expect(r.status).toBe(2);
    expect(readFileSync(output, "utf-8")).toBe("previous\n");
  }, 30_000);
});
