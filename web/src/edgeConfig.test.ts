/**
 * Audit 2026-09-26 #4/#5/#12/#190/#194/#196: edge hardening that lives in
 * config, not code. Pins the vite build (no public sourcemaps) and the
 * Caddy snapshot (security headers, CSP, .map 404, minisu sandbox).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config";

const here = dirname(fileURLToPath(import.meta.url));
const caddy = readFileSync(
  resolve(here, "../../ops/Caddyfile.uncharted"),
  "utf8",
);

/** Body of the first `<opener> {` block, brace-balanced. */
function block(opener: string): string {
  const start = caddy.indexOf(`${opener} {`);
  if (start < 0) throw new Error(`no block: ${opener}`);
  let depth = 0;
  for (let i = caddy.indexOf("{", start); i < caddy.length; i++) {
    if (caddy[i] === "{") depth++;
    if (caddy[i] === "}" && --depth === 0) {
      return caddy.slice(caddy.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${opener}`);
}

describe("vite build config", () => {
  it("does not emit sourcemaps into the publicly served dist/", () => {
    expect(viteConfig.build?.sourcemap).toBe(false);
  });
});

describe("ops/Caddyfile.uncharted", () => {
  const site = block("uncharted.eurekamd.cloud");

  it("sets the security headers on the site", () => {
    const headers = block("\theader");
    for (const h of [
      'X-Frame-Options "DENY"',
      'X-Content-Type-Options "nosniff"',
      "Strict-Transport-Security",
      "Referrer-Policy",
      "Permissions-Policy",
      "-Server",
    ]) {
      expect(headers).toContain(h);
    }
  });

  it("ships a CSP that allows the map, workers and Supabase auth", () => {
    const m = /Content-Security-Policy(?:-Report-Only)? "([^"]+)"/.exec(
      block("\theader"),
    );
    expect(m).not.toBeNull();
    const csp = m![1]!;
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "worker-src 'self' blob:",
      "https://db.mycommit.net",
      "https://*.basemaps.cartocdn.com",
      "object-src 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(d);
    }
  });

  it("404s sourcemaps inside the /assets/* handle, before file_server", () => {
    // A site-level `handle @maps` or `respond` loses to `handle /assets/*`
    // (verified against caddy 2.11), so the guard must live in this block.
    const assets = block("handle /assets/*");
    const respond = assets.indexOf("respond @maps 404");
    expect(assets).toContain("@maps path *.map");
    expect(respond).toBeGreaterThan(-1);
    expect(respond).toBeLessThan(assets.search(/^\s*file_server\s*$/m));
  });

  it("sandboxes the agent-writable /minisu-catalog route", () => {
    expect(site).toContain("handle_path /minisu-catalog/*");
    const minisu = block("handle_path /minisu-catalog/*");
    expect(minisu).toContain('header Content-Security-Policy "sandbox"');
    expect(minisu).toContain('header X-Content-Type-Options "nosniff"');
  });
});
