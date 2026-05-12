import { describe, expect, it } from "vitest";
import { applyFilterPins, computeZRange, extractRows } from "./LocustMode";
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

  it("reads /municipios payload for muni-grain X", () => {
    const payload = {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 614447,
          establecimientos: 14000,
          pobreza_pct: 18.5,
        },
        {
          cve_mun: "09005",
          municipio: "Gustavo A. Madero",
          poblacion: 1173351,
          establecimientos: 26500,
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
