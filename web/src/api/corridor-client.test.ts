import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));

import { useUiStore, INITIAL_CORRIDOR } from "../store";
import { ApiError } from "./client";
import {
  CORRIDOR_FAILED_MESSAGE,
  DEFAULT_RETRY_AFTER_S,
  OSM_FAILED_MESSAGE,
  corridorErrorMessage,
  fetchCorridorDensity,
  fetchStreetGeometry,
  pollStreetGeometry,
  resolveMunicipio,
} from "./corridor-client";
import {
  BUFFER_DEFAULT_M,
  FARMACIAS_PREFIX,
  buildCorridorRequest,
  corridorGeometry,
  type CorridorRequest,
} from "./corridor-types";

const CORRIDOR_200 = {
  length_m: 1052.4,
  buffer_m: 100,
  total: 7,
  per_km: 6.65,
  by_clase: [
    {
      clase_actividad_id: "464111",
      clase_actividad: "Comercio al por menor en farmacias sin minisúper",
      n: 5,
    },
    {
      clase_actividad_id: "464112",
      clase_actividad: "Comercio al por menor en farmacias con minisúper",
      n: 2,
    },
  ],
  buffer_geojson: {
    type: "Polygon",
    coordinates: [
      [
        [-99.17, 19.43],
        [-99.16, 19.43],
        [-99.16, 19.42],
        [-99.17, 19.43],
      ],
    ],
  },
};

const STREET_200 = {
  cve_mun: "09015",
  q: "reforma",
  status: "ok",
  matches: [
    {
      name: "Paseo de la Reforma",
      highway: ["primary", "secondary"],
      length_m: 14250.2,
      segments: 212,
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-99.17, 19.43],
            [-99.16, 19.427],
          ],
        ],
      },
    },
  ],
};

