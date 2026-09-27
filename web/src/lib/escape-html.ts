/**
 * Escape a value for interpolation into an HTML string.
 *
 * ECharts renders a custom `tooltip.formatter` return value with
 * innerHTML and does not escape it (only its built-in formatters do).
 * Every API-sourced string (municipio / entidad names, SCIAN codes and
 * names, IRS grades, Locust X labels) that goes into a tooltip must pass
 * through here first (audit #193).
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
