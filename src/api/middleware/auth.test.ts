import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeAuthMiddleware } from "./auth.js";

const TEST_KEY = "test-api-key-12345";

function makeApp() {
  const app = new Hono();
  app.use("*", makeAuthMiddleware(TEST_KEY));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("makeAuthMiddleware", () => {
  it("rejects request with missing X-Api-Key header (401)", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth.missing");
  });

  it("rejects request with wrong X-Api-Key (401)", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { "X-Api-Key": "wrong" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth.invalid");
  });

  it("rejects request with right-prefix-but-shorter key (401)", async () => {
    // timing-safe equality requires equal length
    const app = makeApp();
    const res = await app.request("/", {
      headers: { "X-Api-Key": "test-api-key" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts request with correct X-Api-Key (200)", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { "X-Api-Key": TEST_KEY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("throws at construction time when expectedKey is empty", () => {
    expect(() => makeAuthMiddleware("")).toThrow(/empty/);
    expect(() => makeAuthMiddleware("   ")).toThrow(/empty/);
  });
});
