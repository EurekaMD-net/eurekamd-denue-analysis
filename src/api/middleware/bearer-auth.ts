/**
 * Supabase JWT bearer-token verification.
 *
 * Verifies HS256 JWTs minted by the self-hosted Supabase auth service
 * (GoTrue) against the shared SUPABASE_JWT_SECRET. No round-trip to
 * /auth/v1/user needed — signature + exp + claim checks are sufficient
 * to authenticate every request.
 *
 * Threat model:
 *   The signing secret is in the operator's exclusive control; an
 *   attacker cannot mint signature-valid tokens. The strict-claim
 *   defenses below (missing-aud / missing-role / non-numeric-exp) are
 *   defense in depth — they refuse tokens that LOOK forged even when
 *   the signature happens to validate (impossible without the secret
 *   but possible if a future issuer omits/typo-types a claim).
 *
 * Uses Node's built-in Web Crypto API (no external JWT library).
 *
 * Caller path:
 *   1. Frontend signs in via supabase.auth.signInWithPassword() → JWT
 *   2. Frontend sends `Authorization: Bearer <jwt>` on every API call
 *   3. This middleware verifies, attaches `c.set("user", {...})`
 *   4. Coexists with X-Api-Key middleware — see auth.ts
 *
 * Cache: verified JWTs are cached in-memory keyed by a SHA-256 hash of
 * the token for SUPABASE_JWT_CACHE_TTL_MS (default 5 min). A new
 * request with the same token skips signature verification when the
 * cache hit lands within TTL. Eviction is LRU-tail when the cache is
 * full and no expired entries exist (Map preserves insertion order).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
        | "WRONG_ROLE"
        | "WRONG_ALG";
    };

// Bearer header — accept only base64url characters (no `+` `/` `=`).
// Audit A W3: tightening from the looser pattern that allowed base64
// standard alphabet. JWTs are always base64url-encoded per RFC 7519.
// Case-insensitive `Bearer` to match the wrapper regex in auth.ts.
// Audit B W1: matched casing avoids producing confusing 401s for
// non-canonical-case headers (some manual curl users send lowercase).
const TOKEN_RE = /^Bearer\s+([A-Za-z0-9._-]+)$/i;

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
  // SHA-256 of the token, truncated to 128 bits. Plain hash (not HMAC)
  // because there is no secret defended by this lookup — it's just a
  // collision-resistant index. 128 bits of digest is sufficient under
  // CACHE_MAX_SIZE. (Audit A W4 fix.)
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function pruneCache(now: number): void {
  if (verifyCache.size < CACHE_MAX_SIZE) return;
  // Pass 1: evict everything natural-expired or TTL-expired.
  let evicted = 0;
  for (const [k, v] of verifyCache.entries()) {
    if (v.exp_ms <= now || v.expires_at_ms <= now) {
      verifyCache.delete(k);
      evicted++;
    }
  }
  // Pass 2 (audit A W1): if nothing was evicted, the cache is hot —
  // drop the oldest entries until we have headroom. Map preserves
  // insertion order; `.keys().next()` is the oldest.
  if (evicted === 0) {
    const toEvict = Math.max(1, Math.floor(CACHE_MAX_SIZE * 0.1));
    let i = 0;
    for (const k of verifyCache.keys()) {
      if (i++ >= toEvict) break;
      verifyCache.delete(k);
    }
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
  // Trim leading/trailing whitespace some proxies inject (audit B W3
  // partial defense).
  const trimmed = header.trim();
  const match = TOKEN_RE.exec(trimmed);
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
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return { ok: false, reason: "MALFORMED" };
  }

  // Verify JWT header asserts alg=HS256 BEFORE doing any HMAC work.
  // Audit A W2 (algorithm-confusion defense). Block `alg=none` and any
  // non-HS algorithm. This codepath never speaks RS/ES, but documenting
  // the constraint and enforcing it stops a future contributor from
  // adding RS256 support without revisiting the verifier.
  let jwtHeader: { alg?: string; typ?: string };
  try {
    jwtHeader = JSON.parse(base64UrlDecode(headerB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (jwtHeader.alg !== "HS256") {
    return { ok: false, reason: "WRONG_ALG" };
  }

  // Verify signature (constant-time HMAC-SHA256 compare).
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
  let claims: Partial<SupabaseJwtClaims> & Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  // Strict claim validation (audit A C1 + C2).
  //
  // `exp` MUST be a finite number — string/object/array/missing all
  // mean "treat as expired" because JS coerces them to NaN, and
  // `NaN <= now` is false (open).
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "EXPIRED" };
  }
  const exp_ms = claims.exp * 1000;
  if (exp_ms <= now) return { ok: false, reason: "EXPIRED" };

  // `aud` MUST equal expected (don't short-circuit on missing claim —
  // missing IS a fail under our threat model).
  const expectedAud = config.expectedAud ?? "authenticated";
  if (typeof claims.aud !== "string" || claims.aud !== expectedAud) {
    return { ok: false, reason: "WRONG_AUD" };
  }

  // `role` MUST be a known string. Missing = fail.
  const expectedRoles = config.expectedRoles ?? ["authenticated"];
  if (typeof claims.role !== "string" || !expectedRoles.includes(claims.role)) {
    return { ok: false, reason: "WRONG_ROLE" };
  }

  // `sub` MUST be a non-empty string (audit A R3). Object/array would
  // serialize to "[object Object]" downstream and confuse identity.
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, reason: "MALFORMED" };
  }

  const user: AuthedUser = {
    user_id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
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

// Test helper. NOT for production use — namespaced with double-underscore
// prefix so accidental imports stand out in PR review. Audit A R4.
export function __testOnly_clearJwtCache(): void {
  verifyCache.clear();
}

// Back-compat alias for the existing test files. New code should use the
// underscored name above.
export { __testOnly_clearJwtCache as _clearJwtCache };
