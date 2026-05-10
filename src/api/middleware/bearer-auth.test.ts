import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyBearer, _clearJwtCache } from "./bearer-auth.js";

const JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(
  payload: Record<string, unknown>,
  secret: string = JWT_SECRET,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

describe("verifyBearer", () => {
  beforeEach(() => _clearJwtCache());

  it("accepts a valid token", () => {
    const tok = makeJwt({
      sub: "user-123",
      email: "a@b.com",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.user_id).toBe("user-123");
      expect(r.user.email).toBe("a@b.com");
      expect(r.user.role).toBe("authenticated");
    }
  });

  it("rejects missing or malformed header", () => {
    expect(verifyBearer(null, { jwtSecret: JWT_SECRET }).ok).toBe(false);
    expect(verifyBearer("", { jwtSecret: JWT_SECRET }).ok).toBe(false);
    expect(verifyBearer("Token xyz", { jwtSecret: JWT_SECRET }).ok).toBe(false);
    const r = verifyBearer("Bearer not.a.jwt", { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MALFORMED|BAD_SIGNATURE/);
  });

  it("rejects bad signature", () => {
    const tok = makeJwt({
      sub: "user-123",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: "different-secret" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("BAD_SIGNATURE");
  });

  it("rejects expired tokens", () => {
    const tok = makeJwt({
      sub: "user-123",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EXPIRED");
  });

  it("rejects wrong aud", () => {
    const tok = makeJwt({
      sub: "user-123",
      role: "authenticated",
      aud: "service_role",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_AUD");
  });

  it("rejects wrong role", () => {
    const tok = makeJwt({
      sub: "user-123",
      role: "anon",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_ROLE");
  });

  it("caches subsequent verifications", () => {
    const tok = makeJwt({
      sub: "user-cache",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r1 = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    const r2 = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.user.user_id).toBe(r1.user.user_id);
    }
  });
});
