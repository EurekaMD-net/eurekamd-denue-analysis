#!/usr/bin/env python3
"""
Extract COFEPRIS Padrón de licencias sanitarias de farmacias to CSV.

Source: BASE_DE_DATOS_DE_LICENCIAS_SANITARIAS_DE_FARMACIAS___DROGUERIAS_Y_BOTICAS.pdf
Output: 14 raw cols + computed line-class flags + clean CP/entidad/colonia.

Run:
    python3 scripts/cofepris-pdf-to-csv.py <input.pdf> <output.csv>
"""

import csv
import re
import sys
import unicodedata

import pdfplumber

EXPECTED_COLS = 14
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
        "has_estupefacientes": "ESTUPEFACIENTE" in txt,
        "has_psicotropicos": "PSICOTROPIC" in txt,
        "has_vacunas": "VACUNA" in txt,
        "has_toxoides": "TOXOIDE" in txt,
        "has_sueros_antitoxinas": "SUERO" in txt or "ANTITOXINA" in txt,
        "has_hemoderivados": "HEMODERIVAD" in txt,
    }


CP_RE = re.compile(r"^\d{5}$")
LICENCIA_RE = re.compile(r"^[A-Z0-9\-/]+$", re.IGNORECASE)
DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def parse_date(s: str) -> str:
    """DD/MM/YYYY -> YYYY-MM-DD; empty if unparseable."""
    if not s:
        return ""
    m = DATE_RE.match(s.strip())
    if not m:
        return ""
    d, mo, y = m.groups()
    return f"{y}-{int(mo):02d}-{int(d):02d}"


def is_data_row(row) -> bool:
    if not row or not row[0]:
        return False
    return row[0].strip().isdigit()


def extract_pdf(pdf_path: str) -> list[dict]:
    rows_out = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            if not tables:
                continue
            for table in tables:
                for row in table:
                    if not is_data_row(row):
                        continue
                    if len(row) != EXPECTED_COLS:
                        sys.stderr.write(
                            f"WARN page {page_num}: row has {len(row)} cols, expected {EXPECTED_COLS}; skipping\n"
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

                    # Validation: required fields
                    if not consec or not licencia:
                        sys.stderr.write(
                            f"WARN page {page_num}: missing consec/licencia; skipping\n"
                        )
                        continue

                    cve_ent = ENTIDAD_TO_CVE_ENT.get(entidad, "")
                    if not cve_ent:
                        ent_norm = upper_ascii(entidad)
                        for k, v in ENTIDAD_TO_CVE_ENT.items():
                            if upper_ascii(k) == ent_norm:
                                cve_ent = v
                                break
                    if not cve_ent:
                        sys.stderr.write(
                            f"WARN page {page_num} consec {consec}: unknown entidad {entidad!r}\n"
                        )

                    cp_clean = cp if CP_RE.match(cp or "") else ""

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
                            "fecha_expedicion": parse_date(fecha_raw),
                            "lineas_autorizadas": lineas,
                            "estatus_licencia": estatus_lic,
                            "estatus_establecimiento": estatus_est,
                            "observaciones": obs,
                            **{k: ("1" if v else "0") for k, v in classes.items()},
                        }
                    )
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
    n_vigente = sum(1 for r in rows if r["estatus_licencia"].lower() == "vigente")
    n_with_ent = sum(1 for r in rows if r["cve_ent"])
    n_with_cp = sum(1 for r in rows if r["cp"])
    n_with_estup = sum(1 for r in rows if r["has_estupefacientes"] == "1")
    n_with_psico = sum(1 for r in rows if r["has_psicotropicos"] == "1")
    print(f"OK  rows={n}  vigente={n_vigente}  with_cve_ent={n_with_ent}  with_cp={n_with_cp}")
    print(f"    has_estupefacientes={n_with_estup}  has_psicotropicos={n_with_psico}")
    print(f"    -> {csv_path}")


if __name__ == "__main__":
    main()
