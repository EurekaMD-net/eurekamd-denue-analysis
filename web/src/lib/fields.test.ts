import { describe, it, expect } from "vitest";
import {
  ENDPOINTS,
  FIELD_CATALOG,
  FIELD_SOURCES,
  deriveChartType,
  fieldSharesAnyEndpoint,
  findField,
  getActiveEndpoint,
  isCategorical,
  isFieldOnEndpoint,
  isFieldReachable,
  isNumeric,
  type EndpointId,
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
// adds a new Locust-relevant endpoint, append it here AND add an entry to
// ENDPOINTS in fields.ts before wiring fields.
const KNOWN_ANALYTICS_PATHS = new Set([
  "/analytics/national-treemap",
  "/analytics/municipios",
  "/analytics/top-sectors",
  "/analytics/risk-summary",
  "/analytics/mortality-summary",
]);

describe("reachability (endpoint-keyed)", () => {
  it("every reachable field has at least one endpoint", () => {
    for (const f of FIELD_CATALOG) {
      if (isFieldReachable(f)) {
        expect(Object.keys(f.endpoints).length).toBeGreaterThan(0);
      } else {
        expect(Object.keys(f.endpoints).length).toBe(0);
      }
    }
  });

  it("every endpoint key is one of the EndpointId literals", () => {
    const validEndpoints = Object.keys(ENDPOINTS) as EndpointId[];
    for (const f of FIELD_CATALOG) {
      for (const ep of Object.keys(f.endpoints)) {
        expect(validEndpoints).toContain(ep as EndpointId);
      }
    }
  });

  it("ENDPOINTS only references known backend paths", () => {
    for (const ep of Object.values(ENDPOINTS)) {
      // Resolve with a sample entidad ('09' = CDMX) so paths that require
      // it actually produce a URL.
      const sample = ep.path("09");
      expect(
        sample,
        `endpoint "${ep.id}" path("09") returned null`,
      ).not.toBeNull();
      const pathOnly = sample!.split("?")[0]!;
      expect(KNOWN_ANALYTICS_PATHS).toContain(pathOnly);
    }
  });

  it("every reachable field has primaryEndpoint (if set) in its endpoints map", () => {
    for (const f of FIELD_CATALOG) {
      if (!isFieldReachable(f)) continue;
      if (f.primaryEndpoint) {
        expect(
          f.endpoints[f.primaryEndpoint],
          `field "${f.id}" primaryEndpoint "${f.primaryEndpoint}" not in endpoints map`,
        ).toBeDefined();
      }
    }
  });

  it("permissive-X invariant: every reachable field anchors a non-empty Y set", () => {
    // Operator directive 2026-05-12: X picker is permissive — every
    // reachable field is an anchor. The implication: for each anchor,
    // there must be at least one OTHER reachable field on the SAME
    // endpoint, otherwise picking it strands the user with empty Y.
    for (const f of FIELD_CATALOG) {
      if (!isFieldReachable(f)) continue;
      const peers = FIELD_CATALOG.filter(
        (g) => g.id !== f.id && fieldSharesAnyEndpoint(f, g),
      );
      expect(
        peers.length,
        `anchor "${f.id}" has no Y-eligible peer (no other field shares its endpoints)`,
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

describe("isFieldOnEndpoint", () => {
  it("returns true when field has a column on the endpoint", () => {
    const estab = findField("denue.total_establecimientos")!;
    expect(isFieldOnEndpoint(estab, "municipios")).toBe(true);
    expect(isFieldOnEndpoint(estab, "national-treemap")).toBe(true);
    expect(isFieldOnEndpoint(estab, "top-sectors")).toBe(true);
  });

  it("returns false when field has no column on that endpoint", () => {
    const estab = findField("denue.total_establecimientos")!;
    expect(isFieldOnEndpoint(estab, "risk-summary")).toBe(false);
  });

  it("returns false for fields with empty endpoints map", () => {
    const orphan = findField("sinba.casos_dm2_promedio")!;
    expect(orphan.endpoints).toEqual({});
    expect(isFieldOnEndpoint(orphan, "municipios")).toBe(false);
  });
});

describe("getActiveEndpoint (X+Y+Z resolution)", () => {
  it("returns X.primaryEndpoint when X alone and primary is set", () => {
    const x = findField("denue.total_establecimientos")!;
    expect(getActiveEndpoint(x)).toBe("municipios");
  });

  it("returns first endpoint when X has no primary", () => {
    const x = findField("denue.entidad_nombre")!;
    expect(getActiveEndpoint(x)).toBe("national-treemap");
  });

  it("returns null for unreachable X", () => {
    const x = findField("sinba.casos_dm2_promedio")!;
    expect(getActiveEndpoint(x)).toBeNull();
  });

  it("resolves to endpoint where BOTH X and Y have columns", () => {
    // X = municipio_nombre (on municipios, risk-summary, mortality-summary)
    // Y = sesnsp.homicidio_doloso (on risk-summary only)
    // → resolves to risk-summary, not municipios.
    const x = findField("denue.municipio_nombre")!;
    const y = findField("sesnsp.homicidio_doloso")!;
    expect(getActiveEndpoint(x, y)).toBe("risk-summary");
  });

  it("prefers X.primaryEndpoint when Y is also on it", () => {
    // X = municipio_nombre (primary: municipios)
    // Y = censo.pobtot (on municipios, risk-summary, mortality-summary)
    // → resolves to municipios (X's primary wins among multiple intersections).
    const x = findField("denue.municipio_nombre")!;
    const y = findField("censo.pobtot")!;
    expect(getActiveEndpoint(x, y)).toBe("municipios");
  });

  it("returns null when X and Y have no shared endpoint", () => {
    const x = findField("denue.entidad_nombre")!;
    const y = findField("sesnsp.homicidio_doloso")!;
    expect(getActiveEndpoint(x, y)).toBeNull();
  });

  it("requires Z to share the endpoint too when provided", () => {
    const x = findField("denue.municipio_nombre")!;
    const y = findField("censo.pobtot")!;
    const z = findField("sesnsp.homicidio_doloso")!;
    // All three must be on same endpoint. Y is on municipios+risk+mortality;
    // Z is only on risk-summary; X is on all 3. → risk-summary.
    expect(getActiveEndpoint(x, y, z)).toBe("risk-summary");
  });
});

describe("fieldSharesAnyEndpoint", () => {
  it("true when fields share at least one endpoint", () => {
    const x = findField("denue.municipio_nombre")!;
    const y = findField("sesnsp.homicidio_doloso")!;
    expect(fieldSharesAnyEndpoint(x, y)).toBe(true);
  });

  it("false when fields are on disjoint endpoints", () => {
    const x = findField("denue.entidad_nombre")!; // national-treemap
    const y = findField("sesnsp.homicidio_doloso")!; // risk-summary
    expect(fieldSharesAnyEndpoint(x, y)).toBe(false);
  });

  it("false when one field is unreachable", () => {
    const x = findField("denue.municipio_nombre")!;
    const y = findField("sinba.casos_dm2_promedio")!;
    expect(fieldSharesAnyEndpoint(x, y)).toBe(false);
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
