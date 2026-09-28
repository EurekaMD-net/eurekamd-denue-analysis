/**
 * CLI: record which edition of a dataset is loaded, in `dataset_versions`
 * (scripts/migrations/026-dataset-versions.sql).
 *
 * Prints the upsert SQL by default; `--apply` runs it through the loaders'
 * psql path (scripts/_psql-tx.ts runPsqlScript: docker exec, one
 * transaction, ON_ERROR_STOP).
 *
 * Re-recording the same (dataset, edition) updates it: loaded_at = now(),
 * and row_count / source / note take the new value when given, else keep the
 * old one (so a re-run without --rows never erases a recorded count).
 *
 * Every value reaches SQL as a dollar-quoted literal whose tag is checked
 * against the value; control characters are refused, so no value can end
 * the literal or start a psql backslash command on a new line.
 *
 * Usage:
 *   npx tsx scripts/record-dataset-version.ts --dataset=denue --edition=05/2026 \
 *     --source="INEGI DENUE API" --rows=6138075 [--note=...] [--apply]
 *
 * Env:
 *   SUPABASE_DB_CONTAINER (default 'supabase-db')
 */

import { runPsqlScript } from "./_psql-tx.js";

const DATASET_RE = /^[a-z][a-z0-9_]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ROWS_RE = /^[0-9]+$/;
const TEXT_FLAGS = ["dataset", "edition", "source", "note"] as const;
const KNOWN_FLAGS = new Set<string>([...TEXT_FLAGS, "rows"]);

export interface DatasetVersion {
  dataset: string;
  edition: string;
  source?: string;
  rows?: number;
  note?: string;
}

export interface ParsedArgs {
  version: DatasetVersion;
  apply: boolean;
}

/**
 * `--key=value` flags plus `--apply`; anything else, or a flag given twice,
 * is an error. Values are trimmed, so "05/2026 " cannot become a second
 * edition row.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const m = /^--([a-z]+)=(.*)$/s.exec(arg);
    if (!m || !KNOWN_FLAGS.has(m[1]!)) {
      throw new Error(`record-dataset-version: unknown argument "${arg}"`);
    }
    if (values.has(m[1]!)) {
      throw new Error(`record-dataset-version: --${m[1]} given more than once`);
    }
    values.set(m[1]!, m[2]!.trim());
  }

  const dataset = values.get("dataset");
  const edition = values.get("edition");
  if (dataset === undefined || edition === undefined) {
    throw new Error("record-dataset-version: --dataset and --edition are required");
  }
  const version: DatasetVersion = { dataset, edition };
  const source = values.get("source");
  const note = values.get("note");
  const rows = values.get("rows");
  if (source !== undefined) version.source = source;
  if (note !== undefined) version.note = note;
  if (rows !== undefined) {
    const n = Number(rows);
    if (!ROWS_RE.test(rows) || !Number.isSafeInteger(n)) {
      throw new Error(`record-dataset-version: --rows must be a non-negative integer, got "${rows}"`);
    }
    version.rows = n;
  }
  validate(version);
  return { version, apply };
}

function validate(v: DatasetVersion): void {
  if (!DATASET_RE.test(v.dataset)) {
    throw new Error(
      `record-dataset-version: --dataset must match ${DATASET_RE.source}, got "${v.dataset}"`,
    );
  }
  for (const key of TEXT_FLAGS) {
    const value = v[key];
    if (value === undefined) continue;
    if (value.trim() === "") {
      throw new Error(`record-dataset-version: --${key} is empty`);
    }
    if (value !== value.trim()) {
      throw new Error(`record-dataset-version: --${key} has leading or trailing whitespace`);
    }
    if (CONTROL_RE.test(value)) {
      throw new Error(`record-dataset-version: --${key} contains a control character`);
    }
  }
  if (v.rows !== undefined && (!Number.isSafeInteger(v.rows) || v.rows < 0)) {
    throw new Error(`record-dataset-version: rows must be a non-negative integer`);
  }
}

/**
 * `value` as a dollar-quoted literal. The tag is chosen so its first
 * occurrence in `value + tag` is the closing one (a value ending in `$v`
 * would otherwise complete an early `$v$`).
 */
export function dollarQuote(value: string): string {
  for (let i = 0; ; i++) {
    const tag = i === 0 ? "$v$" : `$v${i}$`;
    if ((value + tag).indexOf(tag) === value.length) return `${tag}${value}${tag}`;
  }
}

const lit = (value: string | undefined): string =>
  value === undefined ? "NULL" : dollarQuote(value);

export function buildRecordSql(v: DatasetVersion): string {
  validate(v);
  const rows = v.rows === undefined ? "NULL" : String(v.rows);
  return [
    "INSERT INTO public.dataset_versions (dataset, edition, source, row_count, note)",
    `VALUES (${lit(v.dataset)}, ${lit(v.edition)}, ${lit(v.source)}, ${rows}, ${lit(v.note)})`,
    "ON CONFLICT (dataset, edition) DO UPDATE SET",
    "  row_count = COALESCE(EXCLUDED.row_count, dataset_versions.row_count),",
    "  loaded_at = now(),",
    "  source = COALESCE(EXCLUDED.source, dataset_versions.source),",
    "  note = COALESCE(EXCLUDED.note, dataset_versions.note)",
    "RETURNING dataset, edition, row_count, loaded_at;",
  ].join("\n");
}

/** The SQL (no --apply) or psql's output (--apply). */
export function run(argv: readonly string[], container: string): string {
  const { version, apply } = parseArgs(argv);
  const sql = buildRecordSql(version);
  return apply ? runPsqlScript(container, sql + "\n", 30_000) : sql + "\n";
}

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  try {
    process.stdout.write(
      run(process.argv.slice(2), process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db"),
    );
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
