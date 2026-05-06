#!/usr/bin/env python3
"""
Geocode COFEPRIS farmacias to AGEB + cve_mun via DENUE join.

Strategy:
  1. Pull all DENUE pharmacies (clase_actividad_id IN ('464111','464112'))
     keyed by (cve_ent, cp). Each pharmacy has its own ageb + area_geo.
  2. For each COFEPRIS row:
     a. Look up DENUE pharmacies in same (cve_ent, cp).
     b. Try colonia substring match. First hit wins → take its AGEB.
     c. If no colonia match, take the modal AGEB across all DENUE
        pharmacies in that CP (CPs are small enough that any pharmacy
        in the CP gives a valid neighbourhood centroid).
  3. Unmatched: cve_mun and cvegeo_ageb stay empty. Endpoint then
     surfaces only at country/state level for those rows.

Probe over CDMX (n=200, 2026-05-05): 77.0% precise + 15.0% modal = 92.0%.
Full corpus (n=2,381): 74.7% precise + 17.6% modal = 92.3%.

Usage:
  python3 scripts/cofepris-geocode.py
  # reads  /tmp/cofepris/farmacias.csv
  # writes /tmp/cofepris/farmacias_geocoded.csv
"""

import csv
import re
import subprocess
import sys
import unicodedata
from collections import Counter

INPUT = "/tmp/cofepris/farmacias.csv"
OUTPUT = "/tmp/cofepris/farmacias_geocoded.csv"
DB_CONTAINER = "supabase-db"

DENUE_QUERY = """
COPY (
  SELECT entidad, cp, area_geo, ageb, COALESCE(colonia,'') AS colonia
  FROM establecimientos
  WHERE clase_actividad_id IN ('464111','464112')
    AND ageb IS NOT NULL AND ageb != ''
    AND area_geo IS NOT NULL
    -- 2026-05-06: accept BOTH 9-char (rural, INEGI Marco encodes rural AGEB
    -- without locality: ENT+MUN+AGEB) AND 13-char (urban: ENT+MUN+LOC+AGEB).
    -- An earlier shape filter ruled out 9-char as malformed — wrong; ~17k
    -- rural pharma rows are legitimate.
    AND ageb ~ '^([0-9A-Z]{9}|[0-9A-Z]{13})$'
) TO STDOUT WITH CSV HEADER;
"""


def upper_ascii(s: str) -> str:
    if not s:
        return ""
    n = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    n = re.sub(r"[^A-Z0-9 ]", " ", n.upper())
    return re.sub(r"\s+", " ", n).strip()


def colonia_matches(cof_norm: str, denue_norm: str) -> bool:
    """
    Token-aware colonia match (v0.2.8 audit W2, 2026-05-06).

    Replaces naive `cof in denue or denue in cof` substring match. The old
    form would collapse e.g. COFEPRIS "EL VALLE" against DENUE "DEL VALLE"
    (because "EL VALLE" in "DEL VALLE" is True). With CP+entidad bounding
    the FP rate is low, but token-overlap is the principled fix.

    Match if every token of the shorter colonia appears as a whole word
    in the longer one. "DEL VALLE" matches "DEL VALLE NORTE"; "EL VALLE"
    does NOT match "DEL VALLE" because "DEL" is missing on the COFEPRIS
    side. Single-token colonias (e.g. "AURORA") still need a whole-word
    hit on the other side.
    """
    if not cof_norm or not denue_norm:
        return False
    cof_tokens = cof_norm.split()
    denue_tokens = denue_norm.split()
    if not cof_tokens or not denue_tokens:
        return False
    short, long_ = (
        (cof_tokens, denue_tokens)
        if len(cof_tokens) <= len(denue_tokens)
        else (denue_tokens, cof_tokens)
    )
    long_set = set(long_)
    return all(tok in long_set for tok in short)


def modal(items: list[str]) -> str | None:
    """
    Modal element with deterministic tie-break (lowest alphabetic key wins).
    Counter.most_common preserves insertion order on ties, which would make
    geocoding non-reproducible across DENUE row orderings.
    qa-audit M3 from v0.2.8 R1.
    """
    if not items:
        return None
    counts = Counter(items)
    top_count = counts.most_common(1)[0][1]
    tied = sorted(k for k, v in counts.items() if v == top_count)
    return tied[0]