const REQ: CorridorRequest = {
  geometry: {
    type: "LineString",
    coordinates: [
      [-99.1735, 19.4326],
      [-99.165, 19.427],
    ],
  },
  buffer_m: 100,
  clase_prefix: "4641",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  useUiStore.setState({
    session: { access_token: "jwt-abc" } as Session,
    hydrated: true,
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  useUiStore.setState({ session: null, hydrated: false });
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

describe("fetchCorridorDensity", () => {
  it("POSTs the JSON body with the bearer token and parses a 200", async () => {
    fetchMock.mockResolvedValue(json(CORRIDOR_200));
    const r = await fetchCorridorDensity(REQ);
    const { url, init } = lastCall();
    expect(url).toBe("/api/analytics/corridor-density");
    expect(init.method).toBe("POST");
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBe("Bearer jwt-abc");
    expect(h.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(REQ);
    expect(r.total).toBe(7);
    expect(r.by_clase).toHaveLength(2);
    expect(r.buffer_geojson?.type).toBe("Polygon");
  });

  it("accepts per_km null (zero-length guard in the SQL)", async () => {
    fetchMock.mockResolvedValue(json({ ...CORRIDOR_200, per_km: null }));
    expect((await fetchCorridorDensity(REQ)).per_km).toBeNull();
  });

  it("rejects a malformed 200 body instead of rendering it", async () => {
    fetchMock.mockResolvedValue(json({ ...CORRIDOR_200, total: "7" }));
    await expect(fetchCorridorDensity(REQ)).rejects.toThrow();
  });

  it("passes a 400 message through verbatim", async () => {
    const msg = "La geometría mide 62.3 km; el máximo es 50 km.";
    fetchMock.mockResolvedValue(
      json({ error: msg, code: "validation.geometry.length" }, 400),
    );
    const err = await fetchCorridorDensity(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("validation.geometry.length");
    expect(corridorErrorMessage(err)).toBe(msg);
  });

  it("maps a 5xx to the fixed corridor retry text", async () => {
    fetchMock.mockResolvedValue(
      json({ error: "Upstream query failed", code: "db.query_failed" }, 502),
    );
    const err = await fetchCorridorDensity(REQ).catch((e: unknown) => e);
    expect(corridorErrorMessage(err)).toBe(CORRIDOR_FAILED_MESSAGE);
  });
});

describe("fetchStreetGeometry", () => {
  it("builds the querystring and parses a hot-cache 200", async () => {
    fetchMock.mockResolvedValue(json(STREET_200));
    const r = await fetchStreetGeometry("09015", "  reforma ");
    expect(lastCall().url).toBe(
      "/api/analytics/street-geometry?cve_mun=09015&q=reforma",
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.matches[0]?.name).toBe("Paseo de la Reforma");
  });

  it("parses match-level and top-level truncated flags", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...STREET_200,
        truncated: true,
        matches: [{ ...STREET_200.matches[0], truncated: true }],
      }),
    );
    const r = await fetchStreetGeometry("09015", "reforma");
    expect(r.status === "ok" && r.truncated).toBe(true);
    expect(r.status === "ok" && r.matches[0]?.truncated).toBe(true);
  });

  it("encodes accents and spaces in q", async () => {
    fetchMock.mockResolvedValue(json({ ...STREET_200, matches: [] }));
    await fetchStreetGeometry("09014", "av. insurgentes sur ñ");
    expect(lastCall().url).toContain("q=av.%20insurgentes%20sur%20%C3%B1");
  });

  it("returns extracting with retry_after_s on a 202", async () => {
    fetchMock.mockResolvedValue(
      json({ status: "extracting", cve_mun: "09015", retry_after_s: 30 }, 202, {
        "Retry-After": "30",
      }),
    );
    expect(await fetchStreetGeometry("09015", "reforma")).toEqual({
      status: "extracting",
      cve_mun: "09015",
      retry_after_s: 30,
    });
  });

  it("falls back to the Retry-After header, then to the default", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ status: "extracting", cve_mun: "09015" }, 202, { "Retry-After": "12" }),
    );
    const a = await fetchStreetGeometry("09015", "reforma");
    expect(a.status === "extracting" && a.retry_after_s).toBe(12);
    fetchMock.mockResolvedValueOnce(json({ status: "extracting", cve_mun: "09015" }, 202));
    const b = await fetchStreetGeometry("09015", "reforma");
    expect(b.status === "extracting" && b.retry_after_s).toBe(DEFAULT_RETRY_AFTER_S);
  });

  it("clamps an absurd retry_after_s", async () => {
    fetchMock.mockResolvedValue(
      json({ status: "extracting", cve_mun: "09015", retry_after_s: 0 }, 202),
    );
    const r = await fetchStreetGeometry("09015", "reforma");
    expect(r.status === "extracting" && r.retry_after_s).toBe(2);
  });

  it("maps a 502 to the OSM retry text", async () => {
    fetchMock.mockResolvedValue(
      json({ error: "Upstream query failed", code: "osm.extract_failed" }, 502),
    );
    const err = await fetchStreetGeometry("09015", "reforma").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(corridorErrorMessage(err, true)).toBe(OSM_FAILED_MESSAGE);
    expect(OSM_FAILED_MESSAGE).toBe("El servicio OSM falló; reintenta");
  });

  it("passes a 400 (unknown municipio) through verbatim", async () => {
    const msg = 'cve_mun "99999" no existe en mun_polygons';
    fetchMock.mockResolvedValue(json({ error: msg, code: "validation.cve_mun" }, 400));
    const err = await fetchStreetGeometry("99999", "reforma").catch((e: unknown) => e);
    expect(corridorErrorMessage(err, true)).toBe(msg);
  });
});

describe("corridorErrorMessage status mapping", () => {
  it("fixed lines for 401/413/429; verbatim only for 400/404", () => {
    const e = (status: number) => new ApiError("raw server text", status, "x");
    expect(corridorErrorMessage(e(401))).toBe("Sesión expirada; vuelve a iniciar sesión");
    expect(corridorErrorMessage(e(413))).toBe("Solicitud demasiado grande");
    expect(corridorErrorMessage(e(429), true)).toBe("Demasiadas solicitudes; espera un minuto");
    expect(corridorErrorMessage(e(400))).toBe("raw server text");
    expect(corridorErrorMessage(e(404), true)).toBe("raw server text");
    expect(corridorErrorMessage(e(403))).toBe(CORRIDOR_FAILED_MESSAGE);
    expect(corridorErrorMessage(e(503), true)).toBe(OSM_FAILED_MESSAGE);
    expect(corridorErrorMessage(new TypeError("Failed to fetch"))).toBe(
      CORRIDOR_FAILED_MESSAGE,
    );
  });
});

