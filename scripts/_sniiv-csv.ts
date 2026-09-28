/**
 * Year flag + input checks shared by the two SNIIV loaders
 * (load-sedatu-financiamientos.ts, load-cnbv-credito.ts), 2026-09-28.
 *
 * SNIIV publishes one CSV per year (the 2026 file is enero–junio). The
 * loaders take `--year=<YYYY>` and build year-suffixed relations from it, so
 * the value is validated here before it reaches any SQL identifier.
 *
 * `\copy ... HEADER true` skips the header row and maps columns by
 * POSITION: a publisher that renames, adds or reorders a column between
 * years would load silently misaligned. checkSniivCsv compares the header
 * with the loader's RAW_HEADER_COLS and every row's `ano` with --year before
 * anything touches the database.
 */

const YEAR_RE = /^20[0-9]{2}$/;

/** `value` when it is a 4-digit 20xx year; throws otherwise. */
export function assertYear(value: string, flag: string): string {
  if (!YEAR_RE.test(value)) {
    throw new Error(`${flag} must be a year matching ^20[0-9]{2}$, got "${value}"`);
  }
  return value;
}

export interface SniivCsvShape {
  rows: number;
  mesMin: number;
  mesMax: number;
}

const cell = (s: string): string => s.trim().replace(/^"(.*)"$/, "$1");

/**
 * Fail loud unless the (UTF-8) CSV's header equals `expectedHeader` exactly
 * (`año` is read as `ano`), every data row's `ano` equals `year`, and every
 * `mes` is an integer 1..12. Returns the row count and the mes range.
 */
export function checkSniivCsv(
  csvUtf8: Buffer,
  expectedHeader: readonly string[],
  year: string,
): SniivCsvShape {
  const lines = csvUtf8.toString("utf-8").split("\n");
  const header = (lines[0] ?? "")
    .replace(/^﻿/, "")
    .replace(/\r$/, "")
    .split(",")
    .map((c) => cell(c).replace(/^año$/, "ano"));
  if (header.join(",") !== expectedHeader.join(",")) {
    const missing = expectedHeader.filter((c) => !header.includes(c));
    const extra = header.filter((c) => !expectedHeader.includes(c));
    const width = Math.max(header.length, expectedHeader.length);
    let at = 0;
    while (at < width && header[at] === expectedHeader[at]) at++;
    throw new Error(
      `CSV header does not match RAW_HEADER_COLS (\\copy maps by position): ` +
        `missing [${missing.join(", ")}], extra [${extra.join(", ")}], ` +
        `first difference at column ${at + 1}: got "${header[at] ?? "<none>"}", expected "${expectedHeader[at] ?? "<none>"}"`,
    );
  }

  let rows = 0;
  let offYear = 0;
  let badMes = 0;
  let firstBad = "";
  let mesMin = Number.POSITIVE_INFINITY;
  let mesMax = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (line === "") continue;
    rows++;
    const [ano = "", mes = ""] = line.split(",", 2).map(cell);
    const m = Number(mes);
    const mesOk = /^[0-9]{1,2}$/.test(mes) && m >= 1 && m <= 12;
    if (ano !== year) offYear++;
    if (!mesOk) badMes++;
    if ((ano !== year || !mesOk) && firstBad === "") {
      firstBad = `line ${i + 1}: ano="${ano}" mes="${mes}"`;
    }
    if (mesOk) {
      mesMin = Math.min(mesMin, m);
      mesMax = Math.max(mesMax, m);
    }
  }
  if (rows === 0) throw new Error("CSV has a header but no data rows");
  if (offYear > 0 || badMes > 0) {
    throw new Error(
      `CSV rows do not match --year=${year}: ${offYear} of ${rows} rows have ano != ${year}, ` +
        `${badMes} have mes outside 1..12 (first: ${firstBad})`,
    );
  }
  return { rows, mesMin, mesMax };
}
