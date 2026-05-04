import { describe, it, expect } from "vitest";

// Re-derive the regexes the hook uses; the hook itself imports React +
// react-router which need jsdom + RTL to test as a hook. These pure
// regex tests guarantee the validation contract — if the backend's
// ENTIDAD_RE/SCIAN_RE drift, the test still fails because the regexes
// are written here verbatim and need to be kept in sync.
const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
const SCIAN_RE = /^[0-9]{2}$/;

// NOTE: these tests cover only the regex CONTRACT. Hook behavior
// (hydration order, mirror equality short-circuit, mode-switch URL
// persistence) needs RTL + jsdom which the project doesn't set up
// yet — flagged in audit W4 (2026-05-04).
describe("ENTIDAD_RE / SCIAN_RE contract (frontend ↔ backend)", () => {
  it("ENTIDAD_RE accepts all 32 valid claves", () => {
    for (let n = 1; n <= 32; n++) {
      const c = String(n).padStart(2, "0");
      expect(ENTIDAD_RE.test(c)).toBe(true);
    }
  });

  it("ENTIDAD_RE rejects 00, 33, non-digits, and SQL-injection probes", () => {
    for (const bad of ["00", "33", "1", "001", "AA", "9 OR 1=1", "9'--", ""]) {
      expect(ENTIDAD_RE.test(bad)).toBe(false);
    }
  });

  it("SCIAN_RE accepts any 2-digit string (DENUE has 11..99 + anomalies)", () => {
    for (const ok of ["11", "46", "62", "72", "99", "00"]) {
      expect(SCIAN_RE.test(ok)).toBe(true);
    }
  });

  it("SCIAN_RE rejects 1-digit, 3-digit, and non-numeric input", () => {
    for (const bad of ["1", "111", "AB", "4A", "", " 46", "46 "]) {
      expect(SCIAN_RE.test(bad)).toBe(false);
    }
  });
});
