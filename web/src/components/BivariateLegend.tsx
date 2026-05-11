import type { MapLayerSpec } from "../lib/map-layers";
import { cleanSamples, formatCompact, quantileBreaks } from "../lib/quantiles";

/**
 * 3×3 bivariate color matrix legend (Joshua Stevens palette). Renders
 * inline as a small grid; corner labels reference the two layers.
 *
 * Trivariate (3-layer) case shown as a stacked triple-strip legend —
 * the corner-cube projection from the spec is deferred for later.
 *
 * RH-2: thresholds are computed from the actual `values` payload (the
 * /analytics/layers/values response, keyed by polygon ID). When `values`
 * is provided, the legend shows real numeric breakpoints per layer. When
 * absent (loading state or no data), it falls back to bin-index labels.
 */
export interface BivariateLegendProps {
  layers: MapLayerSpec[];
  /**
   * Optional layer-values payload. Outer key is polygon ID (cve_mun /
   * cvegeo), inner key is layer ID. Used to derive tertile thresholds
   * for the legend axis tick labels.
   */
  values?: Record<string, Record<string, number | null>> | undefined;
}

/**
 * Pull the sample of one layer's values across all polygons.
 */
function samplesForLayer(
  values: BivariateLegendProps["values"],
  layerId: string,
): Array<number | null> {
  if (!values) return [];
  const out: Array<number | null> = [];
  for (const polygon of Object.values(values)) {
    const v = polygon[layerId];
    out.push(v ?? null);
  }
  return out;
}

interface LayerDomain {
  /** Tertile cut points; length 2 when data is present, else empty. */
  breaks: number[];
  /** Min/max across the cleaned sample, for axis labels. */
  min: number;
  max: number;
  /** Count of non-null observations. */
  n: number;
}

function layerDomain(
  values: BivariateLegendProps["values"],
  layerId: string,
): LayerDomain {
  const samples = samplesForLayer(values, layerId);
  const clean = cleanSamples(samples);
  return {
    breaks: quantileBreaks(samples, 3),
    min: clean.length > 0 ? clean[0]! : NaN,
    max: clean.length > 0 ? clean[clean.length - 1]! : NaN,
    n: clean.length,
  };
}

export function BivariateLegend({ layers, values }: BivariateLegendProps) {
  if (layers.length === 0) return null;
  if (layers.length === 1) {
    return (
      <SingleScaleLegend
        layer={layers[0]!}
        domain={layerDomain(values, layers[0]!.id)}
      />
    );
  }
  if (layers.length === 2) {
    return (
      <TwoScaleLegend
        a={layers[0]!}
        b={layers[1]!}
        domainA={layerDomain(values, layers[0]!.id)}
        domainB={layerDomain(values, layers[1]!.id)}
      />
    );
  }
  return (
    <ThreeScaleLegend
      a={layers[0]!}
      b={layers[1]!}
      c={layers[2]!}
      domainA={layerDomain(values, layers[0]!.id)}
      domainB={layerDomain(values, layers[1]!.id)}
      domainC={layerDomain(values, layers[2]!.id)}
    />
  );
}

function SingleScaleLegend({
  layer,
  domain,
}: {
  layer: MapLayerSpec;
  domain: LayerDomain;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-900 p-2">
      <span className="font-mono text-[10px] text-slate-300">
        {layer.label}
      </span>
      <div className="flex h-3 w-32 overflow-hidden rounded">
        <div className="flex-1" style={{ background: "#0d9488" }} />
        <div className="flex-1" style={{ background: "#65a30d" }} />
        <div className="flex-1" style={{ background: "#ca8a04" }} />
        <div className="flex-1" style={{ background: "#dc2626" }} />
      </div>
      <div className="flex justify-between font-mono text-[8px] text-slate-500">
        <span>{domain.n > 0 ? formatCompact(domain.min) : "bajo"}</span>
        <span>{domain.n > 0 ? formatCompact(domain.max) : "alto"}</span>
      </div>
      {layer.units && (
        <span className="font-mono text-[8px] text-slate-600">
          unidad: {layer.units}
          {domain.n > 0 ? ` · n=${domain.n}` : ""}
        </span>
      )}
    </div>
  );
}

const BIVARIATE_PALETTE = [
  ["#e8e8e8", "#ace4e4", "#5ac8c8"], // low Y
  ["#dfb0d6", "#a5add3", "#5698b9"],
  ["#be64ac", "#8c62aa", "#3b4994"], // high Y
];