def main() -> None:
    res = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            DB_CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-c",
            DENUE_QUERY,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    denue = list(csv.DictReader(res.stdout.splitlines()))
    if not denue:
        print("ERROR: zero DENUE pharmacies returned", file=sys.stderr)
        sys.exit(1)
    print(f"DENUE pharma indexed: {len(denue)}", file=sys.stderr)

    idx: dict[tuple[str, str], list[dict]] = {}
    for d in denue:
        cp = (d["cp"] or "").strip()
        ent = (d["entidad"] or "").strip()
        if not cp or not ent:
            continue
        d["_col_norm"] = upper_ascii(d["colonia"])
        idx.setdefault((ent, cp), []).append(d)

    with open(INPUT) as f:
        cof_rows = list(csv.DictReader(f))

    n_total = 0
    n_cp_colonia = 0
    n_cp_modal = 0
    n_unmatched = 0

    fieldnames = list(cof_rows[0].keys()) + ["cve_mun", "cvegeo_ageb", "geocode_method"]
    with open(OUTPUT, "w", newline="", encoding="utf-8") as fout:
        writer = csv.DictWriter(fout, fieldnames=fieldnames)
        writer.writeheader()

        for c in cof_rows:
            n_total += 1
            cve_mun = ""
            cvegeo = ""
            method = "none"
            cp = (c.get("cp") or "").strip()
            ent = (c.get("cve_ent") or "").strip()

            if cp and ent:
                candidates = idx.get((ent, cp), [])
                if candidates:
                    col_norm = c.get("colonia_norm", "")
                    matched = None
                    if col_norm:
                        for d in candidates:
                            if colonia_matches(col_norm, d["_col_norm"]):
                                matched = d
                                break
                    if matched:
                        cve_mun = matched["area_geo"]
                        # DENUE.ageb is already the full 13-char cvegeo
                        # (ENT+MUN+LOC+AGEB), not just the 4-char AGEB suffix.
                        # Use it directly.
                        cvegeo = matched["ageb"]
                        method = "cp_colonia"
                        n_cp_colonia += 1
                    else:
                        cve_mun = modal([d["area_geo"] for d in candidates]) or ""
                        modal_ageb = modal(
                            [d["ageb"] for d in candidates if d["area_geo"] == cve_mun]
                        )
                        cvegeo = modal_ageb or ""
                        method = "cp_modal"
                        n_cp_modal += 1
                else:
                    n_unmatched += 1
            else:
                n_unmatched += 1

            out = dict(c)
            out["cve_mun"] = cve_mun
            out["cvegeo_ageb"] = cvegeo
            out["geocode_method"] = method
            writer.writerow(out)

    pct = lambda n: 100 * n / n_total if n_total else 0
    print(f"\nGeocoding over {n_total} rows:")
    print(f"  cp_colonia: {n_cp_colonia} ({pct(n_cp_colonia):.1f}%)")
    print(f"  cp_modal:   {n_cp_modal} ({pct(n_cp_modal):.1f}%)")
    print(f"  unmatched:  {n_unmatched} ({pct(n_unmatched):.1f}%)")
    print(f"  combined:   {pct(n_cp_colonia + n_cp_modal):.1f}%")
    print(f"  -> {OUTPUT}")

    # v0.2.8 audit W4 (2026-05-06): post-geocode integrity check.
    # Mock-only loader tests can't catch the cvegeo-shape bug class — this is
    # the same defense as the v0.2.8-shipped feedback memory advised: smoke-
    # test by joining BACK to ageb_polygons. Aborts non-zero if integrity
    # fails, so the next loader step doesn't pick up bad data.
    integrity_check_geocoded()


def integrity_check_geocoded() -> None:
    """
    Verify the geocoded output by joining back to ageb_polygons. The original
    cvegeo-shape bug (concatenating cve_mun + 4-char ageb to produce 18-char
    garbage) would surface as 0% join rate against ageb_polygons.cvegeo. We
    require ≥85% of geocoded cvegeos to actually exist in ageb_polygons —
    below that threshold something has shifted (DENUE column rename, schema
    change, geocoder bug) and we'd rather fail loud than load corrupt data.
    """
    print("\n[integrity] joining geocoded.cvegeo_ageb back to ageb_polygons...")
    cvegeos = []
    with open(OUTPUT) as f:
        reader = csv.DictReader(f)
        for r in reader:
            v = (r.get("cvegeo_ageb") or "").strip()
            if v:
                cvegeos.append(v)
    if not cvegeos:
        print("[integrity] WARN: zero geocoded cvegeos — skipping join check.")
        return
    # Validate shape locally first (cheap): rural=9 chars, urban=13 chars.
    bad_shape = [v for v in cvegeos if len(v) not in (9, 13)]
    if bad_shape:
        print(
            f"[integrity] FAIL: {len(bad_shape)}/{len(cvegeos)} cvegeos have invalid shape (expected 9 or 13 chars)",
            file=sys.stderr,
        )
        print(f"  sample: {bad_shape[:5]}", file=sys.stderr)
        sys.exit(2)
    # Stream cvegeos via stdin to avoid argv length limits / shell quoting.
    cvegeo_list = "\n".join(cvegeos)
    join_sql = """
COPY (
  WITH input(cvegeo) AS (
    SELECT regexp_split_to_table(:'list', E'\\n')
  )
  SELECT
    COUNT(*) AS total,
    COUNT(p.cvegeo) AS matched
  FROM input i
  LEFT JOIN ageb_polygons p ON p.cvegeo = i.cvegeo
) TO STDOUT WITH CSV;
    """
    res = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            DB_CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            f"list={cvegeo_list}",
            "-c",
            join_sql,
        ],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(
            f"[integrity] FAIL: psql exit {res.returncode}",
            file=sys.stderr,
        )
        print(f"  stderr: {res.stderr[:500]}", file=sys.stderr)
        sys.exit(2)
    line = res.stdout.strip().splitlines()[-1] if res.stdout.strip() else ""
    parts = line.split(",") if line else []
    if len(parts) != 2:
        print(
            f"[integrity] FAIL: unexpected psql output {line!r}",
            file=sys.stderr,
        )
        sys.exit(2)
    total = int(parts[0])
    matched = int(parts[1])
    rate = 100.0 * matched / total if total else 0.0
    print(
        f"[integrity] {matched}/{total} cvegeos exist in ageb_polygons "
        f"({rate:.1f}%)"
    )
    if rate < 85.0:
        print(
            f"[integrity] FAIL: match rate {rate:.1f}% < 85% threshold. "
            "Geocoder output is shape-correct but doesn't join back to "
            "ageb_polygons — likely DENUE.ageb column drift or stale "
            "ageb_polygons. Refusing to write a known-broken dataset.",
            file=sys.stderr,
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
