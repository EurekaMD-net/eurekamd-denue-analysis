/**
 * CLI: build src/db/scian_clase_catalog.json — the SCIAN clase label → 6-digit
 * code map that transform() uses (audit #131, 2026-09-26).
 *
 * BuscarEntidad returns no activity-code field, so the loader used to derive
 * clase_actividad_id from CLEE chars 6-11. CLEE encodes the class at
 * registration and never follows a reclassification, while the Clase_actividad
 * label is current: ~12% of CDMX rows carried a code that disagrees with their
 * label (e.g. 'Comercio al por menor en tiendas de abarrotes...' stored as
 * 464111, pharmacies).
 *
 * The catalog is the modal code per label across the loaded corpus. A label
 * enters the catalog only when the match is mutual: its modal code C is a
 * strict plurality among its rows, AND this label is the strict-plurality
 * label among all rows stored as C. That also guarantees one label per code.
 * Every other label is printed for manual review and left out (transform()
 * then falls back to CLEE for it).
 *
 * Why not a share floor: the off-modal rows are reclassified establishments
 * spread over many unrelated codes (e.g. 'Restaurantes que preparan otro tipo
 * de alimentos para llevar': 722518 72%, then 722212, 722219, ...), so an 80%
 * floor rejected 445 of 987 labels, including the two biggest food-service
 * classes, although their modal code is the correct SCIAN 2023 code. Labels
 * whose modal share is under 80% are still listed as `low-share` for review.
 *
 * Read-only: one SELECT per entidad under default_transaction_read_only.
 *
 * Usage:
 *   npx tsx scripts/gen-scian-clase-catalog.ts
 *
 * Env:
 *   SUPABASE_DB_CONTAINER (default 'supabase-db')
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeContainer } from "../src/api/handlers/_safe-container.js";

const SEP = "\x1f";
const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "scian_clase_catalog.json",
);

const container = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
assertSafeContainer(container);

/** label → code → rows */
const counts = new Map<string, Map<string, number>>();

for (let e = 1; e <= 32; e++) {
  const entidad = String(e).padStart(2, "0");
  const out = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-F",
      SEP,
      "-c",
      "SET default_transaction_read_only=on",
      "-c",
      "SET statement_timeout='20s'",
      "-c",
      `SELECT trim(clase_actividad), clase_actividad_id, count(*)
         FROM establecimientos
        WHERE entidad = '${entidad}'
          AND clase_actividad IS NOT NULL
          AND clase_actividad_id ~ '^[0-9]{6}$'
        GROUP BY 1, 2`,
    ],
    { encoding: "utf-8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const line of out.split("\n")) {
    const f = line.split(SEP);
    if (f.length !== 3) continue; // the two SET echoes
    const [label, code, n] = f as [string, string, string];
    const byCode = counts.get(label) ?? new Map<string, number>();
    byCode.set(code, (byCode.get(code) ?? 0) + Number(n));
    counts.set(label, byCode);
  }
}

/** Strict-plurality key of a count map; null on a tie for first place. */
function plurality(m: Map<string, number>): {
  key: string | null;
  share: number;
  total: number;
} {
  let total = 0;
  let best: string | null = null;
  let bestN = -1;
  let tie = false;
  for (const [k, n] of m) {
    total += n;
    if (n > bestN) {
      best = k;
      bestN = n;
      tie = false;
    } else if (n === bestN) {
      tie = true;
    }
  }
  return { key: tie ? null : best, share: bestN / total, total };
}

/** code → label → rows (the same counts, transposed) */
const byCodeLabel = new Map<string, Map<string, number>>();
for (const [label, byCode] of counts) {
  for (const [code, n] of byCode) {
    const byLabel = byCodeLabel.get(code) ?? new Map<string, number>();
    byLabel.set(label, n);
    byCodeLabel.set(code, byLabel);
  }
}

const clases: Record<string, string> = {};
const conflicts: string[] = [];
const lowShare: string[] = [];
const labels = [...counts.keys()].sort((a, b) => a.localeCompare(b, "es"));
for (const label of labels) {
  const m = plurality(counts.get(label)!);
  const desc = `${m.key ?? "(tie)"} ${(m.share * 100).toFixed(1)}% of ${m.total}  ${label}`;
  if (m.key === null) {
    conflicts.push(`tie        ${desc}`);
    continue;
  }
  const back = plurality(byCodeLabel.get(m.key)!);
  if (back.key !== label) {
    conflicts.push(`not-mutual ${desc}  (code's modal label: ${back.key ?? "(tie)"})`);
    continue;
  }
  clases[label] = m.key;
  if (m.share < 0.8) lowShare.push(`low-share  ${desc}`);
}

writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      _comment:
        "SCIAN clase label -> 6-digit code, generated by scripts/gen-scian-clase-catalog.ts (mutual strict-plurality label <-> code match across the loaded corpus). Labels left out fall back to CLEE in transform().",
      _generated_at: new Date().toISOString().slice(0, 10),
      clases,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `[gen-scian-clase-catalog] ${Object.keys(clases).length} labels written to ${OUT_PATH}; ${conflicts.length} left out (CLEE fallback):`,
);
for (const c of conflicts) console.log(`  ${c}`);
console.log(`Included with modal share < 80% (review): ${lowShare.length}`);
for (const c of lowShare) console.log(`  ${c}`);