function TwoScaleLegend({
  a,
  b,
  domainA,
  domainB,
}: {
  a: MapLayerSpec;
  b: MapLayerSpec;
  domainA: LayerDomain;
  domainB: LayerDomain;
}) {
  // Thresholds: tertile breaks (length 2) split the 3 bins.
  const hasData = domainA.n > 0 || domainB.n > 0;
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-900 p-2">
      <span className="font-mono text-[10px] text-slate-300">
        {a.label} × {b.label}
      </span>
      <div className="flex items-end gap-1">
        <div
          className="font-mono text-[8px] text-slate-500"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          ↑ {b.label}
        </div>
        <div className="flex flex-col">
          {BIVARIATE_PALETTE.map((row, i) => (
            <div key={i} className="flex">
              {row.map((color, j) => (
                <div
                  key={j}
                  className="h-4 w-4"
                  style={{ background: color }}
                  title={cellTitle(
                    a,
                    b,
                    domainA,
                    domainB,
                    j,
                    BIVARIATE_PALETTE.length - 1 - i,
                  )}
                />
              ))}
            </div>
          ))}
          <div className="mt-1 font-mono text-[8px] text-slate-500">
            → {a.label}
          </div>
        </div>
      </div>
      {hasData && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[8px] text-slate-500">
          <span>
            {a.label}: {formatBinThresholds(domainA)}
          </span>
          <span>
            {b.label}: {formatBinThresholds(domainB)}
          </span>
        </div>
      )}
    </div>
  );
}

function ThreeScaleLegend({
  a,
  b,
  c,
  domainA,
  domainB,
  domainC,
}: {
  a: MapLayerSpec;
  b: MapLayerSpec;
  c: MapLayerSpec;
  domainA: LayerDomain;
  domainB: LayerDomain;
  domainC: LayerDomain;
}) {
  const hasData = domainA.n > 0 || domainB.n > 0 || domainC.n > 0;
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-900 p-2">
      <span className="font-mono text-[10px] text-slate-300">Trivariada</span>
      <div className="grid grid-cols-3 gap-1 font-mono text-[9px]">
        <span className="text-rose-400">R: {a.label}</span>
        <span className="text-emerald-400">G: {b.label}</span>
        <span className="text-sky-400">B: {c.label}</span>
      </div>
      <span className="font-mono text-[8px] text-slate-500">
        Cada componente RGB del punto codifica un layer (alto valor = canal
        saturado).
      </span>
      {hasData && (
        <div className="mt-1 flex flex-col gap-0.5 font-mono text-[8px] text-slate-500">
          <span>
            R · {a.label}: {formatBinThresholds(domainA)}
          </span>
          <span>
            G · {b.label}: {formatBinThresholds(domainB)}
          </span>
          <span>
            B · {c.label}: {formatBinThresholds(domainC)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Render the tertile thresholds inline.
 *   n=0                      → "—"
 *   all-equal sample (t1=t2) → "constante v (n=N)"  (RH-2 audit R2)
 *   normal                   → "≤12.3 · ≤45.7 · >45.7 (n=N)"
 */
function formatBinThresholds(d: LayerDomain): string {
  if (d.n === 0 || d.breaks.length < 2) return "—";
  const [t1, t2] = d.breaks;
  if (t1 === t2) {
    return `constante ${formatCompact(t1!)} (n=${d.n})`;
  }
  return `≤${formatCompact(t1!)} · ≤${formatCompact(t2!)} · >${formatCompact(t2!)} (n=${d.n})`;
}

function cellTitle(
  a: MapLayerSpec,
  b: MapLayerSpec,
  domainA: LayerDomain,
  domainB: LayerDomain,
  binA: number,
  binB: number,
): string {
  if (domainA.n === 0 && domainB.n === 0) {
    return `${a.label} bin ${binA} × ${b.label} bin ${binB}`;
  }
  const aLabel = binLabel(domainA, binA, a.label);
  const bLabel = binLabel(domainB, binB, b.label);
  return `${aLabel} · ${bLabel}`;
}

function binLabel(d: LayerDomain, bin: number, name: string): string {
  if (d.breaks.length < 2 || d.n === 0) return `${name} bin ${bin}`;
  const [t1, t2] = d.breaks;
  if (bin === 0) return `${name} ≤ ${formatCompact(t1!)}`;
  if (bin === 1) return `${name} ${formatCompact(t1!)}–${formatCompact(t2!)}`;
  return `${name} > ${formatCompact(t2!)}`;
}
