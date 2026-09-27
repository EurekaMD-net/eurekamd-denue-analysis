import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escape-html";
import { densidadTooltipFormatter } from "../charts/DensidadPobrezaScatter";
import {
  NationalTreemap,
  treemapTooltipFormatter,
} from "../charts/NationalTreemap";
import {
  SectorGradeMatrix,
  sectorGradeTooltipFormatter,
} from "../charts/SectorGradeMatrix";
import {
  TopSectoresBar,
  topSectoresTooltipFormatter,
} from "../charts/TopSectoresBar";
import { DensidadPobrezaScatter } from "../charts/DensidadPobrezaScatter";
import { SaludCobertura } from "../charts/SaludCobertura";

const XSS = "<img src=x onerror=alert(1)>";
const XSS_ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("turns an injected tag into inert text", () => {
    expect(escapeHtml(XSS)).toBe(XSS_ESCAPED);
  });

  it("stringifies numbers and maps null/undefined to empty", () => {
    expect(escapeHtml(7)).toBe("7");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("leaves accented names untouched", () => {
    expect(escapeHtml("Coyoacán · Muy alto")).toBe("Coyoacán · Muy alto");
  });
});

// Audit #193: every custom tooltip formatter returns HTML that ECharts
// writes with innerHTML, so API strings must come out escaped.
describe("legacy chart tooltips escape API strings (#193)", () => {
  it("DensidadPobrezaScatter: municipio name, cve_mun and grado", () => {
    const html = densidadTooltipFormatter({
      name: XSS,
      value: [1.5, 40, 1000, XSS, XSS],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(`<b>${XSS_ESCAPED}</b>`);
    expect(html).toContain(`IRS: ${XSS_ESCAPED}`);
  });

  it("NationalTreemap: entidad name and IRS grade", () => {
    const html = treemapTooltipFormatter({
      data: { nombreCorto: XSS, value: 10, irs: XSS, pobreza: null },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(`<b>${XSS_ESCAPED}</b>`);
    expect(html).toContain(`IRS modal: ${XSS_ESCAPED}`);
  });

  it("TopSectoresBar: sector label", () => {
    const html = topSectoresTooltipFormatter({ name: XSS, value: 3 });
    expect(html).not.toContain("<img");
    expect(html).toContain(`<b>${XSS_ESCAPED}</b>`);
  });

  it("SectorGradeMatrix: SCIAN code", () => {
    const html = sectorGradeTooltipFormatter([XSS])({ data: [0, 0, 5] });
    expect(html).not.toContain("<img");
    expect(html).toContain(`<b>SCIAN ${XSS_ESCAPED}</b>`);
  });
});

// Audit #189: LegacyDashboard re-renders on every entidad click; the
// charts must be memo components so unchanged props skip the render
// (and the notMerge setOption it used to trigger).
describe("legacy charts are React.memo components (#189)", () => {
  const MEMO = Symbol.for("react.memo");
  it.each([
    ["NationalTreemap", NationalTreemap],
    ["SectorGradeMatrix", SectorGradeMatrix],
    ["TopSectoresBar", TopSectoresBar],
    ["DensidadPobrezaScatter", DensidadPobrezaScatter],
    ["SaludCobertura", SaludCobertura],
  ])("%s", (_name, component) => {
    expect((component as unknown as { $$typeof?: symbol }).$$typeof).toBe(MEMO);
  });
});
