import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DenueClient, DenueApiError, setGlobalDelay, resetThrottle } from "./denue-client.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_TOKEN = "test-token-1234";

// Shape matches real API response (verified 2026-05-03, tests/fixtures/denue-real-09-sample.json)
const MOCK_ESTABLISHMENT = {
  CLEE: "09016541110003013001000000U0",
  Id: "6319819",
  Nombre: "FARMACIA GUADALAJARA",
  Razon_social: "FARMACIAS GUADALAJARA SA DE CV",
  Clase_actividad: "Farmacias sin minisúper",
  Estrato: "11 a 30 personas",
  Tipo_vialidad: "CALLE",
  Calle: "INSURGENTES SUR",
  Num_Exterior: "100",
  Num_Interior: "",
  Colonia: "HIPÓDROMO",
  CP: "06100",
  Ubicacion: "CUAUHTÉMOC, Cuauhtémoc, CIUDAD DE MÉXICO",
  Telefono: "5555550100",
  Correo_e: "contacto@farmaciasguadalajara.com",
  Sitio_internet: "www.farmaciasguadalajara.com",
  Tipo: "Fijo",
  Longitud: "-99.1701",
  Latitud: "19.4069",
  tipo_corredor_industrial: "",
  nom_corredor_industrial: "",
  numero_local: "SN",
};

const MOCK_COUNT = [{ Total: "42" }];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DenueClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetThrottle();
  });

  describe("constructor", () => {
    it("throws if token is empty", () => {
      expect(() => new DenueClient("")).toThrow(DenueApiError);
    });

    it("throws if token is whitespace", () => {
      expect(() => new DenueClient("   ")).toThrow(DenueApiError);
    });

    it("accepts a valid token", () => {
      expect(() => new DenueClient(MOCK_TOKEN)).not.toThrow();
    });
  });

  describe("buscarEntidad", () => {
    it("returns parsed array of establishments", async () => {
      mockFetch([MOCK_ESTABLISHMENT]);
      const client = new DenueClient(MOCK_TOKEN);

      const result = await client.buscarEntidad("09", 1, 500);

      expect(result).toHaveLength(1);
      expect(result[0].Id).toBe("6319819");
      expect(result[0].Nombre).toBe("FARMACIA GUADALAJARA");
    });

    it("returns empty array when API responds with null", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("null"),
      } as Response);

      const client = new DenueClient(MOCK_TOKEN);
      const result = await client.buscarEntidad("09", 1, 500);

      expect(result).toEqual([]);
    });

    it("returns empty array when API responds with empty string", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      } as Response);

      const client = new DenueClient(MOCK_TOKEN);
      const result = await client.buscarEntidad("09", 1, 500);

      expect(result).toEqual([]);
    });

    it("throws DenueApiError on HTTP error", async () => {
      // Mock 3 failures (max retries)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response);

      const client = new DenueClient(MOCK_TOKEN);
      await expect(client.buscarEntidad("09", 1, 500)).rejects.toBeInstanceOf(DenueApiError);
    });

    it("includes token in the URL", async () => {
      mockFetch([MOCK_ESTABLISHMENT]);
      const client = new DenueClient(MOCK_TOKEN);

      await client.buscarEntidad("09", 1, 10);

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain(MOCK_TOKEN);
      expect(calledUrl).toContain("/09/1/10/");
    });

    it("passes condicion and sector when provided", async () => {
      mockFetch([MOCK_ESTABLISHMENT]);
      const client = new DenueClient(MOCK_TOKEN);

      await client.buscarEntidad("09", 1, 10, "farmacia", "464111");

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain("farmacia");
      expect(calledUrl).toContain("464111");
    });
  });

  describe("cuantificarEntidad", () => {
    it("returns the total count as number", async () => {
      mockFetch(MOCK_COUNT);
      const client = new DenueClient(MOCK_TOKEN);

      const total = await client.cuantificarEntidad("09");

      expect(total).toBe(42);
    });

    it("returns 0 when API returns empty array", async () => {
      mockFetch([]);
      const client = new DenueClient(MOCK_TOKEN);

      const total = await client.cuantificarEntidad("09");

      expect(total).toBe(0);
    });
  });

  describe("ficha", () => {
    it("returns establishment for valid ID", async () => {
      mockFetch([MOCK_ESTABLISHMENT]);
      const client = new DenueClient(MOCK_TOKEN);

      const result = await client.ficha("6319819");

      expect(result).not.toBeNull();
      expect(result?.Id).toBe("6319819");
    });

    it("returns null when API responds with null", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("null"),
      } as Response);

      const client = new DenueClient(MOCK_TOKEN);
      const result = await client.ficha("99999999");

      expect(result).toBeNull();
    });
  });

  describe("global rate throttle", () => {
    afterEach(() => {
      // Reset global throttle state so other tests aren't affected
      resetThrottle();
      setGlobalDelay(0);
      vi.restoreAllMocks();
    });

    it("spaces two parallel buscarEntidad calls by at least delayMs", async () => {
      const delayMs = 50; // small enough for fast tests, large enough to be measurable
      mockFetch([MOCK_ESTABLISHMENT]);

      // Create two clients sharing the same global throttle at delayMs
      const client1 = new DenueClient(MOCK_TOKEN, delayMs);
      const client2 = new DenueClient(MOCK_TOKEN, delayMs);

      const timestamps: number[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((...args: Parameters<typeof fetch>) => {
        timestamps.push(Date.now());
        return origFetch(...args);
      });

      // Fire both in parallel — throttle should serialize them
      await Promise.all([
        client1.buscarEntidad("09", 1, 5),
        client2.buscarEntidad("09", 1, 5),
      ]);

      expect(timestamps).toHaveLength(2);
      const gap = timestamps[1]! - timestamps[0]!;
      // The second call must be at least delayMs after the first
      expect(gap).toBeGreaterThanOrEqual(delayMs - 5); // 5ms tolerance for timer precision
    });
  });
});
