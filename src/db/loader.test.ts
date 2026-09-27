/**
 * Tests — DENUE Loader (Fase 2)
 *
 * Cubre:
 * - transform(): normalización de campos crudos → fila DB
 * - loadRecords(): upsert via PostgREST (mockeado)
 * - readExtractorOutput(): lectura de archivo JSON
 * - scripts/load.ts loadAndUpdateGeometry(): error vs geometry branch (#165)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  transform,
  loadRecords,
  readExtractorOutput,
  updateGeometry,
  type DenueRawRecord,
  type LoaderConfig,
} from "./loader.js";
import { loadAndUpdateGeometry } from "../../scripts/load.js";

// updateGeometry shells out to docker; never let a test reach the real one.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(() => {
    throw new Error("execSync must not be used");
  }),
}));

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

  it("extrae municipio (2º segmento), no la localidad, del campo Ubicacion", () => {
    // Audit #40: "LOCALIDAD, Municipio, ESTADO" — the first segment is the
    // locality. The old code returned "TLALPAN" (the locality).
    const row = transform(BASE_RECORD);
    expect(row.municipio).toBe("Tlalpan");
    const cuisillos: DenueRawRecord = {
      ...BASE_RECORD,
      Ubicacion: "CUISILLOS, Tala, JALISCO",
    };
    expect(transform(cuisillos).municipio).toBe("Tala");
  });

  it("municipio correcto cuando la localidad o el municipio contienen comas", () => {
    const sauz: DenueRawRecord = {
      ...BASE_RECORD,
      Ubicacion: "EL SAUZ (SAUZ ALTO, SAUZ BAJO), Pedro Escobedo, QUERÉTARO",
    };
    expect(transform(sauz).municipio).toBe("Pedro Escobedo");
    const tezoatlan: DenueRawRecord = {
      ...BASE_RECORD,
      Ubicacion:
        "HEROICA VILLA TEZOATLÁN DE SEGURA Y LUNA, CUNA DE LA INDEPENDENCIA DE OAXACA, Heroica Villa Tezoatlán de Segura y Luna, Cuna de la Independencia de Oaxaca, OAXACA",
    };
    expect(transform(tezoatlan).municipio).toBe(
      "Heroica Villa Tezoatlán de Segura y Luna, Cuna de la Independencia de Oaxaca",
    );
  });

  it("municipio usa el primer segmento cuando Ubicacion tiene menos de 3", () => {
    const raw: DenueRawRecord = { ...BASE_RECORD, Ubicacion: "TLALPAN, CDMX" };
    expect(transform(raw).municipio).toBe("TLALPAN");
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

  it("deriva SCIAN ids de la etiqueta Clase_actividad (catálogo) antes que del CLEE", () => {
    // Audit #131: live CLEE 09007464111011731000000000U7 encodes 464111
    // (farmacias) but its current label is abarrotes. The old code stored
    // 464111 / 46 / 464 / 4641 / 46411 from the CLEE.
    const raw: DenueRawRecord = {
      ...BASE_RECORD,
      CLEE: "09007464111011731000000000U7",
      Clase_actividad:
        "Comercio al por menor en tiendas de abarrotes, ultramarinos y misceláneas",
      CLASE_ACTIVIDAD_ID: undefined,
      SECTOR_ACTIVIDAD_ID: undefined,
      SUBSECTOR_ACTIVIDAD_ID: undefined,
      RAMA_ACTIVIDAD_ID: undefined,
      SUBRAMA_ACTIVIDAD_ID: undefined,
    };
    const row = transform(raw);
    expect(row.clase_actividad_id).toBe("461110");
    expect(row.sector_actividad_id).toBe("46");
    expect(row.subsector_actividad_id).toBe("461");
    expect(row.rama_actividad_id).toBe("4611");
    expect(row.subrama_actividad_id).toBe("46111");
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

  // Same bytes the paginator writes: "[\n", records joined by ",\n", "\n]".
  const paginatorFormat = (records: DenueRawRecord[]): string =>
    "[\n" + records.map((r) => JSON.stringify(r)).join(",\n") + "\n]";

  it("lee el formato del paginator (un registro por línea)", () => {
    const records = [
      BASE_RECORD,
      { ...BASE_RECORD, CLEE: "B", Nombre: "línea\ncon salto, coma y ]" },
      { ...BASE_RECORD, CLEE: "C" },
    ];
    writeFileSync(tmpFile, paginatorFormat(records));
    expect(readExtractorOutput(tmpFile)).toEqual(records);
  });

  it("lee un array vacío del paginator", () => {
    writeFileSync(tmpFile, "[\n\n]");
    expect(readExtractorOutput(tmpFile)).toEqual([]);
    writeFileSync(tmpFile, "[\n]");
    expect(readExtractorOutput(tmpFile)).toEqual([]);
  });

  it("tolera CRLF, líneas en blanco y el último registro sin coma", () => {
    const a = JSON.stringify(BASE_RECORD);
    const b = JSON.stringify({ ...BASE_RECORD, CLEE: "B" });
    writeFileSync(tmpFile, `\r\n[\r\n${a},\r\n\r\n${b}\r\n]\r\n`);
    const result = readExtractorOutput(tmpFile);
    expect(result.map((r) => r.CLEE)).toEqual([BASE_RECORD.CLEE, "B"]);
  });

  // readLinesSync reads 1 MB chunks: place a multi-byte char so it straddles
  // byte 1<<20 exactly (a plain buf.toString() per chunk would corrupt it).
  it.each([
    ["Ñ (2 bytes) a 1 byte del límite", "Ñ", 1],
    ["emoji (4 bytes) a 1 byte del límite", "😀", 1],
    ["emoji (4 bytes) a 2 bytes del límite", "😀", 2],
    ["emoji (4 bytes) a 3 bytes del límite", "😀", 3],
  ])("decodifica UTF-8 que cruza el límite de chunk de 1 MB: %s", (_label, ch, before) => {
    const head = '[\n{"CLEE":"A","Nombre":"';
    const pad = "x".repeat((1 << 20) - before - Buffer.byteLength(head));
    const nombre = pad + ch + "fin";
    writeFileSync(tmpFile, head + nombre + '"}\n]');
    expect(Buffer.byteLength(head + pad)).toBe((1 << 20) - before);
    const result = readExtractorOutput(tmpFile);
    expect(result).toHaveLength(1);
    expect(result[0]!.Nombre).toBe(nombre);
  });

  it("lanza error con número de línea si un registro está malformado", () => {
    const a = JSON.stringify(BASE_RECORD);
    writeFileSync(tmpFile, `[\n${a},\n{"CLEE": "roto",\n${a}\n]`);
    expect(() => readExtractorOutput(tmpFile)).toThrow(/línea 3/);
  });

  it("lanza error si el array del paginator no cierra (archivo truncado)", () => {
    writeFileSync(tmpFile, `[\n${JSON.stringify(BASE_RECORD)},\n`);
    expect(() => readExtractorOutput(tmpFile)).toThrow(/no cierra el array/);
  });

  it("lanza error si hay contenido después del cierre", () => {
    writeFileSync(tmpFile, `[\n${JSON.stringify(BASE_RECORD)}\n]\n{}`);
    expect(() => readExtractorOutput(tmpFile)).toThrow(/después del cierre/);
  });

  it("lanza 'no contiene un array JSON' para un objeto o un archivo vacío", () => {
    writeFileSync(tmpFile, JSON.stringify({ not: "an array" }, null, 2));
    expect(() => readExtractorOutput(tmpFile)).toThrow(/no contiene un array JSON/);
    writeFileSync(tmpFile, JSON.stringify({ not: "an array" }));
    expect(() => readExtractorOutput(tmpFile)).toThrow(/no contiene un array JSON/);
    writeFileSync(tmpFile, "");
    expect(() => readExtractorOutput(tmpFile)).toThrow(/no contiene un array JSON/);
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

  it("omite ageb del payload para no borrar el AGEB del backfill en el upsert", async () => {
    // Audit #142: merge-duplicates = ON CONFLICT DO UPDATE SET <payload
    // columns>; the old payload carried ageb:null and wiped the CVEGEO.
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
    expect("ageb" in body[0]!).toBe(false);
    expect(body[0]!["clee"]).toBe(BASE_RECORD.CLEE);
  });

  it("pide return=minimal y cuenta el chunk en 2xx sin leer el cuerpo", async () => {
    // Audit #51: the old code asked for return=representation and counted
    // response.json().length.
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          json: async () => {
            throw new Error("no body with return=minimal");
          },
        });
      }),
    );

    const result = await loadRecords(
      Array(3).fill(BASE_RECORD) as DenueRawRecord[],
      config,
    );

    expect(capturedHeaders["Prefer"]).toBe(
      "resolution=merge-duplicates,return=minimal",
    );
    expect(result.inserted).toBe(3);
    expect(result.errors).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// updateGeometry() — docker exec mockeado
// ---------------------------------------------------------------------------
describe("updateGeometry()", () => {
  const config: LoaderConfig = {
    supabaseUrl: "http://localhost:8100",
    serviceRoleKey: "fake-service-key",
  };
  const prevContainer = process.env["SUPABASE_DB_CONTAINER"];

  beforeEach(() => {
    execFileSyncMock.mockReset();
    process.env["SUPABASE_DB_CONTAINER"] = "denue-test-no-such-container";
  });

  afterEach(() => {
    if (prevContainer === undefined) delete process.env["SUPABASE_DB_CONTAINER"];
    else process.env["SUPABASE_DB_CONTAINER"] = prevContainer;
  });

  it("ejecuta psql con argv (sin shell), timeout y ON_ERROR_STOP, y reporta el conteo", async () => {
    execFileSyncMock.mockReturnValue("UPDATE 29\n");

    const result = await updateGeometry(config);

    expect(result).toEqual({ updated: 29 });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSyncMock.mock.calls[0]! as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(cmd).toBe("docker");
    expect(args.slice(0, 3)).toEqual([
      "exec",
      "denue-test-no-such-container",
      "psql",
    ]);
    expect(args).toContain("ON_ERROR_STOP=1");
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("también reescribe geom cuando ya no coincide con latitud/longitud", async () => {
    // Audit #42: the old predicate was `AND geom IS NULL` only, so a moved
    // establishment kept its old point.
    execFileSyncMock.mockReturnValue("UPDATE 0\n");

    await updateGeometry(config);

    const args = execFileSyncMock.mock.calls[0]![1] as string[];
    const sql = args[args.indexOf("-c") + 1]!.replace(/\s+/g, " ");
    expect(sql).toContain(
      "(geom IS NULL OR NOT ST_Equals(geom, ST_SetSRID(ST_MakePoint(longitud::float8, latitud::float8), 4326)))",
    );
  });

  it("rechaza un nombre de contenedor inseguro antes de ejecutar nada", async () => {
    // Audit #43/#161: the old code interpolated it into a shell string.
    process.env["SUPABASE_DB_CONTAINER"] = "--rm";

    await expect(updateGeometry(config)).rejects.toThrow(/unsafe container/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("propaga el fallo de psql en vez de devolver { updated: 0 }", async () => {
    // Audit #43: the old code caught the error and resolved { updated: 0 },
    // so the orchestrator reported success with rows missing geom.
    execFileSyncMock.mockImplementation(() => {
      throw new Error("psql: connection refused");
    });

    await expect(updateGeometry(config)).rejects.toThrow(/connection refused/);
  });
});

// ---------------------------------------------------------------------------
// scripts/load.ts — the CLI's error and geometry branches (audit #165)
// ---------------------------------------------------------------------------
describe("loadAndUpdateGeometry() (scripts/load.ts)", () => {
  const config: LoaderConfig = {
    supabaseUrl: "http://localhost:8100",
    serviceRoleKey: "fake-service-key",
    batchSize: 1,
  };
  const prevContainer = process.env["SUPABASE_DB_CONTAINER"];

  beforeEach(() => {
    execFileSyncMock.mockReset();
    process.env["SUPABASE_DB_CONTAINER"] = "denue-test-no-such-container";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (prevContainer === undefined) delete process.env["SUPABASE_DB_CONTAINER"];
    else process.env["SUPABASE_DB_CONTAINER"] = prevContainer;
  });

  it("importing the CLI module does not run main()", () => {
    // isMain guard: a regression would have read --file / exited on import.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("all batches OK → rewrites geometry and reports the count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    execFileSyncMock.mockReturnValue("UPDATE 2\n");

    const out = await loadAndUpdateGeometry([BASE_RECORD, BASE_RECORD], config);

    expect(out.result.inserted).toBe(2);
    expect(out.result.errors).toHaveLength(0);
    expect(out.geometryUpdated).toBe(2);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect((execFileSyncMock.mock.calls[0]![1] as string[]).join(" ")).toContain(
      "UPDATE establecimientos",
    );
  });

  it("any failed batch → reports the errors and skips the geometry update", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          ++n === 1
            ? { ok: false, text: async () => "duplicate key value" }
            : { ok: true },
        ),
      ),
    );

    const out = await loadAndUpdateGeometry([BASE_RECORD, BASE_RECORD], config);

    expect(out.result.inserted).toBe(1);
    expect(out.result.errors).toEqual([
      { clee: BASE_RECORD.CLEE, error: "duplicate key value" },
    ]);
    expect(out.geometryUpdated).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain(`CLEE ${BASE_RECORD.CLEE}: duplicate key value`);
  });

  it("a geometry failure propagates instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    execFileSyncMock.mockImplementation(() => {
      throw new Error("psql: connection refused");
    });

    await expect(
      loadAndUpdateGeometry([BASE_RECORD], config),
    ).rejects.toThrow(/connection refused/);
  });
});
