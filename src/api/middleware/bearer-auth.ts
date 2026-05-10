/**
 * Supabase JWT bearer-token verification.
 *
 * Verifies HS256 JWTs minted by the self-hosted Supabase auth service
 * (GoTrue) against the shared SUPABASE_JWT_SECRET. No round-trip to
 * /auth/v1/user needed — signature + exp + claim checks are sufficient
 * to authenticate every request.
 *
 * Uses Node's built-in Web Crypto API (no external JWT library).
 *
 * Caller path:
 *   1. Frontend signs in via supabase.auth.signInWithPassword() → JWT
 *   2. Frontend sends `Authorization: Bearer <jwt>` on every API call
 *   3. This middleware verifies, attaches `c.set("user", {...})`
 *   4. Coexists with X-Api-Key middleware — see auth.ts
 *
 * Cache: verified JWTs are cached in-memory keyed by a short token
 * prefix for SUPABASE_JWT_CACHE_TTL_MS (default 5 min). A new request
 * with the same token skips signature verification when the cache hit
 * lands within TTL. Cache evicts on exp boundary.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SupabaseJwtClaims {
  sub: string; // user id
  email?: string;
  role: string; // typically "authenticated"
  aud: string;
  exp: number; // unix seconds
  iat: number;
  iss?: string;
}

export interface AuthedUser {
  user_id: string;
  email: string | null;
  role: string;
  /** Original token; useful for downstream calls back to Supabase. */
  token: string;
}

export type BearerVerifyResult =
  | { ok: true; user: AuthedUser }
  | {
      ok: false;
      reason:
        | "MALFORMED"
        | "BAD_SIGNATURE"
        | "EXPIRED"
        | "WRONG_AUD"
        | "WRONG_ROLE";
    };

const TOKEN_RE = /^Bearer\s+([A-Za-z0-9._\-+/=]+)$/;

function base64UrlDecode(s: string): Buffer {
  // JWT base64url → base64
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface VerifyCacheEntry {
  user: AuthedUser;
  exp_ms: number;
  // Refreshes on every hit; bound the cache by both exp AND TTL so we
  // never serve a token past its natural expiry.
  expires_at_ms: number;
}

const verifyCache = new Map<string, VerifyCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 10_000;

function cacheKey(token: string): string {
  // Hash to avoid keeping raw JWTs in a long-lived map. SHA-256 first
  // 16 bytes (hex) is collision-resistant enough and bounds memory.
  return createHmac("sha256", "sage-jwt-cache")
    .update(token)
    .digest("hex")
    .slice(0, 32);
}

function pruneCache(now: number): void {
  if (verifyCache.size < CACHE_MAX_SIZE) return;
  // Bulk-evict everything expired before adding the new entry.
  for (const [k, v] of verifyCache.entries()) {
    if (v.exp_ms <= now || v.expires_at_ms <= now) verifyCache.delete(k);
  }
}

export interface BearerVerifyConfig {
  jwtSecret: string;
  /** Expected `aud` claim. Supabase default = "authenticated". */
  expectedAud?: string;
  /** Expected role(s). Supabase default = "authenticated". */
  expectedRoles?: string[];
}

export function verifyBearer(
  header: string | null | undefined,
  config: BearerVerifyConfig,
): BearerVerifyResult {
  if (!header) return { ok: false, reason: "MALFORMED" };
  const match = TOKEN_RE.exec(header);
  if (!match) return { ok: false, reason: "MALFORMED" };
  const token = match[1] ?? "";

  const cacheK = cacheKey(token);
  const now = Date.now();
  const cached = verifyCache.get(cacheK);
  if (cached && cached.exp_ms > now && cached.expires_at_ms > now) {
    return { ok: true, user: cached.user };
  }
  pruneCache(now);

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];

  // Verify signature first (constant-time HMAC-SHA256 compare).
  const signedInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", config.jwtSecret)
    .update(signedInput)
    .digest();
  let givenSig: Buffer;
  try {
    givenSig = base64UrlDecode(signatureB64);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (givenSig.length !== expectedSig.length) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  if (!timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  // Parse claims.
  let claims: SupabaseJwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  // exp is unix seconds; convert to ms.
  const exp_ms = (claims.exp ?? 0) * 1000;
  if (exp_ms <= now) return { ok: false, reason: "EXPIRED" };
  const expectedAud = config.expectedAud ?? "authenticated";
  if (claims.aud && claims.aud !== expectedAud) {
    return { ok: false, reason: "WRONG_AUD" };
  }
  const expectedRoles = config.expectedRoles ?? ["authenticated"];
  if (claims.role && !expectedRoles.includes(claims.role)) {
    return { ok: false, reason: "WRONG_ROLE" };
  }

  const user: AuthedUser = {
    user_id: claims.sub,
    email: claims.email ?? null,
    role: claims.role,
    token,
  };

  verifyCache.set(cacheK, {
    user,
    exp_ms,
    expires_at_ms: now + CACHE_TTL_MS,
  });

  return { ok: true, user };
}

// Test helper.
export function _clearJwtCache(): void {
  verifyCache.clear();
}
