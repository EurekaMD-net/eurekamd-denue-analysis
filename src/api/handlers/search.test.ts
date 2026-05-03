import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => vi.restoreAllMocks());

describe("GET /search — PostgREST path (no radius)", () => {
  it("returns rows + page metadata on happy path", async () => {
    const fakeRows = [
      { clee: "06001", nombre: "TEST A" },
      { clee: "06002", nombre: "TEST B" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => fakeRows }),
    );

    const app = createServer(CONFIG);
    const res = await app.request("/search?entidad=06&q=test", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[];
      page: number;
      limit: number;
      total_returned: number;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.total_returned).toBe(2);
  });

  it("propagates entidad + q + pagination to PostgREST", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer(CONFIG);
    await app.request("/search?entidad=09&q=hospital&page=3&limit=20", {
      headers: AUTH,
    });

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("entidad=eq.09");
    expect(url).toContain("nombre=ilike.");
    expect(url).toContain("hospital");
    expect(url).toContain("limit=20");
    expect(url).toContain("offset=40"); // (page 3 - 1) * 20
  });

  it("caps limit at MAX_PAGE_SIZE (1000) when client requests more", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer(CONFIG);
    await app.request("/search?limit=99999", { headers: AUTH });

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("limit=1000");
  });

  it("returns 400 on invalid entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?entidad=33", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("returns 400 on invalid from format", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?from=notcoords", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.from");
  });

  it("returns 400 when radius_km supplied without from", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?radius_km=10", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.radius_km_no_from");
  });

  it("returns 400 on radius_km out of range (negative or >500)", async () => {
    const app = createServer(CONFIG);
    const res1 = await app.request("/search?from=19.4,-99.1&radius_km=-5", {
      headers: AUTH,
    });
    expect(res1.status).toBe(400);
    const res2 = await app.request("/search?from=19.4,-99.1&radius_km=999", {
      headers: AUTH,
    });
    expect(res2.status).toBe(400);
  });

  it("returns 400 on page < 1", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?page=0", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.page");
  });

  it("returns 502 when PostgREST errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/search", { headers: AUTH });
    expect(res.status).toBe(502);
  });

  it("returns 400 on page > MAX_PAGE (audit W1)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?page=999999", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.page_too_large");
  });

  it("returns 400 on q longer than MAX_Q_LEN (audit W3)", async () => {
    const app = createServer(CONFIG);
    const longQ = "a".repeat(500);
    const res = await app.request(`/search?q=${longQ}`, { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.q_too_long");
  });

  it("returns 400 on radius_km with trailing garbage (audit W4)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/search?from=19.4,-99.1&radius_km=10abc", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.radius_km");
  });
});
