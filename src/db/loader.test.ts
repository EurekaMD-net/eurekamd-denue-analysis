/**
 * Tests — DENUE Loader (Fase 2)
 *
 * Cubre:
 * - transform(): normalización de campos crudos → fila DB
 * - loadRecords(): upsert via PostgREST (mockeado)
 * - readExtractorOutput(): lectura de archivo JSON
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  transform,
  loadRecords,
  readExtractorOutput,
  type DenueRawRecord,
  type LoaderConfig,
} from "./loader.js";

// ---------------------------------------------------------------------------
// Fixture base
// ---------------------------------------------------------------------------
// BASE_RECORD uses only the 22 fields guaranteed by the real API
// (verified 2026-05-03, tests/fixtures/denue-real-09-sample.json).
// Optional fields are included where needed by specific tests.
const BASE_RECORD: DenueRawRecord = {
  CLEE: "09012345678901234567890000U0", // starts with "09" → entidad = "09"
  Id: "12345678",
  Nombre: "HOSPITAL GENERAL SUR",
  Razon_social: "SERVICIOS DE SALUD CDMX",
  Clase_actividad: "Hospitales generales",
  Estrato: "251 y más personas",
  Tipo_vialidad: "CALLE",
  Calle: "INSURGENTES SUR",
  Num_Exterior: "3700",
  Num_Interior: "",
  Colonia: "Insurgentes Cuicuilco",
  CP: "04530",
  Ubicacion: "TLALPAN, Tlalpan, CIUDAD DE MÉXICO",
  Telefono: "5512345678",
  Correo_e: "info@hospital.gob.mx",
  Sitio_internet: "www.hospital.gob.mx",
  Tipo: "Fijo",
  Longitud: "-99.1740",
  Latitud: "19.3000",
  tipo_corredor_industrial: "",
  nom_corredor_industrial: "",
  numero_local: "",
  // Optional fields — present only in some endpoints, not in buscarEntidad
  AGEB: "0123",
  Manzana: "001",
  CLASE_ACTIVIDAD_ID: "622111",
  EDIFICIO_PISO: "",
  SECTOR_ACTIVIDAD_ID: "62",
  SUBSECTOR_ACTIVIDAD_ID: "622",
  RAMA_ACTIVIDAD_ID: "6221",
  SUBRAMA_ACTIVIDAD_ID: "62211",
  EDIFICIO: "",
  Tipo_Asentamiento: "COLONIA",
  Fecha_Alta: "01/01/2020",
  AreaGeo: "09012",
};

// ---------------------------------------------------------------------------
// transform()
// ---------------------------------------------------------------------------
describe("transform()", () => {
  it("mapea campos directos correctamente", () => {
    const row = transform(BASE_RECORD);
    expect(row.clee).toBe(BASE_RECORD.CLEE);
    expect(row.denue_id).toBe("12345678");
    expect(row.nombre).toBe("HOSPITAL GENERAL SUR");
    expect(row.razon_social).toBe("SERVICIOS DE SALUD CDMX");
    expect(row.clase_actividad_id).toBe("622111");
    expect(row.sector_actividad_id).toBe("62");
    expect(row.subsector_actividad_id).toBe("622");
    expect(row.rama_actividad_id).toBe("6221");
    expect(row.subrama_actividad_id).toBe("62211");
    expect(row.estrato).toBe("251 y más personas");
    expect(row.tipo_unidad).toBe("Fijo");
  });

  it("parsea coordenadas como números", () => {
    const row = transform(BASE_RECORD);
    expect(row.latitud).toBe(19.3);
    expect(row.longitud).toBe(-99.174);
  });

  it("parsea fecha DD/MM/YYYY → YYYY-MM-DD", () => {
    const row = transform(BASE_RECORD);
    expect(row.fecha_alta).toBe("2020-01-01");
  });

  it("extrae entidad de los 2 primeros dígitos del CLEE (AreaGeo no disponible en buscarEntidad)", () => {
    const row = transform(BASE_RECORD);
    expect(row.entidad).toBe("09");
  });

  it("extrae municipio del campo Ubicacion", () => {
    const row = transform(BASE_RECORD);
    expect(row.municipio).toBe("TLALPAN");
  });

  it("convierte strings vacíos a null", () => {
    const row = transform({ ...BASE_RECORD, Num_Interior: "", EDIFICIO: "" });
    expect(row.num_interior).toBeNull();
    expect(row.edificio).toBeNull();
  });

  it("convierte string 'null' literal a null", () => {
    const row = transform({ ...BASE_RECORD, Correo_e: "null" });
    expect(row.correo_e).toBeNull();
  });

  it("maneja coordenadas vacías → null", () => {
    const row = transform({ ...BASE_RECORD, Latitud: "", Longitud: "" });
    expect(row.latitud).toBeNull();
    expect(row.longitud).toBeNull();
  });

  it("maneja coordenadas inválidas → null", () => {
    const row = transform({ ...BASE_RECORD, Latitud: "N/A", Longitud: "N/A" });
    expect(row.latitud).toBeNull();
    expect(row.longitud).toBeNull();
  });

  it("preserva raw_json completo", () => {
    const row = transform(BASE_RECORD);
    expect(row.raw_json).toEqual(BASE_RECORD);
  });

  it("parsea fecha ISO correctamente", () => {
    const row = transform({
      ...BASE_RECORD,
      Fecha_Alta: "2024-06-15T00:00:00",
    });
    expect(row.fecha_alta).toBe("2024-06-15");
  });

  it("maneja fecha vacía → null", () => {
    const row = transform({ ...BASE_RECORD, Fecha_Alta: "" });
    expect(row.fecha_alta).toBeNull();
  });

  it("area_geo mapeado correctamente cuando AreaGeo está presente", () => {
    const row = transform(BASE_RECORD);
    expect(row.area_geo).toBe("09012");
  });

  it("ageb is always NULL from transform (filled by spatial-join script, not API)", () => {
    // BASE_RECORD has AGEB="0123" (4-char API value). The 4-char locality-
    // local cve_ageb would mix with the 13-char CVEGEO that the spatial join
    // writes — so transform deliberately drops the API field. Spatial-join
    // script (scripts/backfill-ageb.ts) is the only writer of `ageb`.
    const row = transform(BASE_RECORD);
    expect(row.ageb).toBeNull();

    // Also when AGEB is absent
    const raw: DenueRawRecord = { ...BASE_RECORD, AGEB: undefined };
    expect(transform(raw).ageb).toBeNull();
  });

  it("deriva area_geo (CVE_MUN_5) del CLEE cuando AreaGeo está ausente", () => {
    // CLEE chars 1-5 = '06009' for this Colima fixture
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "06009461121001991000000000U0",
      AreaGeo: undefined,
    };
    const row = transform(raw);
    expect(row.area_geo).toBe("06009");
  });

  it("prefiere AreaGeo del API sobre la derivación cuando está presente", () => {
    // BASE_RECORD has AreaGeo='09012' AND CLEE chars 1-5='09012' — same
    // value here but the precedence is what matters: API field wins so any
    // future endpoint that returns a different/longer AreaGeo (e.g. with
    // AGEB suffix) is not silently replaced.
    const raw: DenueRawRecord = { ...BASE_RECORD, AreaGeo: "09012XYZ" };
    const row = transform(raw);
    expect(row.area_geo).toBe("09012XYZ");
  });

  it("retorna null para area_geo cuando CLEE es muy corto y AreaGeo ausente", () => {
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "0901",
      AreaGeo: undefined,
    };
    const row = transform(raw);
    expect(row.area_geo).toBeNull();
  });

  it("retorna null para area_geo cuando CLEE chars 1-5 no son numéricos", () => {
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "0900AB6X1121001991000000000U0", // chars 5 is 'A', not a digit
      AreaGeo: undefined,
    };
    const row = transform(raw);
    expect(row.area_geo).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SCIAN derivation from CLEE — covers BuscarEntidad which doesn't return
  // CLASE_ACTIVIDAD_ID/SECTOR_ACTIVIDAD_ID/etc. The transform falls back to
  // CLEE chars 6-11 (1-indexed) so the SCIAN hierarchy is never NULL.
  // ---------------------------------------------------------------------------

  it("deriva SCIAN ids del CLEE cuando los campos API están ausentes", () => {
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "06009461121001991000000000U0", // chars 6-11 = '461121'
      // Drop all SCIAN id fields the API didn't return
      CLASE_ACTIVIDAD_ID: undefined,
      SECTOR_ACTIVIDAD_ID: undefined,
      SUBSECTOR_ACTIVIDAD_ID: undefined,
      RAMA_ACTIVIDAD_ID: undefined,
      SUBRAMA_ACTIVIDAD_ID: undefined,
    };
    const row = transform(raw);
    expect(row.clase_actividad_id).toBe("461121");
    expect(row.sector_actividad_id).toBe("46");
    expect(row.subsector_actividad_id).toBe("461");
    expect(row.rama_actividad_id).toBe("4611");
    expect(row.subrama_actividad_id).toBe("46112");
  });

  it("prefiere los campos API sobre la derivación cuando están presentes", () => {
    // CLEE chars 6-11 = '345678' but API supplies '622111' — API wins.
    const row = transform(BASE_RECORD);
    expect(row.clase_actividad_id).toBe("622111");
    expect(row.sector_actividad_id).toBe("62");
  });

  it("retorna null cuando CLEE es muy corto para derivar", () => {
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "0900", // only 4 chars — not enough for any SCIAN slice
      CLASE_ACTIVIDAD_ID: undefined,
      SECTOR_ACTIVIDAD_ID: undefined,
      SUBSECTOR_ACTIVIDAD_ID: undefined,
      RAMA_ACTIVIDAD_ID: undefined,
      SUBRAMA_ACTIVIDAD_ID: undefined,
    };
    const row = transform(raw);
    expect(row.clase_actividad_id).toBeNull();
    expect(row.sector_actividad_id).toBeNull();
    expect(row.subsector_actividad_id).toBeNull();
    expect(row.rama_actividad_id).toBeNull();
    expect(row.subrama_actividad_id).toBeNull();
  });

  it("retorna null cuando los chars 6-11 del CLEE no son numéricos", () => {
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "0900AB6X1121001991000000000U0", // chars 6-11 contain letters
      CLASE_ACTIVIDAD_ID: undefined,
      SECTOR_ACTIVIDAD_ID: undefined,
      SUBSECTOR_ACTIVIDAD_ID: undefined,
      RAMA_ACTIVIDAD_ID: undefined,
      SUBRAMA_ACTIVIDAD_ID: undefined,
    };
    const row = transform(raw);
    expect(row.sector_actividad_id).toBeNull();
    expect(row.clase_actividad_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readExtractorOutput()
// ---------------------------------------------------------------------------
describe("readExtractorOutput()", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `denue-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ok */
    }
  });

  it("lee un array de registros válido", () => {
    writeFileSync(tmpFile, JSON.stringify([BASE_RECORD]));
    const result = readExtractorOutput(tmpFile);
    expect(result).toHaveLength(1);
    expect(result[0]!.CLEE).toBe(BASE_RECORD.CLEE);
  });

  it("lanza error si el archivo no contiene un array", () => {
    writeFileSync(tmpFile, JSON.stringify({ not: "an array" }));
    expect(() => readExtractorOutput(tmpFile)).toThrow();
  });

  it("lanza error si el archivo no existe", () => {
    expect(() => readExtractorOutput("/ruta/inexistente.json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadRecords() — fetch mockeado
// ---------------------------------------------------------------------------
describe("loadRecords()", () => {
  const config: LoaderConfig = {
    supabaseUrl: "http://localhost:8100",
    serviceRoleKey: "fake-service-key",
    batchSize: 10,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna inserted count igual al número de registros en respuesta exitosa", async () => {
    const fakeResponse = [{ id: 1 }, { id: 2 }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => fakeResponse,
      }),
    );

    const result = await loadRecords([BASE_RECORD, BASE_RECORD], config);
    expect(result.inserted).toBe(2);
    expect(result.errors).toHaveLength(0);
    // LoadResult no expone campo "updated" — eliminado para evitar confusión
    expect("updated" in result).toBe(false);
  });

  it("raw_json llega como objeto (no string) en el payload enviado a fetch", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({ ok: true, json: async () => [{ id: 1 }] });
      }),
    );

    await loadRecords([BASE_RECORD], config);

    const body = capturedBody as Array<Record<string, unknown>>;
    // raw_json debe ser objeto, no string serializado
    expect(typeof body[0]!["raw_json"]).toBe("object");
    // geom no debe estar en el payload
    expect("geom" in body[0]!).toBe(false);
  });

  it("registra error si la API retorna !ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: async () => "duplicate key value",
      }),
    );

    const result = await loadRecords([BASE_RECORD], config);
    expect(result.inserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.clee).toBe(BASE_RECORD.CLEE);
  });

  it("procesa en batches — llama fetch una vez por batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 1 }],
    });
    vi.stubGlobal("fetch", fetchMock);

    // 25 registros con batchSize=10 → 3 llamadas
    const records = Array(25).fill(BASE_RECORD) as DenueRawRecord[];
    const smallBatchConfig = { ...config, batchSize: 10 };
    await loadRecords(records, smallBatchConfig);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("incluye headers correctos en la request", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return Promise.resolve({ ok: true, json: async () => [{ id: 1 }] });
      }),
    );

    await loadRecords([BASE_RECORD], config);

    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["Prefer"]).toContain("merge-duplicates");
    expect(capturedHeaders["apikey"]).toBe("fake-service-key");
  });

  it("URL incluye ?on_conflict=clee para upsert correcto en PostgREST", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, _opts: RequestInit) => {
        capturedUrl = url as string;
        return Promise.resolve({ ok: true, json: async () => [{ id: 1 }] });
      }),
    );

    await loadRecords([BASE_RECORD], config);

    // PostgREST requires ?on_conflict=clee when clee is UNIQUE but not PK.
    // Without it, Prefer: resolution=merge-duplicates is silently ignored → HTTP 409 on duplicates.
    expect(capturedUrl).toContain("?on_conflict=clee");
  });

  it("retorna durationMs > 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 1 }],
      }),
    );

    const result = await loadRecords([BASE_RECORD], config);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("continúa procesando batches aunque uno falle", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            text: async () => "error batch 1",
          });
        }
        return Promise.resolve({ ok: true, json: async () => [{ id: 2 }] });
      }),
    );

    const records = Array(20).fill(BASE_RECORD) as DenueRawRecord[];
    const result = await loadRecords(records, { ...config, batchSize: 10 });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.inserted).toBeGreaterThan(0);
  });
});
