import { describe, it, expect } from "vitest";
import { SCIAN_BUNDLES, findBundle } from "./scian-bundles";

describe("SCIAN_BUNDLES", () => {
  it("ships at least 10 bundles", () => {
    expect(SCIAN_BUNDLES.length).toBeGreaterThanOrEqual(10);
  });

  it("every bundle id is unique", () => {
    const ids = SCIAN_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every SCIAN code is 2–6 digits", () => {
    const re = /^[0-9]{2,6}$/;
    for (const b of SCIAN_BUNDLES) {
      for (const code of b.codes) {
        expect(code, `bundle ${b.id}, code ${code}`).toMatch(re);
      }
    }
  });

  it("findBundle works", () => {
    expect(findBundle("salud_minorista")?.codes).toContain("4641");
    expect(findBundle("not-real")).toBeUndefined();
  });
});
