import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { HttpError, errorHandler } from "./error.js";

function appThrowing(err: unknown) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/", () => {
    throw err;
  });
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("errorHandler", () => {
  // Audit #6 (2026-09-26): 5xx messages carried docker argv, SQL and stderr
  // verbatim to the client.
  it("5xx HttpError returns a generic body and logs the detail server-side", async () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const res = await appThrowing(
      new HttpError(
        "layers-values query failed: Command failed: docker exec supabase-db psql -U postgres -c SELECT secret",
        502,
        "postgres.error",
        { hint: "x" },
      ),
    ).request("/");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Upstream query failed",
      code: "postgres.error",
    });
    const logged = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("SELECT secret");
    expect(logged).toContain('details={"hint":"x"}');
  });

  it("500 HttpError keeps its code with a generic internal message", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const res = await appThrowing(
      new HttpError('dbContainer inválido "x;y"', 500, "config.bad_container"),
    ).request("/");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal server error",
      code: "config.bad_container",
    });
  });

  it("4xx HttpError keeps its message and details", async () => {
    const res = await appThrowing(
      new HttpError("entidad inválida", 400, "validation.entidad", { a: 1 }),
    ).request("/");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "entidad inválida",
      code: "validation.entidad",
      details: { a: 1 },
    });
  });
});
