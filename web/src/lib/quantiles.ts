/**
 * Quantile binning utilities for choropleth legends.
 *
 * Given a sample of numeric values, compute terile (or arbitrary
 * percentile) cut points so each bin holds ~the same number of
 * observations. Robust to nulls, NaNs, and small samples.
 */

/**
 * Strip nulls/non-finite numbers and sort ascending.
 */
export function cleanSamples(samples: ReadonlyArray<number | null>): number[] {
  return samples
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
}

/**
 * Type-7 quantile (R default, NumPy default, D3's `d3.quantile`).
 * Returns NaN if the sample is empty. Clamps p to [0,1].
 */
export function quantile(
  sortedClean: ReadonlyArray<number>,
  p: number,
): number {
  if (sortedClean.length === 0) return NaN;
  const clamped = p <= 0 ? 0 : p >= 1 ? 1 : p;
  const idx = clamped * (sortedClean.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = sortedClean[lo]!;
  if (lo === hi) return v;
  const w = idx - lo;
  return v * (1 - w) + sortedClean[hi]! * w;
}

/**
 * Compute cut points that split the sample into `bins` equal-population
 * groups. Returns `bins - 1` thresholds. Edge cases:
 *   - empty sample → array of NaN
 *   - all-equal sample → all thresholds equal to the single value
 *   - bins < 2 → empty array (no thresholds needed)
 */
export function quantileBreaks(
  samples: ReadonlyArray<number | null>,
  bins: number,
): number[] {
  if (bins < 2) return [];
  const clean = cleanSamples(samples);
  const out: number[] = [];
  for (let i = 1; i < bins; i++) {
    out.push(quantile(clean, i / bins));
  }
  return out;
}

/**
 * Decide which bin a value falls into (0-indexed) given quantile breaks.
 * Values strictly less than breaks[0] → bin 0, etc. Null/NaN → null.
 * Returns clamped index in [0, breaks.length].
 */
export function binIndex(
  value: number | null,
  breaks: ReadonlyArray<number>,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  for (let i = 0; i < breaks.length; i++) {
    if (value < breaks[i]!) return i;
  }
  return breaks.length;
}

/**
 * Compact numeric formatter for legend axes.
 *   1234567 → "1.2M"
 *   12345   → "12.3k"
 *   12.345  → "12.3"
 *   0.0345  → "0.034"
 *   NaN     → "—"
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}
