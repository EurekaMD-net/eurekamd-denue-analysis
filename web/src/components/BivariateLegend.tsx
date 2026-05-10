import type { MapLayerSpec } from "../lib/map-layers";

/**
 * 3×3 bivariate color matrix legend (Joshua Stevens palette). Renders
 * inline as a small grid; corner labels reference the two layers.
 *
 * Trivariate (3-layer) case shown as a stacked triple-strip legend —
 * the corner-cube projection from the spec is deferred for later.
 */
export function BivariateLegend({ layers }: { layers: MapLayerSpec[] }) {
  if (layers.length === 0) return null;
  if (layers.length === 1) {
    return (
      <SingleScaleLegend label={layers[0]!.label} units={layers[0]!.units} />
    );
  }
  if (layers.length === 2) {
    return <TwoScaleLegend a={layers[0]!} b={layers[1]!} />;
  }
  return <ThreeScaleLegend a={layers[0]!} b={layers[1]!} c={layers[2]!} />;
}

function SingleScaleLegend({
  label,
  units,
}: {
  label: string;
  units?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-900 p-2">
      <span className="font-mono text-[10px] text-slate-300">{label}</span>
      <div className="flex h-3 w-32 overflow-hidden rounded">
        <div className="flex-1" style={{ background: "#0d9488" }} />
        <div className="flex-1" style={{ background: "#65a30d" }} />
        <div className="flex-1" style={{ background: "#ca8a04" }} />
        <div className="flex-1" style={{ background: "#dc2626" }} />
      </div>
      <div className="flex justify-between font-mono text-[8px] text-slate-500">
        <span>bajo</span>
        <span>alto</span>
      </div>
      {units && (
        <span className="font-mono text-[8px] text-slate-600">
          unidad: {units}
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

function TwoScaleLegend({ a, b }: { a: MapLayerSpec; b: MapLayerSpec }) {
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
                  title={`${a.label} bin ${j} × ${b.label} bin ${BIVARIATE_PALETTE.length - 1 - i}`}
                />
              ))}
            </div>
          ))}
          <div className="mt-1 font-mono text-[8px] text-slate-500">
            → {a.label}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreeScaleLegend({
  a,
  b,
  c,
}: {
  a: MapLayerSpec;
  b: MapLayerSpec;
  c: MapLayerSpec;
}) {
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
    </div>
  );
}
