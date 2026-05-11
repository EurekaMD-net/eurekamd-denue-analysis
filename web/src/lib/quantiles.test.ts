import { describe, expect, it } from "vitest";
import {
  binIndex,
  cleanSamples,
  formatCompact,
  quantile,
  quantileBreaks,
} from "./quantiles";

describe("cleanSamples", () => {
  it("drops nulls and non-finite, then sorts ascending", () => {
    expect(cleanSamples([3, null, 1, NaN, 2, Infinity, 4])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("returns empty array when all entries are invalid", () => {
    expect(cleanSamples([null, NaN, Infinity, -Infinity])).toEqual([]);
  });
});

describe("quantile (type-7)", () => {
  it("returns NaN for empty sample", () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it("clamps p to [0,1]", () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantile(s, -1)).toBe(1);
    expect(quantile(s, 2)).toBe(5);
  });

  it("matches D3 / NumPy type-7 reference values", () => {
    // For [1,2,3,4,5]: q0.25 = 2.0, q0.5 = 3.0, q0.75 = 4.0 (R / NumPy default)
    const s = [1, 2, 3, 4, 5];
    expect(quantile(s, 0.25)).toBe(2);
    expect(quantile(s, 0.5)).toBe(3);
    expect(quantile(s, 0.75)).toBe(4);
  });

  it("interpolates between adjacent values", () => {
    // For [10, 20]: q0.5 = 15
    expect(quantile([10, 20], 0.5)).toBe(15);
  });
});

describe("quantileBreaks (RH-2 legend rebinning)", () => {
  it("returns empty array when bins < 2 (no thresholds needed)", () => {
    expect(quantileBreaks([1, 2, 3], 1)).toEqual([]);
    expect(quantileBreaks([1, 2, 3], 0)).toEqual([]);
  });

  it("returns exactly bins-1 thresholds for non-empty samples", () => {
    expect(quantileBreaks([1, 2, 3, 4, 5, 6], 3)).toHaveLength(2);
    expect(quantileBreaks([1, 2, 3, 4, 5, 6], 4)).toHaveLength(3);
  });

  it("returns NaN-filled thresholds for empty samples without throwing", () => {
    const out = quantileBreaks([null, NaN], 3);
    expect(out).toHaveLength(2);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("collapses to a single value for all-equal samples (no error)", () => {
    const out = quantileBreaks([5, 5, 5, 5, 5], 3);
    expect(out).toEqual([5, 5]);
  });

  it("produces sensible tertile cuts on a real-world-shaped sample", () => {
    // Simulated layer-values for 32 polygons across a wide range
    const samples = Array.from({ length: 32 }, (_, i) => i * 10);
    const [t1, t2] = quantileBreaks(samples, 3);
    expect(t1!).toBeLessThan(t2!);
    // tertile cuts should land near 1/3 and 2/3 of the range
    expect(t1!).toBeGreaterThan(80);
    expect(t1!).toBeLessThan(120);
    expect(t2!).toBeGreaterThan(180);
    expect(t2!).toBeLessThan(230);
  });
});

describe("binIndex", () => {
  it("returns null for null / NaN input", () => {
    expect(binIndex(null, [10, 20])).toBeNull();
    expect(binIndex(NaN, [10, 20])).toBeNull();
  });

  it("maps below-first-threshold to bin 0", () => {
    expect(binIndex(5, [10, 20])).toBe(0);
  });

  it("maps between-thresholds to middle bins", () => {
    expect(binIndex(15, [10, 20])).toBe(1);
  });

  it("maps above-last-threshold to the highest bin", () => {
    expect(binIndex(30, [10, 20])).toBe(2);
    expect(binIndex(20, [10, 20])).toBe(2); // boundary belongs to upper bin (`<` is strict)
  });
});

describe("formatCompact", () => {
  it("formats billions / millions / thousands", () => {
    expect(formatCompact(1.5e9)).toBe("1.5B");
    expect(formatCompact(2.4e6)).toBe("2.4M");
    expect(formatCompact(12345)).toBe("12.3k");
  });

  it("formats small numbers with appropriate decimals", () => {
    expect(formatCompact(99.7)).toBe("99.7");
    expect(formatCompact(5.42)).toBe("5.42");
    expect(formatCompact(0.0345)).toBe("0.035");
  });

  it("returns em-dash for non-finite", () => {
    expect(formatCompact(NaN)).toBe("—");
    expect(formatCompact(Infinity)).toBe("—");
  });
});
