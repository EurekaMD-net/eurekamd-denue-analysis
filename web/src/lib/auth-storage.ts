// supabase-js v2 stores its session under a key matching `sb-<ref>-auth-token`.
// We match the family so we don't have to hardcode the project ref (it
// changes per Supabase instance for sell-time deployments). Exported so
// tests can pin the exact pattern (Phase 2 audit R5).
export const SUPABASE_TOKEN_KEY_RE = /^sb-.+-auth-token$/;

// PKCE verifier auth-js keeps next to the session (`<storageKey>-code-verifier`).
const SUPABASE_CODE_VERIFIER_KEY_RE = /^sb-.+-auth-token-code-verifier$/;

/**
 * Remove the stored Supabase session (and its PKCE verifier) from
 * localStorage without going through auth-js. Used when
 * supabase.auth.signOut() returns {error}: auth-js 2.105.4 then skips
 * _removeSession() even for scope 'local' (it still POSTs /logout), so the
 * refresh token would survive and a reload would sign the user back in.
 * Audit #192. Best-effort, never throws.
 */
export function removeStoredSupabaseSession(): void {
  let storage: Storage;
  try {
    if (typeof window === "undefined") return;
    storage = window.localStorage;
  } catch {
    return;
  }
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (
        k &&
        (SUPABASE_TOKEN_KEY_RE.test(k) || SUPABASE_CODE_VERIFIER_KEY_RE.test(k))
      ) {
        keys.push(k);
      }
    }
  } catch {
    // Storage access denied — nothing we can remove.
  }
  for (const k of keys) {
    try {
      storage.removeItem(k);
    } catch {
      // Best-effort; keep removing the rest.
    }
  }
}
