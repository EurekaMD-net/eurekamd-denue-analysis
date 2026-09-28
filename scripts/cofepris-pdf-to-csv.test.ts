import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the stdlib-unittest suite for cofepris-pdf-to-csv.py (pdfplumber is
// stubbed there) so it is part of the vitest gate.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("cofepris-pdf-to-csv.py (python unittest)", () => {
  it("passes scripts/cofepris-pdf-to-csv.test.py", (ctx) => {
    const r = spawnSync("python3", ["scripts/cofepris-pdf-to-csv.test.py"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (r.status === null && (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      ctx.skip("python3 not found on PATH; cannot run the parser unittests");
      return;
    }
    if (r.status !== 0) console.error(r.stderr);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/\nOK\s*$/);
  }, 30_000);
});
