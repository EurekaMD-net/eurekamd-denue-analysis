import { describe, it, expect } from "vitest";
import {
  FIELD_CATALOG,
  FIELD_SOURCES,
  deriveChartType,
  findField,
  isCategorical,
  isNumeric,
} from "./fields";

describe("FIELD_CATALOG", () => {
  it("has unique ids", () => {
    const ids = FIELD_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry references a known FieldSource", () => {
    for (const f of FIELD_CATALOG) {
      expect(FIELD_SOURCES).toContain(f.source);
    }
  });

  it("findField returns the right entry by id", () => {
    expect(findField("coneval.pobreza_pct")?.label).toBe("% pobreza");
    expect(findField("nope.nope")).toBeUndefined();
  });
});

describe("deriveChartType", () => {
  it("categorical × numeric → bar", () => {
    expect(deriveChartType("categorical_nominal", "numeric_count")).toBe("bar");
  });

  it("numeric × numeric → scatter", () => {
    expect(deriveChartType("numeric_continuous", "numeric_pct")).toBe(
      "scatter",
    );
  });

  it("temporal × numeric → line", () => {
    expect(deriveChartType("temporal", "numeric_count")).toBe("line");
  });

  it("categorical × categorical → heatmap", () => {
    expect(deriveChartType("categorical_nominal", "categorical_ordinal")).toBe(
      "heatmap",
    );
  });

  it("only X set → bar", () => {
    expect(deriveChartType("categorical_nominal", null)).toBe("bar");
  });

  it("nothing set → treemap (cold canvas)", () => {
    expect(deriveChartType(null, null)).toBe("treemap");
  });
});

describe("type predicates", () => {
  it("isCategorical recognizes both nominal and ordinal", () => {
    expect(isCategorical("categorical_nominal")).toBe(true);
    expect(isCategorical("categorical_ordinal")).toBe(true);
    expect(isCategorical("numeric_count")).toBe(false);
  });

  it("isNumeric recognizes count/continuous/pct", () => {
    expect(isNumeric("numeric_count")).toBe(true);
    expect(isNumeric("numeric_continuous")).toBe(true);
    expect(isNumeric("numeric_pct")).toBe(true);
    expect(isNumeric("temporal")).toBe(false);
  });
});
