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

/**
 * The handler fires 32 parallel PostgREST requests (one per entidad). Each
 * returns a Content-Range header like "0-0/N". Our mock generates a varying
 * count so we can verify aggregation + sort.
 */
function mockEntidadCounts(perEntidadCount: number): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn().mockImplementation(() => {
    calls++;
    return Promise.resolve({
      ok: true,
      headers: new Headers({
        "content-range": `0-0/${perEntidadCount * calls}`, // ascending by call index
      }),
      json: async () => [],
    });
  });
}

describe("GET /summary/sector/:scian", () => {
  it("returns 200 + national total + top 10 entidades", async () => {
    vi.stubGlobal("fetch", mockEntidadCounts(100));
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/46", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scian: string;
      total_national: number;
      top_entidades: Array<{ entidad: string; count: number }>;
    };
    expect(body.scian).toBe("46");
    // sum of 100*1 + 100*2 + ... + 100*32 = 100 * (32*33/2) = 52,800
    expect(body.total_national).toBe(52800);
    expect(body.top_entidades).toHaveLength(10);
    // Top entidad has the largest count
    expect(body.top_entidades[0]!.count).toBeGreaterThan(
      body.top_entidades[9]!.count,
    );
  });

  it("returns 400 on invalid SCIAN (not 2 digits)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/4", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.scian");
  });

  it("returns 400 on non-numeric SCIAN", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/AB", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("returns 502 when one of the entidad queries fails", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        n++;
        if (n === 5) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => "boom",
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-range": "0-0/10" }),
          json: async () => [],
        });
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/62", { headers: AUTH });
    expect(res.status).toBe(502);
  });
});