describe("P1 geometry validation codes", () => {
  it("passes segment/extent/vertices messages through verbatim", async () => {
    for (const code of [
      "validation.geometry.segment",
      "validation.geometry.extent",
      "validation.geometry.vertices",
    ]) {
      const msg = `Mensaje de ${code}.`;
      fetchMock.mockResolvedValueOnce(json({ error: msg, code }, 400));
      const err = await fetchCorridorDensity(REQ).catch((e: unknown) => e);
      expect(corridorErrorMessage(err)).toBe(msg);
    }
  });

  it("appends the area hint to validation.geometry.area", async () => {
    const msg = "El área del buffer (41.2 km²) excede el máximo de 7 km².";
    fetchMock.mockResolvedValue(
      json({ error: msg, code: "validation.geometry.area" }, 400),
    );
    const err = await fetchCorridorDensity(REQ).catch((e: unknown) => e);
    expect(corridorErrorMessage(err)).toBe(
      `${msg} — reduce el buffer o acorta el corredor`,
    );
  });

  it("accepts buffer_geojson null (> 500 vertices)", async () => {
    fetchMock.mockResolvedValue(json({ ...CORRIDOR_200, buffer_geojson: null }));
    expect((await fetchCorridorDensity(REQ)).buffer_geojson).toBeNull();
  });
});

describe("street-service codes (P2 backend fixes)", () => {
  const CAPACITY = "Servicio OSM no disponible (capacidad); avisa al operador";
  const cases: Array<[number, string, string]> = [
    [
      409,
      "osm.bbox_too_large",
      "Municipio demasiado extenso para extraer en línea; pide al operador precalentarlo",
    ],
    [429, "osm.queue_full", "Cola de extracción llena; reintenta en un minuto"],
    [
      429,
      "osm.cold_limit",
      "Límite de extracciones de municipios nuevos alcanzado (10 por hora); reintenta más tarde",
    ],
    [503, "osm.cache_budget", CAPACITY],
    [503, "osm.source_missing", CAPACITY],
  ];
  for (const [status, code, text] of cases) {
    it(`${status} ${code} → fixed text`, async () => {
      fetchMock.mockResolvedValue(json({ error: "raw", code }, status));
      const err = await pollStreetGeometry("09015", "reforma", {
        sleep: async () => {},
      }).catch((e: unknown) => e);
      expect((err as ApiError).code).toBe(code);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(corridorErrorMessage(err, true)).toBe(text);
    });
  }

  it("a 429 without an osm code keeps the rate-limiter text", async () => {
    fetchMock.mockResolvedValue(json({ error: "Too many requests", code: "rate_limited" }, 429));
    const err = await fetchStreetGeometry("09015", "reforma").catch((e: unknown) => e);
    expect(corridorErrorMessage(err, true)).toBe("Demasiadas solicitudes; espera un minuto");
    fetchMock.mockResolvedValue(new Response("slow down", { status: 429 }));
    const bare = await fetchStreetGeometry("09015", "reforma").catch((e: unknown) => e);
    expect(corridorErrorMessage(bare, true)).toBe("Demasiadas solicitudes; espera un minuto");
  });

  it("429 osm.busy retries once after Retry-After, transparently", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ error: "busy", code: "osm.busy" }, 429, { "Retry-After": "1" }),
      )
      .mockResolvedValueOnce(json(STREET_200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await pollStreetGeometry("09015", "reforma", { sleep });
    expect(r.matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(1000);
  });

  it("a second osm.busy surfaces as 'Servicio ocupado; reintenta'", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: "busy", code: "osm.busy" }, 429, { "Retry-After": "1" }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = await pollStreetGeometry("09015", "reforma", { sleep }).catch(
      (e: unknown) => e,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(corridorErrorMessage(err, true)).toBe("Servicio ocupado; reintenta");
  });

  it("osm.busy without Retry-After waits the 1 s default; a huge header is capped", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "busy", code: "osm.busy" }, 429))
      .mockResolvedValueOnce(json(STREET_200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollStreetGeometry("09015", "reforma", { sleep });
    expect(sleep.mock.calls[0]?.[0]).toBe(1000);

    fetchMock
      .mockResolvedValueOnce(
        json({ error: "busy", code: "osm.busy" }, 429, { "Retry-After": "3600" }),
      )
      .mockResolvedValueOnce(json(STREET_200));
    sleep.mockClear();
    await pollStreetGeometry("09015", "reforma", { sleep });
    expect(sleep.mock.calls[0]?.[0]).toBe(10_000);
  });

  it("the busy retry still sleeps between 202s afterwards", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "busy", code: "osm.busy" }, 429))
      .mockResolvedValueOnce(
        json({ status: "extracting", cve_mun: "09015", retry_after_s: 30 }, 202),
      )
      .mockResolvedValueOnce(json(STREET_200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await pollStreetGeometry("09015", "reforma", { sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 30_000]);
  });
});

