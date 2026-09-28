#!/usr/bin/env python3
"""
Extract COFEPRIS Padrón de licencias sanitarias de farmacias to CSV.

Source: gob.mx attachment 1079227 (Fecha de actualización 15/05/2026),
BASE_DE_DATOS_DE_LICENCIAS_SANITARIAS_DE_FARMACIAS___DROGUER_AS_Y_BOTICAS_EMITIDAS_POR_COFEPRIS.pdf
Tables carry 14 columns (editions up to 2025-07) or 17 (2026-05 appends
MODIFICACIÓN ADMINISTRATIVA, FECHA DE EXPEDICIÓN DE CONSTANCIA, FOLIO DE
CONSTANCIA). Every page's header is checked against the first one (exit 1 on
any difference); a data row whose width differs from its header is skipped
with a WARN.
Output: 14 raw cols + computed line-class flags + clean CP/entidad/colonia,
then the 3 constancia cols (empty for 14-column editions and for `No aplica`).

Run:
    python3 scripts/cofepris-pdf-to-csv.py <input.pdf> <output.csv>
"""

import csv
import re
import sys
import unicodedata
from collections import Counter
from datetime import date

import pdfplumber

EXPECTED_COLS = 14
EXPECTED_HEADER = [
    "NO. CONSEC.", "ESTABLECIMIENTO", "GIRO", "CALLE NO.", "COLONIA",
    "CODIGO POSTAL", "LOCALIDAD", "ENTIDAD", "NO. LICENCIA",
    "FECHA EXPEDICION", "LINEAS AUTORIZADAS", "ESTATUS DE LA LICENCIA",
    "ESTATUS DEL ESTABLECIMIENTO", "OBSERVACIONES",
]
EXTRA_HEADER = [
    "MODIFICACION ADMINISTRATIVA REALIZADA",
    "FECHA DE EXPEDICION DE CONSTANCIA",
    "FOLIO DE CONSTANCIA",
]
ENTIDAD_TO_CVE_ENT = {
    "Aguascalientes": "01",
    "Baja California": "02",
    "Baja California Sur": "03",
    "Campeche": "04",
    "Coahuila": "05",
    "Coahuila de Zaragoza": "05",
    "Colima": "06",
    "Chiapas": "07",
    "Chihuahua": "08",
    "Ciudad de México": "09",
    "Distrito Federal": "09",
    "Durango": "10",
    "Guanajuato": "11",
    "Guerrero": "12",
    "Hidalgo": "13",
    "Jalisco": "14",
    "México": "15",
    "Estado de México": "15",
    "Michoacán": "16",
    "Michioacán": "16",  # typo in the 2026-05 edition (consec 2460)
    "Michoacán de Ocampo": "16",
    "Morelos": "17",
    "Nayarit": "18",
    "Nuevo León": "19",
    "Oaxaca": "20",
    "Puebla": "21",
    "Querétaro": "22",
    "Quintana Roo": "23",
    "San Luis Potosí": "24",
    "Sinaloa": "25",
    "Sonora": "26",
    "Tabasco": "27",
    "Tamaulipas": "28",
    "Tlaxcala": "29",
    "Veracruz": "30",
    "Veracruz de Ignacio de la Llave": "30",
    "Yucatán": "31",
    "Zacatecas": "32",
}


