import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx");
const SCRIPT = join(HERE, "extract.ts");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function run(args: string[], token: string | undefined) {
  const env = { ...process.env };
  delete env["DENUE_TOKEN"];
  if (token !== undefined) env["DENUE_TOKEN"] = token;
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd: tmpdir(),
    env,
    encoding: "utf-8",
  });
}

describe("extract.ts", () => {
  it("does not print a token-shaped value in the missing-token usage hint", () => {
    const r = run(["--estado=09"], undefined);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DENUE_TOKEN no está definida/);
    expect(r.stderr).not.toMatch(UUID_RE);
  }, 30_000);

  it("exits non-zero on an unknown estado instead of reporting success", () => {
    // Fails before any request: the dummy token never reaches INEGI.
    const r = run(["--estado=99"], "dummy-token");
    expect(r.stderr).toMatch(/Clave de estado inválida: 99/);
    expect(r.status).toBe(1);
  }, 30_000);
});
