#!/usr/bin/env python3
"""
Unit tests for cofepris-pdf-to-csv.py (stdlib unittest; pdfplumber is stubbed).

Run from the repo root:
    python3 scripts/cofepris-pdf-to-csv.test.py

(`python3 -m unittest` cannot import this file: its hyphenated name is not a
valid module name, so both the path form and `discover` skip it.)
"""

import contextlib
import importlib.util
import io
import os
import sys
import types
import unittest

# Stub pdfplumber before the module under test imports it. The fake open()
# yields an object whose .pages each return the tables set on PAGES.
PAGES: list[list[list]] = []


class _Page:
    def __init__(self, rows):
        self._rows = rows

    def extract_tables(self):
        return [self._rows]


@contextlib.contextmanager
def _fake_open(_path):
    yield types.SimpleNamespace(pages=[_Page(rows) for rows in PAGES])


sys.modules["pdfplumber"] = types.SimpleNamespace(open=_fake_open)

_spec = importlib.util.spec_from_file_location(
    "cofepris_pdf_to_csv",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cofepris-pdf-to-csv.py"),
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

HEADER_14 = [
    "NO. CONSEC.", "ESTABLECIMIENTO", "GIRO", "CALLE NO.", "COLONIA",
    "CÓDIGO POSTAL", "LOCALIDAD", "ENTIDAD", "NO. LICENCIA", "FECHA EXPEDICIÓN",
    "LÍNEAS AUTORIZADAS", "ESTATUS DE LA LICENCIA", "ESTATUS DEL ESTABLECIMIENTO",
    "OBSERVACIONES",
]
HEADER_17 = HEADER_14 + [
    "MODIFICACIÓN\nADMINISTRATIVA\nREALIZADA",
    "FECHA DE EXPEDICIÓN\nDE CONSTANCIA",
    "FOLIO DE\nCONSTANCIA",
]
TITLE = ["COMISIÓN FEDERAL ..."] + [None] * 16


def row14(consec, **kw):
    return [
        str(consec), "Farmacia X", "Farmacia", "Calle 1", "Centro", kw.get("cp", "01040"),
        "Álvaro Obregón", kw.get("entidad", "Ciudad de México"), f"0900109{consec:04d}",
        kw.get("fecha", "3-mar.-26"), "Psicotrópicos fracción II y III",
        kw.get("estatus", "Vigente"), "Vigente", "Ninguna",
    ]


def row17(consec, extra=("No aplica", "No aplica", "No aplica"), **kw):
    return row14(consec, **kw) + list(extra)


def run(pages):
    PAGES[:] = pages
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        rows = mod.extract_pdf("fake.pdf")
    return rows, err.getvalue()


class ExtractTest(unittest.TestCase):
    def test_14_col_page(self):
        rows, _ = run([[TITLE[:14], HEADER_14, row14(1), row14(2)]])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["fecha_expedicion"], "2026-03-03")
        for k in ("modificacion_administrativa", "fecha_constancia", "folio_constancia"):
            self.assertEqual(rows[0][k], "")
        self.assertEqual(list(rows[0])[-3:], ["modificacion_administrativa", "fecha_constancia", "folio_constancia"])

    def test_17_col_page_no_aplica_is_empty(self):
        rows, _ = run([[TITLE, HEADER_17, row17(1)], [TITLE, HEADER_17, row17(2)]])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["fecha_constancia"], "")
        self.assertEqual(rows[1]["folio_constancia"], "")
        self.assertEqual(mod.WARNS["width"], 0)

    def test_constancia_value_mapping(self):
        rows, _ = run([[HEADER_17, row17(1, extra=("Cambio de domicilio", "12-ago.-25", "FOL-123"))]])
        self.assertEqual(rows[0]["modificacion_administrativa"], "Cambio de domicilio")
        self.assertEqual(rows[0]["fecha_constancia"], "2025-08-12")
        self.assertEqual(rows[0]["folio_constancia"], "FOL-123")

    def test_mixed_widths_skip_and_warn(self):
        rows, err = run([[HEADER_17, row17(1), row14(2), row17(3)]])
        self.assertEqual([r["consec"] for r in rows], ["1", "3"])
        self.assertEqual(mod.WARNS["width"], 1)
        self.assertIn("row has 14 cols, header has 17", err)

    def test_reordered_extra_columns_on_later_page_exits(self):
        swapped = HEADER_17[:14] + [HEADER_17[15], HEADER_17[14], HEADER_17[16]]
        with self.assertRaises(SystemExit):
            run([[HEADER_17, row17(1)], [swapped, row17(2)]])

    def test_wrapped_first_header_cell_reaches_the_diff(self):
        bad = ["NO.\nCONSEC."] + HEADER_17[1:5] + ["CP"] + HEADER_17[6:]
        # Detected as a header (diff printed), not "no header found".
        PAGES[:] = [[bad, row17(1)]]
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            mod.extract_pdf("fake.pdf")
        self.assertIn("unexpected table header", err.getvalue())

    def test_unparseable_dates_over_1pct_exit(self):
        PAGES[:] = [[HEADER_14, row14(1, fecha="99/99/2025"), row14(2)]]
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            mod.extract_pdf("fake.pdf")
        self.assertIn("1 of 2 rows", err.getvalue())

    def test_warn_counts_reset_between_runs(self):
        fixture = [[HEADER_17, row17(1, estatus="vigente"), row14(2)]]
        run(fixture)
        first = dict(mod.WARNS)
        run(fixture)
        self.assertEqual(first, {"estatus_fixed": 1, "width": 1})
        self.assertEqual(dict(mod.WARNS), first)

    def test_hygiene_estatus_cp_entidad(self):
        rows, _ = run([[
            HEADER_14,
            row14(1, estatus="vigente"),
            row14(2, cp="54680,", entidad="México"),
            row14(3, cp="1090"),
            row14(4, cp="090220"),
            row14(5, entidad="Michioacán"),
            row14(6, estatus="Suspendida"),
        ]])
        by = {r["consec"]: r for r in rows}
        self.assertEqual(by["1"]["estatus_licencia"], "Vigente")
        self.assertEqual(by["2"]["cp"], "54680")
        self.assertEqual(by["3"]["cp"], "01090")
        self.assertEqual(by["4"]["cp"], "")
        self.assertEqual(by["5"]["cve_ent"], "16")
        self.assertEqual(by["6"]["estatus_licencia"], "Suspendida")
        self.assertEqual(mod.WARNS["estatus_fixed"], 1)
        self.assertEqual(mod.WARNS["estatus_unknown"], 1)
        self.assertEqual(mod.WARNS["cp_fixed"], 2)
        self.assertEqual(mod.WARNS["cp_invalid"], 1)
        self.assertEqual(mod.WARNS["unknown_entidad"], 0)


class ParseDateTest(unittest.TestCase):
    def test_table(self):
        cases = {
            "3-mar.-26": "2026-03-03",
            "3-sept.-25": "2025-09-03",
            "3-set.-25": "2025-09-03",
            "31-dic.-99": "1999-12-31",
            "1-ene.-00": "2000-01-01",
            "29-feb.-25": "",
            "03-mar.-2026": "",
            "12/05/2025": "2025-05-12",
            "99/99/2025": "",
            "No aplica": "",
            "": "",
        }
        for raw, iso in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(mod.parse_date(raw), iso)


if __name__ == "__main__":
    unittest.main()
