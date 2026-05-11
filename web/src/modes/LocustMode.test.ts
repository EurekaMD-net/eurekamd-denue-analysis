import { describe, expect, it } from "vitest";
import { applyFilterPins } from "./LocustMode";

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
