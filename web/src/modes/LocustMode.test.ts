import { describe, expect, it } from "vitest";
import {
  applyFilterPins,
  buildEChartsOption,
  computeZRange,
  extractRows,
} from "./LocustMode";
import { findField } from "../lib/fields";

const rows = [
  { x: "Veracruz", y: 100, z: null },
  { x: "Puebla", y: 80, z: null },
  { x: "Oaxaca", y: 60, z: null },
];

describe("applyFilterPins (RH-1)", () => {
  it("returns all rows when no pins are set", () => {
    expect(applyFilterPins(rows, [])).toEqual(rows);
  });

  it("filters to rows whose x matches a single pin value", () => {
    const out = applyFilterPins(rows, [
      { axis: "x", label: "Entidad", value: "Puebla" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.x).toBe("Puebla");
  });

  it("treats multiple pins as an inclusion set (OR within axis)", () => {
    const out = applyFilterPins(rows, [
      { axis: "x", label: "Entidad", value: "Veracruz" },
      { axis: "x", label: "Entidad", value: "Oaxaca" },
    ]);
    expect(out.map((r) => r.x)).toEqual(["Veracruz", "Oaxaca"]);
  });

  it("returns empty when no row matches any pin", () => {
    const out = applyFilterPins(rows, [
      { axis: "x", label: "Entidad", value: "Yucatán" },
    ]);
    expect(out).toEqual([]);
  });

  it("compares as strings so numeric/categorical x values dedupe", () => {
    const mixed = [
      { x: 9, y: 1, z: null },
      { x: "9", y: 2, z: null },
      { x: "10", y: 3, z: null },
    ];
    const out = applyFilterPins(mixed, [
      { axis: "x", label: "ent", value: "9" },
    ]);
    expect(out).toHaveLength(2);
  });
});

// extractRows is the endpoint-payload → DataPoint[] reducer that decides
// whether the chart sees data. It reads column names off
// xField.columns[xField.grain] etc, so a broken catalog wiring shows
// here first.
const axisState = (fieldId: string | null) => ({
  field: fieldId ? (findField(fieldId) ?? null) : null,
  geoLevel: 1 as 0 | 1 | 2,
  scianLevel: 2 as 2 | 3 | 4 | 5 | 6,
});

describe("extractRows (X-key invariant)", () => {
  it("reads /national-treemap payload for estado-grain X", () => {
    const payload = {
      entidades: [
        {
          entidad: "09",
          nombre: "Ciudad de México",
          establecimientos: 451000,
          pobreza_pct_promedio: 27.1,
        },
        {
          entidad: "31",
          nombre: "Yucatán",
          establecimientos: 95000,
          pobreza_pct_promedio: 40.4,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState("coneval.pobreza_pct"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      x: "Ciudad de México",
      y: 451000,
      z: 27.1,
    });
  });

  it("reads /locust-muni payload for muni-grain X", () => {
    // X = municipio_nombre (primary: locust-muni) + Y = total_establecimientos
    // (primary: locust-muni) + Z = censo.pobtot (on locust-muni) → resolves
    // to locust-muni endpoint. Payload column names match locust-muni schema.
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 614447,
          denue_establecimientos: 14000,
          pobreza_pct: 18.5,
        },
        {
          cve_mun: "09005",
          municipio: "Gustavo A. Madero",
          poblacion: 1173351,
          denue_establecimientos: 26500,
          pobreza_pct: 25.9,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("denue.total_establecimientos"),
      axisState("censo.pobtot"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      x: "Coyoacán",
      y: 14000,
      z: 614447,
    });
  });

  it("reads /top-sectors payload for SCIAN-grain X", () => {
    const payload = {
      entidad: "09",
      sectors: [
        { scian: "46", name: "Comercio al por menor", count: 142000 },
        { scian: "72", name: "Servicios de alojamiento", count: 51000 },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.scian_sector"),
      axisState("denue.total_establecimientos"),
      axisState(null),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      x: "Comercio al por menor",
      y: 142000,
      z: null,
    });
  });

  it("returns [] when X or Y field is missing", () => {
    expect(
      extractRows(
        { entidades: [{ nombre: "A", establecimientos: 1 }] },
        axisState(null),
        axisState("denue.total_establecimientos"),
        axisState(null),
      ),
    ).toEqual([]);
  });

  it("returns [] when Y has no column at X's grain (unreachable combo)", () => {
    // clues.total has only muni column; combined with estado-grain X
    // there's no column to read.
    const rows = extractRows(
      { entidades: [{ nombre: "CDMX", establecimientos: 1 }] },
      axisState("denue.entidad_nombre"),
      axisState("clues.total"),
      axisState(null),
    );
    expect(rows).toEqual([]);
  });

  it("falls back to 'rows' key when endpoint shape uses generic envelope", () => {
    const payload = {
      rows: [{ nombre: "X", establecimientos: 99, pobreza_pct_promedio: 30 }],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState(null),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.y).toBe(99);
  });

  // Regression 2026-05-13: extractRows previously called
  // getActiveEndpoint(xField) with only X, which picks X.primaryEndpoint
  // (or X's first key). When Y lived on a *different* endpoint shared
  // with X (e.g. entidad_nombre × enigh.ingreso_p50 share only
  // locust-estado; X's first key is national-treemap), the wrong
  // endpoint was selected, the Y column lookup missed, and every row
  // was dropped. The fetcher already resolves with X+Y+Z; the parser
  // must agree.

  it("Entidad × enigh.ingreso_p50 resolves to locust-estado (not X's first endpoint)", () => {
    // X is on national-treemap + locust-estado. Y is only on
    // locust-estado. Must resolve to locust-estado.
    const payload = {
      entidades: [
        {
          cve_ent: "09",
          nom_ent: "Ciudad de México",
          enigh_ingreso_p50: 81867.96,
        },
        { cve_ent: "15", nom_ent: "México", enigh_ingreso_p50: 58311.63 },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("enigh.ingreso_p50"),
      axisState(null),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ x: "Ciudad de México", y: 81867.96, z: null });
  });

  it("Municipio × sesnsp.total_delitos resolves to risk-summary (not X.primaryEndpoint)", () => {
    // X.primaryEndpoint = locust-muni. Y is only on risk-summary. Must
    // resolve to risk-summary because the X+Y intersection forces it.
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 614447,
          total_delitos: 12000,
        },
        {
          cve_mun: "09005",
          municipio: "Gustavo A. Madero",
          poblacion: 1173351,
          total_delitos: 23000,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("sesnsp.total_delitos"),
      axisState(null),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ x: "Coyoacán", y: 12000, z: null });
  });

  it("Municipio × edr.total_defunciones resolves to mortality-summary", () => {
    // Same bug class, mortality-summary surface.
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 614447,
          total_defunciones: 4200,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("edr.total_defunciones"),
      axisState(null),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.y).toBe(4200);
  });

  it("drops rows where Y is not finite", () => {
    const payload = {
      entidades: [
        { nombre: "A", establecimientos: 100 },
        { nombre: "B", establecimientos: null },
        { nombre: "C", establecimientos: "not-a-number" },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState(null),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.x).toBe("A");
  });

  // W4 audit fix: precedence between endpoint.rowsKey and the generic 'rows'
  // fallback. The endpoint-keyed array must win.
  it("prefers endpoint.rowsKey over generic 'rows' when both present", () => {
    const payload = {
      entidades: [{ nombre: "FromEntidades", establecimientos: 1 }],
      rows: [{ nombre: "FromRows", establecimientos: 99 }],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState(null),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.x).toBe("FromEntidades");
    expect(rows[0]?.y).toBe(1);
  });

  // 2026-05-13: per-capita (× 1,000 hab) normalization toggle. Only
  // applies on muni-grain endpoints where censo.pobtot is exposed, only
  // to numeric_count fields, and never to censo.pobtot itself.

  it("perCapita off: leaves Y/Z unchanged (default)", () => {
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 600000,
          total_delitos: 12000,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("sesnsp.total_delitos"),
      axisState(null),
    );
    expect(rows[0]?.y).toBe(12000);
  });

  it("perCapita on (muni, count Y): projects Y to (y * 1000) / pobtot", () => {
    const payload = {
      entidad: "09",
      municipios: [
        // 12000 delitos / 600000 hab * 1000 = 20.0 per 1k hab
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 600000,
          total_delitos: 12000,
        },
        // 6000 / 1000000 * 1000 = 6.0
        {
          cve_mun: "09005",
          municipio: "GAM",
          poblacion: 1000000,
          total_delitos: 6000,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("sesnsp.total_delitos"),
      axisState(null),
      { perCapita: true },
    );
    expect(rows.map((r) => r.y)).toEqual([20, 6]);
  });

  it("perCapita on (muni, count Y + count Z): normalizes both axes", () => {
    const payload = {
      entidad: "09",
      municipios: [
        // y = total_defunciones / pob * 1000; z = total_delitos / pob * 1000
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 500000,
          total_defunciones: 2500,
          total_delitos: 10000,
        },
      ],
    };
    // X=municipio_nombre + Y=edr.total_defunciones + Z=sesnsp.total_delitos
    // share no muni-composite endpoint (one is on mortality-summary, the
    // other on risk-summary). Use Z on the same endpoint as Y instead.
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("edr.total_defunciones"),
      axisState("censo.pobtot"),
      { perCapita: true },
    );
    // Y normalized: 2500 / 500000 * 1000 = 5.0
    // Z is censo.pobtot itself → NOT normalized (would be the constant 1000)
    expect(rows[0]?.y).toBe(5);
    expect(rows[0]?.z).toBe(500000);
  });

  it("perCapita on but Y is censo.pobtot: Y is NOT normalized", () => {
    // Normalizing pobtot by pobtot gives the constant 1000 — silly. The
    // implementation excludes the field by id.
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 600000,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("censo.pobtot"),
      axisState(null),
      { perCapita: true },
    );
    expect(rows[0]?.y).toBe(600000);
  });

  it("perCapita on (estado-grain): no normalization (only muni grain qualifies)", () => {
    // /national-treemap returns one row per estado with no pobtot column.
    const payload = {
      entidades: [
        {
          nombre: "CDMX",
          establecimientos: 451000,
          pobreza_pct_promedio: 27.1,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState(null),
      { perCapita: true },
    );
    expect(rows[0]?.y).toBe(451000);
  });

  it("perCapita on but pobtot row is null/zero: leaves Y unchanged (no /0)", () => {
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: null,
          total_delitos: 12000,
        },
        {
          cve_mun: "09005",
          municipio: "GAM",
          poblacion: 0,
          total_delitos: 6000,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("sesnsp.total_delitos"),
      axisState(null),
      { perCapita: true },
    );
    expect(rows.map((r) => r.y)).toEqual([12000, 6000]);
  });

  it("perCapita on (Y is pct, not count): no normalization", () => {
    // numeric_pct fields are already ratios — normalizing again is wrong.
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 600000,
          pobreza_pct: 18.5,
        },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.municipio_nombre"),
      axisState("coneval.pobreza_pct"),
      axisState(null),
      { perCapita: true },
    );
    expect(rows[0]?.y).toBe(18.5);
  });

  // C1 audit fix: categorical_ordinal Z (irs_grado) must map "Muy bajo" …
  // "Muy alto" to ranks 0..4, not NaN.
  it("maps categorical_ordinal Z values to ordinal ranks (irs_grado)", () => {
    const payload = {
      entidades: [
        {
          nombre: "A",
          establecimientos: 100,
          modal_irs_grado: "Muy bajo",
        },
        { nombre: "B", establecimientos: 80, modal_irs_grado: "Medio" },
        { nombre: "C", establecimientos: 60, modal_irs_grado: "Muy alto" },
        // sin_dato is not in IRS_GRADO_ORDER → projects to null.
        { nombre: "D", establecimientos: 40, modal_irs_grado: "sin_dato" },
      ],
    };
    const rows = extractRows(
      payload,
      axisState("denue.entidad_nombre"),
      axisState("denue.total_establecimientos"),
      axisState("coneval.irs_grado"),
    );
    expect(rows.map((r) => r.z)).toEqual([0, 2, 4, null]);
  });
});

