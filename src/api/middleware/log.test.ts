import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { logMiddleware } from "./log.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

function makeApp(user?: string) {
  const app = new Hono<{ Variables: { user: { user_id: string } } }>();
  app.use("*", logMiddleware);
  app.use("*", async (c, next) => {
    if (user) c.set("user", { user_id: user });
    await next();
  });
  app.get("/x", (c) => c.text("ok"));
  return app;
}

describe("logMiddleware", () => {
  it("appends the JWT sub and the resolved client IP", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const lines = captureLog();
    await makeApp("user-123").request("/x", {
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5" },
    });
    expect(lines.join("")).toMatch(
      /\[api\] GET \/x -> 200 \(\d+ms\) user=user-123 ip=203\.0\.113\.5\n/,
    );
  });

  it("labels the API-key path without logging the key", async () => {
    const lines = captureLog();
    await makeApp().request("/x", { headers: { "x-api-key": "s3cret-key" } });
    const out = lines.join("");
    expect(out).toMatch(/user=apikey ip=/);
    expect(out).not.toContain("s3cret-key");
  });

  it("marks anonymous requests with user=-", async () => {
    const lines = captureLog();
    await makeApp().request("/x");
    expect(lines.join("")).toMatch(/user=- ip=unknown\n/);
  });
});
