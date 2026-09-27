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
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx");
const SCRIPT = join(HERE, "analyze.ts");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// A fake `docker` first on PATH records its argv (one arg per line, calls
// separated by ---) and succeeds, so no real container is ever touched.
function runRefresh(container: (dir: string) => string) {
  dir = mkdtempSync(join(tmpdir(), "analyze-cli-"));
  const log = join(dir, "docker.log");
  const fake = join(dir, "docker");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\necho --- >> "${log}"\n`,
  );
  chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}`,
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_KEY: "dummy",
    SUPABASE_DB_CONTAINER: container(dir),
  };
  const r = spawnSync(TSX, [SCRIPT, "refresh-views"], {
    cwd: dir,
    env,
    encoding: "utf-8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf-8")
        .split("---\n")
        .filter((c) => c.length > 0)
        .map((c) => c.replace(/\n$/, "").split("\n"))
    : [];
  return { r, calls, dir };
}

describe("analyze.ts refresh-views", () => {
  it("never hands SUPABASE_DB_CONTAINER to a shell", () => {
    const { r, calls, dir: d } = runRefresh(
      (d) => `supabase-db;touch ${join(d, "pwned")};#`,
    );
    // The old execSync form ran `touch` through /bin/sh.
    expect(existsSync(join(d, "pwned"))).toBe(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SUPABASE_DB_CONTAINER inválido/);
    expect(calls).toEqual([]);
  }, 30_000);

  it("passes the container and REFRESH statement as discrete argv entries", () => {
    const { r, calls } = runRefresh(() => "supabase-db");
    expect(r.status).toBe(0);
    expect(calls.map((c) => c.at(-1))).toEqual([
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sector_summary;",
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coverage;",
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_estrato_por_entidad;",
    ]);
    expect(calls[0]).toEqual([
      "exec",
      "supabase-db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sector_summary;",
    ]);
  }, 30_000);
});
