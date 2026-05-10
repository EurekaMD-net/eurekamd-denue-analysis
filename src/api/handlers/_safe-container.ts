/**
 * Centralized docker container-name guard for shell-out handlers.
 *
 * Audit W1-sec round-1 closure 2026-05-10: shell-out handlers spawn
 * `docker exec <container> ...` via execFileSync. Even though all sites
 * use array-arg form (no shell layer → metacharacters can't escape),
 * the container name is interpolated as a positional arg to docker.
 * `analytics.ts` already had a `SAFE_CONTAINER_RE` regex check; the
 * other 4 shell-out handlers (sectors / summary-sector / search /
 * tiles) skipped it. Centralizing here so the regex pattern + the
 * error message stay consistent across handlers.
 *
 * `dbContainer` is set from env (`SUPABASE_DB_CONTAINER` defaulting to
 * "supabase-db") so today there's no live exploit path. Defense-in-depth:
 * if a future change ships an operator-controllable container source,
 * the regex catches "--rm", "; rm -rf /", and any other injection shape
 * before docker even sees the value.
 */

const SAFE_CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

export function assertSafeContainer(container: string): void {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name "${container}"`);
  }
}