def normalize(s: str) -> str:
    if s is None:
        return ""
    s = s.replace("\n", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def upper_ascii(s: str) -> str:
    if not s:
        return ""
    norm = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return norm.upper().strip()


def detect_classes(lineas: str) -> dict:
    """
    Classify LÍNEAS AUTORIZADAS into 6 control classes.
    All boolean flags. A row may match multiple classes.

    v0.2.8 audit W1 (2026-05-06): word-boundary regex instead of naive
    substring `in`. The catalog dataset is bounded (FP risk low) but
    `"VACUNA" in "REVACUNAR"` would silently match if COFEPRIS ever shipped
    a derived form. `\\b` matches across hyphen / slash / comma / space —
    the actual separators COFEPRIS uses between authorized lines.
    Each pattern matches the lemma plus its singular/plural variants.
    """
    if not lineas:
        return {
            "has_estupefacientes": False,
            "has_psicotropicos": False,
            "has_vacunas": False,
            "has_toxoides": False,
            "has_sueros_antitoxinas": False,
            "has_hemoderivados": False,
        }
    txt = upper_ascii(lineas)
    return {
        "has_estupefacientes": bool(re.search(r"\bESTUPEFACIENTES?\b", txt)),
        "has_psicotropicos": bool(re.search(r"\bPSICOTROPIC[OA]S?\b", txt)),
        "has_vacunas": bool(re.search(r"\bVACUNAS?\b", txt)),
        "has_toxoides": bool(re.search(r"\bTOXOIDES?\b", txt)),
        "has_sueros_antitoxinas": bool(
            re.search(r"\b(SUEROS?|ANTITOXINAS?)\b", txt)
        ),
        "has_hemoderivados": bool(re.search(r"\bHEMODERIVADOS?\b", txt)),
    }


CP_RE = re.compile(r"^\d{5}$")
LICENCIA_RE = re.compile(r"^[A-Z0-9\-/]+$", re.IGNORECASE)
DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
# 2026-05 edition prints dates as `3-mar.-26` (d-mmm.-yy, Spanish months).
DATE_MON_RE = re.compile(r"^(\d{1,2})-([a-z]{3,4})\.?-(\d{2})$")
MONTHS_ES = {
    "ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6,
    "jul": 7, "ago": 8, "sep": 9, "sept": 9, "set": 9, "oct": 10,
    "nov": 11, "dic": 12,
}
ESTATUS_LICENCIA = {"VIGENTE": "Vigente", "REVOCADA": "Revocada"}

# WARN counts by kind for the last extract_pdf() run (printed by main).
WARNS: Counter = Counter()


def warn(kind: str, msg: str) -> None:
    WARNS[kind] += 1
    sys.stderr.write(f"WARN {msg}\n")


def parse_date(s: str) -> str:
    """DD/MM/YYYY or d-mmm.-yy -> YYYY-MM-DD; empty if unparseable or not a real date."""
    if not s:
        return ""
    m = DATE_RE.match(s.strip())
    if m:
        d, mo, y = (int(g) for g in m.groups())
    else:
        m = DATE_MON_RE.match(s.strip().lower())
        if not m or m.group(2) not in MONTHS_ES:
            return ""
        d, mo = int(m.group(1)), MONTHS_ES[m.group(2)]
        # Two-digit year: every 2026-05 date is 2001..2026; a yy past the
        # current year can only be 19yy.
        y = 2000 + int(m.group(3))
        if y > date.today().year:
            y -= 100
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return ""


def header_name(c) -> str:
    """Header cell -> uppercase, accents stripped, whitespace collapsed."""
    return re.sub(r"\s+", " ", upper_ascii(c or "")).strip()


def no_aplica(s: str) -> str:
    """`No aplica` (any case/accents) -> empty; anything else unchanged."""
    return "" if re.sub(r"\s+", " ", upper_ascii(s)) == "NO APLICA" else s


def check_header(row, page_num: int, first: list[str] | None) -> list[str]:
    """
    Fail closed unless a header row names the expected columns: the first
    header against the 14 (+3) known names, every later one against the first.
    """
    names = [header_name(c) for c in row]
    if first is None:
        expected = EXPECTED_HEADER + (EXTRA_HEADER if len(row) > EXPECTED_COLS else [])
    else:
        expected = first
    if names != expected:
        sys.stderr.write(
            f"ERROR page {page_num}: unexpected table header\n"
            f"  expected: {expected}\n  got:      {names}\n"
        )
        sys.exit(1)
    return names


def is_data_row(row) -> bool:
    if not row or not row[0]:
        return False
    return row[0].strip().isdigit()


def extract_pdf(pdf_path: str) -> list[dict]:
    rows_out = []
    WARNS.clear()
    first_header = None
    header_width = None
    bad_dates = 0
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            if not tables:
                continue
            for table in tables:
                for row in table:
                    if row and header_name(row[0]) == "NO. CONSEC.":
                        first_header = check_header(row, page_num, first_header)
                        header_width = len(row)
                        continue
                    if not is_data_row(row):
                        continue
                    if len(row) != header_width:
                        warn(
                            "width",
                            f"page {page_num}: row has {len(row)} cols, header has {header_width}; skipping",
                        )
                        continue
                    consec = normalize(row[0])
                    nombre = normalize(row[1])
                    giro = normalize(row[2])
                    calle = normalize(row[3])
                    colonia = normalize(row[4])
                    cp = normalize(row[5])
                    localidad = normalize(row[6])
                    entidad = normalize(row[7])
                    licencia = normalize(row[8])
                    fecha_raw = normalize(row[9])
                    lineas = normalize(row[10])
                    estatus_lic = normalize(row[11])
                    estatus_est = normalize(row[12])
                    obs = normalize(row[13])
                    extra = [no_aplica(normalize(c)) for c in row[14:]] or ["", "", ""]

                    # Validation: required fields
                    if not consec or not licencia:
                        warn("missing_field", f"page {page_num}: missing consec/licencia; skipping")
                        continue

                    cve_ent = ENTIDAD_TO_CVE_ENT.get(entidad, "")
                    if not cve_ent:
                        ent_norm = upper_ascii(entidad)
                        for k, v in ENTIDAD_TO_CVE_ENT.items():
                            if upper_ascii(k) == ent_norm:
                                cve_ent = v
                                break
                    if not cve_ent:
                        warn("unknown_entidad", f"page {page_num} consec {consec}: unknown entidad {entidad!r}")

                    cp_clean = cp.rstrip(" \t.,;:-")
                    if cve_ent == "09" and re.fullmatch(r"\d{4}", cp_clean):
                        cp_clean = "0" + cp_clean
                    if not CP_RE.match(cp_clean):
                        if cp:
                            warn("cp_invalid", f"page {page_num} consec {consec}: cp {cp!r} dropped")
                        cp_clean = ""
                    elif cp_clean != cp:
                        warn("cp_fixed", f"page {page_num} consec {consec}: cp {cp!r} -> {cp_clean!r}")

                    estatus_fixed = ESTATUS_LICENCIA.get(upper_ascii(estatus_lic))
                    if estatus_fixed is None:
                        warn("estatus_unknown", f"page {page_num} consec {consec}: estatus_licencia {estatus_lic!r} kept")
                    elif estatus_fixed != estatus_lic:
                        warn("estatus_fixed", f"page {page_num} consec {consec}: estatus_licencia {estatus_lic!r} -> {estatus_fixed!r}")
                        estatus_lic = estatus_fixed

                    fecha_exp = parse_date(fecha_raw)
                    fecha_const = parse_date(extra[1])
                    bad = [v for v, iso in ((fecha_raw, fecha_exp), (extra[1], fecha_const)) if v and not iso]
                    if bad:
                        bad_dates += 1
                        warn("date_unparsed", f"page {page_num} consec {consec}: unparseable date(s) {bad!r}")

                    classes = detect_classes(lineas)

                    rows_out.append(
                        {
                            "consec": consec,
                            "nombre": nombre,
                            "giro": giro,
                            "calle": calle,
                            "colonia": colonia,
                            "colonia_norm": upper_ascii(colonia),
                            "cp": cp_clean,
                            "localidad": localidad,
                            "localidad_norm": upper_ascii(localidad),
                            "entidad": entidad,
                            "cve_ent": cve_ent,
                            "licencia": licencia,
                            "fecha_expedicion": fecha_exp,
                            "lineas_autorizadas": lineas,
                            "estatus_licencia": estatus_lic,
                            "estatus_establecimiento": estatus_est,
                            "observaciones": obs,
                            **{k: ("1" if v else "0") for k, v in classes.items()},
                            "modificacion_administrativa": extra[0],
                            "fecha_constancia": fecha_const,
                            "folio_constancia": extra[2],
                        }
                    )
    if first_header is None:
        sys.stderr.write("ERROR: no 'NO. CONSEC.' table header found in the PDF\n")
        sys.exit(1)
    if bad_dates > 0.01 * len(rows_out):
        sys.stderr.write(
            f"ERROR: {bad_dates} of {len(rows_out)} rows have an unparseable date (> 1%) "
            "(see WARN date_unparsed lines above; counts fecha_expedicion and fecha_constancia)\n"
        )
        sys.exit(1)
    return rows_out


def main():
    if len(sys.argv) != 3:
        print("usage: cofepris-pdf-to-csv.py <input.pdf> <output.csv>", file=sys.stderr)
        sys.exit(2)
    pdf_path, csv_path = sys.argv[1], sys.argv[2]
    rows = extract_pdf(pdf_path)
    if not rows:
        print("ERROR: zero rows extracted", file=sys.stderr)
        sys.exit(1)
    fieldnames = list(rows[0].keys())
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    # stats
    n = len(rows)
    n_vigente = sum(1 for r in rows if r["estatus_licencia"] == "Vigente")
    n_revocada = sum(1 for r in rows if r["estatus_licencia"] == "Revocada")
    n_with_ent = sum(1 for r in rows if r["cve_ent"])
    n_with_cp = sum(1 for r in rows if r["cp"])
    n_with_estup = sum(1 for r in rows if r["has_estupefacientes"] == "1")
    n_with_psico = sum(1 for r in rows if r["has_psicotropicos"] == "1")
    print(f"OK  rows={n}  vigente={n_vigente}  revocada={n_revocada}  with_cve_ent={n_with_ent}  with_cp={n_with_cp}")
    print(f"    has_estupefacientes={n_with_estup}  has_psicotropicos={n_with_psico}")
    print(f"    date_unparsed={WARNS['date_unparsed']}  warnings={dict(sorted(WARNS.items()))}")
    print(f"    -> {csv_path}")


if __name__ == "__main__":
    main()