describe("buildEChartsOption (per-capita label invariants)", () => {
  // Audit C1 (commit 3ccef39 → follow-up): X label was wrongly gaining
  // "/ 1k hab" when X was a count field, even though extractRows never
  // normalizes X. Pin: X label is always raw, Y/Z labels gain the suffix
  // only when the field is a non-pobtot count.
  it("scatter: X axis label never gets per-capita suffix, even if X is a count", () => {
    const xCount = axisState("denue.total_establecimientos");
    const yCount = axisState("sesnsp.total_delitos");
    const option = buildEChartsOption(
      "scatter",
      [{ x: 100, y: 200, z: null }],
      xCount,
      yCount,
      axisState(null),
      { perCapita: true },
    );
    const xName = (option.xAxis as { name?: string }).name;
    const yName = (option.yAxis as { name?: string }).name;
    expect(xName).toBe(xCount.field!.label);
    expect(xName).not.toMatch(/\/ 1k hab/);
    expect(yName).toMatch(/\/ 1k hab$/);
  });

  it("bar: Y axis gets suffix when count + perCapita; raw label otherwise", () => {
    const xMuni = axisState("denue.municipio_nombre");
    const yCount = axisState("sesnsp.total_delitos");
    const onOption = buildEChartsOption(
      "bar",
      [{ x: "Coyoacán", y: 10, z: null }],
      xMuni,
      yCount,
      axisState(null),
      { perCapita: true },
    );
    expect((onOption.yAxis as { name?: string }).name).toMatch(/\/ 1k hab$/);
    const offOption = buildEChartsOption(
      "bar",
      [{ x: "Coyoacán", y: 10, z: null }],
      xMuni,
      yCount,
      axisState(null),
      { perCapita: false },
    );
    expect((offOption.yAxis as { name?: string }).name).toBe(
      yCount.field!.label,
    );
  });

  it("line: yAxis carries `name` so the per-capita suffix surfaces (W1 fix)", () => {
    const option = buildEChartsOption(
      "line",
      [{ x: "Coyoacán", y: 10, z: null }],
      axisState("denue.municipio_nombre"),
      axisState("sesnsp.total_delitos"),
      axisState(null),
      { perCapita: true },
    );
    const yAxis = option.yAxis as { name?: string };
    expect(yAxis.name).toMatch(/\/ 1k hab$/);
  });

  it("Y is censo.pobtot: no suffix even with perCapita on", () => {
    const option = buildEChartsOption(
      "bar",
      [{ x: "Coyoacán", y: 600000, z: null }],
      axisState("denue.municipio_nombre"),
      axisState("censo.pobtot"),
      axisState(null),
      { perCapita: true },
    );
    const yName = (option.yAxis as { name?: string }).name;
    expect(yName).not.toMatch(/\/ 1k hab/);
  });
});

describe("computeZRange (W3 audit fix — precomputed range)", () => {
  it("returns null when no row has a finite z", () => {
    expect(
      computeZRange([
        { x: "a", y: 1, z: null },
        { x: "b", y: 2, z: null },
      ]),
    ).toBeNull();
  });

  it("returns {min, max} from finite z values, ignoring null", () => {
    const out = computeZRange([
      { x: "a", y: 1, z: 5 },
      { x: "b", y: 2, z: null },
      { x: "c", y: 3, z: 2 },
      { x: "d", y: 4, z: 9 },
    ]);
    expect(out).toEqual({ min: 2, max: 9 });
  });

  it("returns min==max when only one finite z is present (single-bar charts)", () => {
    expect(
      computeZRange([
        { x: "a", y: 1, z: 7 },
        { x: "b", y: 2, z: null },
      ]),
    ).toEqual({ min: 7, max: 7 });
  });
});
