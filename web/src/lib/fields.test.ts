import { describe, it, expect } from "vitest";
import {
  FIELD_CATALOG,
  FIELD_SOURCES,
  GRAIN_ENDPOINTS,
  deriveChartType,
  findField,
  isCategorical,
  isFieldGraphableAt,
  isFieldReachable,
  isNumeric,
  type FieldGrain,
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

// Hardcoded list of currently-served analytics endpoints (paths only —
// query strings stripped). Sourced from src/api/server.ts. If the backend
// adds a new Locust-relevant endpoint, append it here AND in
// GRAIN_ENDPOINTS below before wiring fields.
const KNOWN_ANALYTICS_PATHS = new Set([
  "/analytics/national-treemap",
  "/analytics/municipios",
  "/analytics/top-sectors",
]);

describe("reachability (X-key invariant)", () => {
  it("every reachable field has at least one column", () => {
    for (const f of FIELD_CATALOG) {
      if (isFieldReachable(f)) {
        expect(Object.keys(f.columns).length).toBeGreaterThan(0);
      } else {
        expect(Object.keys(f.columns).length).toBe(0);
      }
    }
  });

  it("every column-grain key is one of the FieldGrain literals", () => {
    const validGrains: FieldGrain[] = ["muni", "ageb", "estado", "nacional"];
    for (const f of FIELD_CATALOG) {
      for (const grain of Object.keys(f.columns)) {
        expect(validGrains).toContain(grain as FieldGrain);
      }
    }
  });

  it("every wired column-grain has an endpoint in GRAIN_ENDPOINTS", () => {
    for (const f of FIELD_CATALOG) {
      for (const grain of Object.keys(f.columns) as FieldGrain[]) {
        expect(GRAIN_ENDPOINTS[grain]).toBeDefined();
      }
    }
  });

  it("GRAIN_ENDPOINTS only references known backend paths", () => {
    for (const ep of Object.values(GRAIN_ENDPOINTS)) {
      if (!ep) continue;
      // Resolve with a sample entidad ('09' = CDMX) so paths that require
      // it actually produce a URL.
      const sample = ep.path("09");
      expect(sample, `endpoint.path("09") returned null`).not.toBeNull();
      const pathOnly = sample!.split("?")[0]!;
      expect(KNOWN_ANALYTICS_PATHS).toContain(pathOnly);
    }
  });

  it("every reachable field has a column at its own grain (self-key)", () => {
    // Operator directive 2026-05-12: every reachable field can anchor as X.
    // The implication: when the user picks field F as X, the endpoint
    // F.grain dispatches to must contain a column for F itself (or the
    // chart x-axis is unlabelable).
    for (const f of FIELD_CATALOG) {
      if (isFieldReachable(f)) {
        expect(
          f.columns[f.grain],
          `field "${f.id}" reachable but missing self-grain column`,
        ).toBeDefined();
        expect(
          GRAIN_ENDPOINTS[f.grain],
          `field "${f.id}" grain "${f.grain}" has no GRAIN_ENDPOINTS entry`,
        ).toBeDefined();
      }
    }
  });

  it("permissive-X invariant: every reachable field anchors a non-empty Y set", () => {
    // Operator directive 2026-05-12: X picker is permissive — every
    // reachable field is an anchor. The implication: for each anchor,
    // there must be at least one OTHER reachable field with a column at
    // X.grain, otherwise picking it strands the user (no Y option). The
    // self-key column is excluded since the user wouldn't pick the same
    // field as both X and Y.
    for (const f of FIELD_CATALOG) {
      if (!isFieldReachable(f)) continue;
      const peers = FIELD_CATALOG.filter(
        (g) => g.id !== f.id && isFieldGraphableAt(g, f.grain),
      );
      expect(
        peers.length,
        `anchor "${f.id}" (grain ${f.grain}) has no Y-eligible peer`,
      ).toBeGreaterThan(0);
    }
  });

  it("categorical_ordinal fields declare an ordinalOrder for Z-colourant", () => {
    for (const f of FIELD_CATALOG) {
      if (f.type === "categorical_ordinal") {
        expect(
          f.ordinalOrder,
          `ordinal field "${f.id}" must declare ordinalOrder`,
        ).toBeDefined();
        expect(f.ordinalOrder!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("isFieldGraphableAt", () => {
  it("returns true when field has column for the given grain", () => {
    const estab = findField("denue.total_establecimientos")!;
    expect(isFieldGraphableAt(estab, "estado")).toBe(true);
    expect(isFieldGraphableAt(estab, "muni")).toBe(true);
    expect(isFieldGraphableAt(estab, "nacional")).toBe(true);
  });

  it("returns false when field has no column for that grain", () => {
    const estab = findField("denue.total_establecimientos")!;
    expect(isFieldGraphableAt(estab, "ageb")).toBe(false);
  });

  it("returns false for fields with empty columns map", () => {
    const orphan = findField("sesnsp.homicidio_doloso")!;
    expect(orphan.columns).toEqual({});
    expect(isFieldGraphableAt(orphan, "muni")).toBe(false);
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
