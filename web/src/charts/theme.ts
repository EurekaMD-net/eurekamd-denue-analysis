/**
 * Shared color palette + ECharts dark base. Imported by every chart so
 * the dashboard reads as one piece.
 *
 * Slate-950 page background, slate-900 panels, slate-200 text. Cyan as
 * primary accent; amber for warnings/alto-rezago; emerald for low/good;
 * rose for muy-alto-rezago. Mono fonts for numbers, system sans for prose.
 *
 * IRS grade palette is ordered Muy bajo → Muy alto so charts can map
 * categorically. sin_dato is a neutral slate so missing-data cells fade
 * rather than scream.
 */

import type { IrsGrado } from "../api/types";

export const COLOR = {
  bg: "#020617", // slate-950
  panel: "#0f172a", // slate-900
  panelMuted: "#1e293b", // slate-800
  border: "#334155", // slate-700
  text: "#e2e8f0", // slate-200
  textMuted: "#94a3b8", // slate-400
  textDim: "#64748b", // slate-500
  accent: "#22d3ee", // cyan-400
  accentDim: "#0e7490", // cyan-700

  // IRS grade ramp (Muy bajo = best, Muy alto = worst)
  grado: {
    "Muy bajo": "#34d399", // emerald-400
    Bajo: "#22d3ee", // cyan-400
    Medio: "#facc15", // yellow-400
    Alto: "#fb923c", // orange-400
    "Muy alto": "#fb7185", // rose-400
    sin_dato: "#475569", // slate-600
  } as const satisfies Record<IrsGrado, string>,
} as const;

/**
 * IRS grados in canonical order. Use for legend ordering and matrix axis
 * sorting so charts stay readable across pages.
 */
export const IRS_GRADO_ORDER: ReadonlyArray<IrsGrado> = [
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
  "sin_dato",
];

/**
 * Base ECharts option fragments. Spread at the top of each chart's
 * `option` to inherit the dark theme.
 */
export const ECHARTS_BASE = {
  backgroundColor: "transparent",
  textStyle: {
    color: COLOR.text,
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  tooltip: {
    backgroundColor: COLOR.panelMuted,
    borderColor: COLOR.border,
    textStyle: { color: COLOR.text, fontSize: 12 },
    extraCssText: "border-radius: 4px;",
  },
} as const;

export const ECHARTS_AXIS_DARK = {
  axisLine: { lineStyle: { color: COLOR.border } },
  axisTick: { lineStyle: { color: COLOR.border } },
  axisLabel: { color: COLOR.textMuted, fontSize: 11 },
  splitLine: { lineStyle: { color: COLOR.panelMuted, type: "dashed" } },
} as const;