describe("pollStreetGeometry", () => {
  const extracting = () =>
    json({ status: "extracting", cve_mun: "09015", retry_after_s: 30 }, 202);

  it("sleeps retry_after_s between 202s, then returns the 200", async () => {
    fetchMock
      .mockResolvedValueOnce(extracting())
      .mockResolvedValueOnce(extracting())
      .mockResolvedValueOnce(json(STREET_200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onExtracting = vi.fn();
    const r = await pollStreetGeometry("09015", "reforma", { sleep, onExtracting });
    expect(r.matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(30_000);
    expect(onExtracting.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it("gives up after maxPolls 202s with a readable message", async () => {
    fetchMock.mockImplementation(async () => extracting());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = await pollStreetGeometry("09015", "reforma", {
      sleep,
      maxPolls: 3,
    }).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((err as ApiError).code).toBe("osm.poll_exhausted");
    expect(corridorErrorMessage(err, true)).toMatch(/sigue en curso/);
  });

  it("stops polling when aborted during the wait", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => extracting());
      const ctrl = new AbortController();
      const p = pollStreetGeometry("09015", "reforma", { signal: ctrl.signal });
      const settled = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      ctrl.abort();
      const err = await settled;
      expect((err as DOMException).name).toBe("AbortError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a 502 mid-poll", async () => {
    fetchMock
      .mockResolvedValueOnce(extracting())
      .mockResolvedValueOnce(json({ error: "x", code: "osm.extract_failed" }, 502));
    const err = await pollStreetGeometry("09015", "reforma", {
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(corridorErrorMessage(err, true)).toBe(OSM_FAILED_MESSAGE);
  });
});

describe("resolveMunicipio", () => {
  it("formats lat/lon to 6 dp and returns cve_mun", async () => {
    fetchMock.mockResolvedValue(
      json({
        lat: 19.4326,
        lon: -99.1332,
        cvegeo: "0901500010010",
        ambito: "Urbana",
        cve_mun: "09015",
      }),
    );
    expect(await resolveMunicipio(-99.13321234567, 19.4326)).toBe("09015");
    expect(lastCall().url).toBe("/api/resolve/ageb?lat=19.432600&lon=-99.133212");
  });

  it("passes the resolver's 404 through verbatim", async () => {
    const msg = "Ningún AGEB del Marco Geoestadístico contiene el punto (1, 2).";
    fetchMock.mockResolvedValue(json({ error: msg, code: "resolve.no_ageb" }, 404));
    const err = await resolveMunicipio(-99, 19).catch((e: unknown) => e);
    expect(corridorErrorMessage(err, true)).toBe(msg);
  });
});

describe("corridor request builder", () => {
  const base = {
    points: [] as [number, number][],
    streetLines: null,
    bufferM: 100,
    clasePrefix: "4641",
  };

  it("needs 2 drawn vertices", () => {
    expect(buildCorridorRequest({ ...base, points: [[-99.1, 19.4]] })).toBeNull();
    expect(
      buildCorridorRequest({
        ...base,
        points: [
          [-99.1, 19.4],
          [-99.2, 19.5],
        ],
      })?.geometry.type,
    ).toBe("LineString");
  });

  it("prefers a loaded street (MultiLineString)", () => {
    const g = corridorGeometry({
      points: [],
      streetLines: [
        [
          [-99.1, 19.4],
          [-99.2, 19.5],
        ],
      ],
    });
    expect(g?.type).toBe("MultiLineString");
  });

  it("omits an empty prefix, refuses an invalid one, clamps the buffer", () => {
    const pts: [number, number][] = [
      [-99.1, 19.4],
      [-99.2, 19.5],
    ];
    expect(
      buildCorridorRequest({ ...base, points: pts, clasePrefix: "" }),
    ).not.toHaveProperty("clase_prefix");
    expect(buildCorridorRequest({ ...base, points: pts, clasePrefix: "4" })).toBeNull();
    expect(
      buildCorridorRequest({ ...base, points: pts, clasePrefix: "4641234" }),
    ).toBeNull();
    expect(buildCorridorRequest({ ...base, points: pts, bufferM: 5000 })?.buffer_m).toBe(
      1000,
    );
    expect(buildCorridorRequest({ ...base, points: pts, bufferM: 1 })?.buffer_m).toBe(10);
  });

  it("store defaults match the contract constants", () => {
    expect(INITIAL_CORRIDOR.bufferM).toBe(BUFFER_DEFAULT_M);
    expect(INITIAL_CORRIDOR.clasePrefix).toBe(FARMACIAS_PREFIX);
  });
});
