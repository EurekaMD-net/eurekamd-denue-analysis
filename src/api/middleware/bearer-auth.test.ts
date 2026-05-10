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
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
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

  // ---- Audit A C1: strict aud/role enforcement -----------------------
  it("rejects token missing aud claim (R1 audit C1)", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      // aud omitted
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_AUD");
  });

  it("rejects token missing role claim", () => {
    const tok = makeJwt({
      sub: "u",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_ROLE");
  });

  it("rejects token with empty-string aud", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_AUD");
  });

  // ---- Audit A C2: strict exp type ------------------------------------
  it("rejects token with non-numeric exp (string)", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: "9999999999",
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EXPIRED");
  });

  it("rejects token with missing exp", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EXPIRED");
  });

  it("rejects token with exp=NaN-coercible value (object)", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      exp: {},
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EXPIRED");
  });

  // ---- Audit A W2: alg confusion --------------------------------------
  it("rejects alg=none token", () => {
    const tok = makeJwt(
      {
        sub: "u",
        role: "authenticated",
        aud: "authenticated",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      JWT_SECRET,
      { alg: "none", typ: "JWT" },
    );
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_ALG");
  });

  it("rejects alg=RS256 token (algorithm confusion defense)", () => {
    const tok = makeJwt(
      {
        sub: "u",
        role: "authenticated",
        aud: "authenticated",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      JWT_SECRET,
      { alg: "RS256", typ: "JWT" },
    );
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("WRONG_ALG");
  });

  // ---- Audit A R3: strict sub type ------------------------------------
  it("rejects token with non-string sub", () => {
    const tok = makeJwt({
      sub: { id: "abc" },
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`Bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  // ---- Audit A R1: structural malformedness ---------------------------
  it("rejects 2-part token (missing signature)", () => {
    const r = verifyBearer(`Bearer abc.def`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  it("rejects 4-part token", () => {
    const r = verifyBearer(`Bearer a.b.c.d`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  it("rejects empty-segment token", () => {
    const r = verifyBearer(`Bearer a..c`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MALFORMED");
  });

  // ---- Audit A W3: header parsing -------------------------------------
  it("trims leading/trailing whitespace from the header", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`  Bearer ${tok}  `, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(true);
  });

  it("accepts case-insensitive 'bearer' prefix (audit B W1)", () => {
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = verifyBearer(`bearer ${tok}`, { jwtSecret: JWT_SECRET });
    expect(r.ok).toBe(true);
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
