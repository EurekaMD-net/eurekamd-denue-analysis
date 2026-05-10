/**
 * Supabase browser client.
 *
 * URL + anon key are inlined here because both are PUBLIC values —
 * the anon key only grants access to RLS-protected resources and is
 * meant to ship in the bundle. Vite would emit them into the bundle
 * regardless of whether they came from env or a constant. Overridable
 * via VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY at build time for
 * staging / sell-time client deployments pointed at a different
 * Supabase instance.
 *
 * Session storage: defaults to localStorage with the supabase-js v2
 * key `sb-<projectref>-auth-token`. Auto-refresh is on so a logged-in
 * tab survives the JWT exp boundary (~1 hour) without forcing the
 * user to re-enter the password.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Self-hosted Supabase reachable via Caddy at db.mycommit.net.
const DEFAULT_SUPABASE_URL = "https://db.mycommit.net";

// Public anon key — long-lived (year 2031), role=anon. Same key the
// rest of the EurekaMD stack uses. Override via VITE_SUPABASE_ANON_KEY
// only when targeting a different Supabase instance.
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc1MTU4MDIxLCJleHAiOjE5MzI4MzgwMjF9." +
  "cJNNjjW4ZVyNkbYuKMfQHvK5pA5rCOK_bhz4Hy5n8fw";

const SUPABASE_URL =
  (import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ??
  DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  (import.meta.env["VITE_SUPABASE_ANON_KEY"] as string | undefined) ??
  DEFAULT_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
