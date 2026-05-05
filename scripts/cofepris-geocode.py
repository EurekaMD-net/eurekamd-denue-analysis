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
) TO STDOUT WITH CSV HEADER;
"""


def upper_ascii(s: str) -> str:
    if not s:
        return ""
    n = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    n = re.sub(r"[^A-Z0-9 ]", " ", n.upper())
    return re.sub(r"\s+", " ", n).strip()


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
                            dnorm = d["_col_norm"]
                            if dnorm and (col_norm in dnorm or dnorm in col_norm):
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


if __name__ == "__main__":
    main()
