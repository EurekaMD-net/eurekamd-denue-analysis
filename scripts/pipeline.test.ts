import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx");
const SCRIPT = join(HERE, "pipeline.ts");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// Runs the CLI from an empty temp dir (no .env) with no credentials, so the
// old code could never reach the network: it stopped at the missing
// DENUE_TOKEN instead of rejecting the clave.
function run(args: string[]) {
  dir = mkdtempSync(join(tmpdir(), "pipeline-cli-"));
  const env = { ...process.env };
  delete env["DENUE_TOKEN"];
  delete env["SUPABASE_SERVICE_KEY"];
  env["STATE_DIR"] = join(dir, "state");
  env["OUTPUT_DIR"] = join(dir, "out");
  return spawnSync(TSX, [SCRIPT, ...args], { cwd: dir, env, encoding: "utf-8" });
}

describe("pipeline.ts --estados", () => {
  it("rejects an unknown clave instead of silently widening the run to all 32 estados", () => {
    const r = run(["--estados=99"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inválida\(s\): 99\b/);
    expect(r.stderr).not.toMatch(/DENUE_TOKEN/);
  }, 30_000);

  it("rejects a list when any one clave is unknown", () => {
    const r = run(["--estados=09,4x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inválida\(s\): 4x\b/);
  }, 30_000);
});
