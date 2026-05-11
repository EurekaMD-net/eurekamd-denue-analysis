/**
 * Tree-shaken ReactECharts wrapper.
 *
 * The bare `echarts-for-react` import pulls the entire echarts bundle
 * (~900 KB minified). The `/lib/core` entry expects the consumer to
 * pass an `echarts` namespace with only the components/charts they
 * actually use registered via `echarts.use([...])`. We do that once
 * here and re-export a default React component that bakes the namespace
 * in — every consumer in the codebase imports from this file instead
 * of `echarts-for-react`.
 *
 * Audit RH-3: keep the registration list in sync with what's actually
 * rendered. A missing registration is a SILENT BLANK CHART, not a
 * thrown error. The cost of over-registering is ~30 KB per chart type;
 * the cost of under-registering is a visible production bug.
 *
 * Current consumers (2026-05-11):
 *   - LocustMode.tsx       — bar, scatter, line, treemap
 *   - TopSectoresBar.tsx   — bar
 *   - NationalTreemap.tsx  — treemap
 *   - SectorGradeMatrix.tsx— heatmap + visualMap
 *   - DensidadPobrezaScatter.tsx — scatter + scroll legend
 *   - SaludCobertura.tsx   — bar + legend
 */

import * as echarts from "echarts/core";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { LabelLayout, UniversalTransition } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import EChartsReactCore from "echarts-for-react/lib/core";
import type { EChartsReactProps } from "echarts-for-react/lib/types";

echarts.use([
  // Charts
  BarChart,
  ScatterChart,
  LineChart,
  TreemapChart,
  HeatmapChart,
  // Components
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  // SaludCobertura uses `tooltip.axisPointer: { type: "shadow" }`; the
  // shadow indicator requires the standalone AxisPointerComponent in
  // tree-shaken builds, even though `tooltip` itself ships with the
  // legacy bundled echarts entry. Phase 4 audit W1.
  AxisPointerComponent,
  // Features (label collision avoidance, smooth transitions)
  LabelLayout,
  UniversalTransition,
  // Renderer
  CanvasRenderer,
]);

/**
 * Drop-in replacement for `import ReactECharts from "echarts-for-react"`.
 * Identical props (sans `echarts`, which is baked in).
 */
export default function ReactECharts(
  props: Omit<EChartsReactProps, "echarts">,
) {
  return <EChartsReactCore echarts={echarts} {...props} />;
}

/**
 * Re-export the configured echarts namespace for callers that need the
 * raw library (e.g. registering a custom theme). Not currently used.
 */
export { echarts };
