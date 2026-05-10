-- Sage persistence tables: thread state + per-turn audit log.
--
-- sage_threads:        one row per multi-turn conversation; turns are an
--                      append-only JSONB array (digests, not full results).
-- sage_turns_audit:    one row per LLM call (router OR narrative). Captures
--                      prompt, output, usage, latency, model. Op-readable
--                      only — NOT exposed via API. Cost telemetry.
--
-- Run via: docker exec -i supabase-db psql -U postgres -d postgres < scripts/sage-tables.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS sage_threads (
  thread_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Append-only digest of all turns. Schema enforced by app code; this
  -- column is intentionally JSONB to evolve with prompt iteration.
  turns        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Free-form label users can set (defaults null = "untitled").
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_threads_updated
  ON sage_threads (updated_at DESC);

CREATE TABLE IF NOT EXISTS sage_turns_audit (
  turn_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    UUID REFERENCES sage_threads(thread_id) ON DELETE CASCADE,
  -- "router" (endpoint pick + SQL draft) OR "narrative" (prose writer).
  call_kind    TEXT NOT NULL CHECK (call_kind IN ('router', 'narrative')),
  -- Provider + model used. Lets us correlate cost across provider swaps.
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  -- Inputs / outputs. Stored verbatim for debugging; can be purged.
  prompt       JSONB NOT NULL,
  output       JSONB,
  -- Usage telemetry. cost_usd computed at write-time from current pricing.
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10, 6) NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  -- Structured outcome. error_code is null on success.
  error_code    TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_turns_thread
  ON sage_turns_audit (thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sage_turns_created
  ON sage_turns_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sage_turns_model_created
  ON sage_turns_audit (model, created_at DESC);

COMMIT;
