/**
 * CLI: load the INEGI Encuesta Intercensal 2025 (EIC) municipal open-data
 * CSV (step 2 of the municipio bridge ruling,
 * docs/EIC-2025-LOADER-BRIEF-2026-09-28.md).
 *
 * Usage:
 *   npx tsx scripts/load-eic2025.ts --dry-run [--zip=<path>]
 *   npx tsx scripts/load-eic2025.ts --apply [--zip=<path>]
 *   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql   (only if a relation is missing from its allowlist)
 *   npx tsx scripts/record-dataset-version.ts --dataset=eic_2025 ... --apply   (line printed at the end)
 *
 *   --zip      conjunto_de_datos_eic2025_105_csv.zip (default
 *              raw/eic2025/... under this repo's root; a relative --zip is
 *              resolved against the cwd). Its sha256 must equal the pinned
 *              EIC2025_ZIP_SHA256 and the SHA256SUMS file next to it.
 *   --dry-run  (the default without --apply) every source check, then print
 *              the SQL script. No docker, no psql.
 *   --apply    load into $SUPABASE_DB_CONTAINER (default supabase-db).
 *
 * How:
 *   1. sha256 + `PK` magic of the zip (INEGI answers some bad URLs with an
 *      HTML page and HTTP 200).
 *   2. `unzip -p` (argv array, no shell) of the CSV and the dictionary.
 *   3. ISO-8859-1 -> UTF-8 on the host with iconv; refuse U+FFFD and require
 *      the literal `Error estándar` (the ESTIMADOR value) after decoding.
 *   4. Header pinned to EIC2025_HEADER (349 names) and to the dictionary's
 *      mnemonics; 13,880 rows of 349 fields, 2,478 municipio Valor rows.
 *   5. ONE psql transaction (runPsqlScript): staging table from the header
 *      (all TEXT, source CVE_MUN renamed `mun`) -> \copy -> explicit DROP of
 *      the three EIC views -> swap -> generated `cve_mun` + UNIQUE (cvegeo,
 *      estimador) + partial index -> views from migrate-eic2025-views.sql ->
 *      postLoadGrants -> DO-block assertion (counts, national total, the 9
 *      new 2025 keys). Any failure rolls everything back.
 *   6. assertRelationsExist; the container temp file is removed in `finally`.
 *
 * The loader does NOT write the dataset_versions ledger; postLoadGrants
 * restores denue_sage and denue_api from this checkout's sage-role.sql /
 * api-role.sql (re-run api-role.sql only if a relation is missing from that
 * allowlist). Run the ledger line it prints. No service restart is needed
 * for the load.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeContainer } from "../src/api/handlers/_safe-container.js";
import {
  assertRelationsExist,
  EIC_VIEWS,
  postLoadGrants,
  runPsqlScript,
  swapInStagingSql,
} from "./_psql-tx.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..");

export const EIC2025_ZIP_NAME = "conjunto_de_datos_eic2025_105_csv.zip";
/** raw/eic2025/SHA256SUMS */
export const EIC2025_ZIP_SHA256 =
  "e6ad7e8f8661f414face015e50e8d95652ab07442e912c76191eefd77defa182";
export const DEFAULT_ZIP = `raw/eic2025/${EIC2025_ZIP_NAME}`;
export const INNER_CSV = "conjunto_de_datos/conjunto_datos_eic2025_105.csv";
export const INNER_DICT = "diccionario_datos/diccionario_datos_eic2025_105.csv";

export const RAW_TABLE = "eic_2025_municipio_raw";
export const STAGING_TABLE = `${RAW_TABLE}_staging`;
/** Path of the decoded CSV inside the DB container (removed in `finally`). */
export const CONTAINER_CSV = "/tmp/eic2025.csv";

export const API_ROLE_LINE =
  "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql";
export const LEDGER_LINE =
  'npx tsx scripts/record-dataset-version.ts --dataset=eic_2025 --edition=2025 --source="INEGI EIC 2025 datos abiertos (conjunto_de_datos_eic2025_105, pub. 2026-09-22)" --rows=13880 --apply';

/** The ESTIMADOR value whose accent proves the ISO-8859-1 decode. */
export const ENCODING_PROBE = "Error estándar";

/** Verified numbers (brief §1 and §5); the DO-block assertion pins them. */
export const EXPECTED = {
  rawRows: 13880,
  municipios: 2478,
  moeRows: 9912,
  pobtotNational: 130393389,
  entidades: 32,
  acapulco12001: 767454,
  muestraInsuficiente: 7,
  enumeracionCompleta: 750,
} as const;

/** The 9 municipios created after Censo 2020, with their EIC POBTOT. */
export const NEW_KEYS_POBTOT: ReadonlyArray<readonly [string, number]> = [
  ["02007", 20520],
  ["04013", 18366],
  ["12082", 8097],
  ["12083", 11015],
  ["12084", 7755],
  ["12085", 5837],
  ["24059", 170650],
  ["25019", 37266],
  ["25020", 41229],
];

/**
 * The CSV header, exact and in order (= the dictionary mnemonics). A new
 * INEGI release that adds, drops or renames a column fails before any SQL.
 */
export const EIC2025_HEADER = [
  "CVEGEO", "CVE_ENT", "NOM_ENT", "CVE_MUN", "NOM_MUN", "CVE_LOC", "NOM_LOC", "ESTIMADOR",
  "POBTOT", "POBFEM", "POBMAS", "P_3YMAS", "P_3YMAS_F", "P_3YMAS_M", "P_5YMAS", "P_5YMAS_F",
  "P_5YMAS_M", "P_12YMAS", "P_12YMAS_F", "P_12YMAS_M", "P_15YMAS", "P_15YMAS_F", "P_15YMAS_M",
  "PCN_P_0A4", "PCN_P_0A4_F", "PCN_P_0A4_M", "PCN_P_5A9", "PCN_P_5A9_F", "PCN_P_5A9_M",
  "PCN_P_10A14", "PCN_P_10A14_F", "PCN_P_10A14_M", "PCN_P_15A19", "PCN_P_15A19_F", "PCN_P_15A19_M",
  "PCN_P_20A24", "PCN_P_20A24_F", "PCN_P_20A24_M", "PCN_P_25A29", "PCN_P_25A29_F", "PCN_P_25A29_M",
  "PCN_P_30A34", "PCN_P_30A34_F", "PCN_P_30A34_M", "PCN_P_35A39", "PCN_P_35A39_F", "PCN_P_35A39_M",
  "PCN_P_40A44", "PCN_P_40A44_F", "PCN_P_40A44_M", "PCN_P_45A49", "PCN_P_45A49_F", "PCN_P_45A49_M",
  "PCN_P_50A54", "PCN_P_50A54_F", "PCN_P_50A54_M", "PCN_P_55A59", "PCN_P_55A59_F", "PCN_P_55A59_M",
  "PCN_P_60A64", "PCN_P_60A64_F", "PCN_P_60A64_M", "PCN_P_65A69", "PCN_P_65A69_F", "PCN_P_65A69_M",
  "PCN_P_70A74", "PCN_P_70A74_F", "PCN_P_70A74_M", "PCN_P_75YMAS", "PCN_P_75YMAS_F",
  "PCN_P_75YMAS_M", "P_6A14", "P_6A14_F", "P_6A14_M", "POB0_14", "POB0_14_F", "POB0_14_M",
  "POB15_64", "POB65_MAS", "P_15A49_F", "REL_H_M", "MEDIANA_POBTOT", "MEDIANA_F", "MEDIANA_M",
  "INDICE_ENV", "INDICE_ENV_F", "INDICE_ENV_M", "RAZON_DEP_TOT", "RAZON_DEP_INF", "RAZON_DEP_VEJ",
  "PROM_HNV", "TGF", "PCN_HF", "PCN_PNACENT", "PCN_PNACENT_F", "PCN_PNACENT_M", "PCN_PNACOE",
  "PCN_PNACOE_F", "PCN_PNACOE_M", "PCN_PNACOP", "PCN_PNACOP_F", "PCN_PNACOP_M", "PNACOP",
  "PCN_PNACOP_NAC", "PCN_PNACOP_NONAC", "PCN_PRESM20", "PCN_PRESOM20", "PCN_PRESE20",
  "PCN_PRESOE20", "PCN_PRESEUA20", "PCN_PRESOP20", "PCN_POB_IND", "PCN_POB_IND_F", "PCN_POB_IND_M",
  "PCN_P3YM_HLI", "PCN_P3YM_HLI_F", "PCN_P3YM_HLI_M", "PCN_P3HLINHE", "PCN_P3HLINHE_F",
  "PCN_P3HLINHE_M", "PCN_P3HLI_HE", "PCN_P3HLI_HE_F", "PCN_P3HLI_HE_M", "PCN_P3NHLI_CLI",
  "HOG_IND", "PHOG_IND", "PCN_POB_AFRO", "PCN_POB_AFRO_F", "PCN_POB_AFRO_M", "HOG_AFRO",
  "PHOG_AFRO", "PCON_DISC", "PCN_PCON_DISC_F", "PCN_PCON_DISC_M", "PCN_PCON_DISC0A14",
  "PCN_PCON_DISC15A29", "PCN_PCON_DISC30A59", "PCN_PCON_DISC60YM", "PCN_PCDISC_VIS",
  "PCN_PCDISC_AUD", "PCN_PCDISC_MOT", "PCN_PCDISC_MEN", "PCN_PCDISC_MOT2", "PCN_PCDISC_LENG",
  "PCON_LIMI", "PCN_PCLIM_VIS", "PCN_PCLIM_OAUD", "PCN_PCLIM_CSB", "PCN_PCLIM_RE_CO",
  "PCN_PCLIM_MOT2", "PCN_PCLIM_HACO", "PCLIM_PMEN", "PSIND_LIM", "PCN_P3YM_ASIS", "PCN_P6A14_NOA",
  "PCN_P6A14_NOA_F", "PCN_P6A14_NOA_M", "PNC_P6A14AN", "PNC_P6A14AN_F", "PNC_P6A14AN_M",
  "PCN_P15YM_AN", "PCN_P15YM_AN_F", "PCN_P15YM_AN_M", "PCN_P15YM_SE", "PCN_P15YM_EB",
  "PCN_P15YM_EMS", "PCN_P15YM_ES", "PCN_P15YM_POS", "GRAPROES", "GRAPROES_F", "GRAPROES_M",
  "PCN_PEA", "PCN_PEA_F", "PCN_PEA_M", "PCN_PE_INAC", "PCN_PE_INAC_F", "PCN_PE_INAC_M", "POCUPADA",
  "PCN_POCUPADA", "PCN_POCUPADA_F", "PCN_POCUPADA_M", "PCN_PDESOCUP", "PCN_PDESOCUP_F",
  "PCN_PDESOCUP_M", "PCN_POCUP_ASA", "PCN_POCUP_EMP", "PCN_POCUP_CPRO", "PCN_POCUP_SPAG",
  "PDER_SS", "PCN_PDER_SS", "PCN_PSINDER", "PCN_PcSSyRecAc", "PCN_PDER_IMSS", "PCN_PDER_ISTE",
  "PCN_PAFIL_PDOM", "PCN_PDER_IMSSB", "PCN_PAFIL_IPUB", "PCN_PAFIL_IPRIV", "PCN_PAFIL_OTRAI",
  "PUSU_SS", "PCN_PUSU_IMSS", "PCN_PUSU_ISTE", "PCN_PUSU_PDOM", "PCN_PUSU_IMSSB", "PCN_PUSU_IPUB",
  "PCN_PUSU_IPRIV", "PCN_PUSU_CFARM", "PCN_PUSU_OTRAI", "PCN_PASIS_ENT", "PCN_PASIS_OENT",
  "PCN_PASIS_15MIN", "PCN_PASIS_30MIN", "PCN_PASIS_1HOR", "PCN_PASIS_1HYM", "PCN_PASIS_CAM",
  "PCN_PASIS_BICI", "PCN_PASIS_MET", "PCN_PASIS_TROL", "PCN_PASIS_TESC", "PCN_PASIS_TAXI",
  "PCN_PASIS_MOTO", "PCN_PASIS_AUTO", "PCN_PASIS_OMED", "PCN_POCUP_ENT", "PCN_POCUP_OENT",
  "PCN_POCUP_15MIN", "PCN_POCUP_30MIN", "PCN_POCUP_1HOR", "PCN_POCUP_2HOR", "PCN_POCUP_2HYM",
  "PCN_POCUP_CAM", "PCN_POCUP_BICI", "PCN_POCUP_MET", "PCN_POCUP_TROL", "PCN_POCUP_TPER",
  "PCN_POCUP_TAXI", "PCN_POCUP_MOTO", "PCN_POCUP_AUTO", "PCN_POCUP_OMED", "PCN_P12YM_SOLT",
  "PCN_P12YM_SOLT_F", "PCN_P12YM_SOLT_M", "PCN_P12YM_CUL", "PCN_P12YM_CUL_F", "PCN_P12YM_CUL_M",
  "PCN_P12YM_SEPA", "PCN_P12YM_SEPA_F", "PCN_P12YM_SEPA_M", "TOTHOG", "HOGJEF_F", "HOGJEF_M",
  "POBHOG", "PHOGJEF_F", "PHOGJEF_M", "PCN_HOG_FAM", "PCN_POBHOG_FAM", "PCN_HOG_NFAM",
  "PCN_POBHOG_NFAM", "PCN_HOG_PERC", "PCN_HOG_NPERC", "PCN_HOG_GOB", "PCN_HOG_JUB", "PCN_HOG_OVIV",
  "PCN_HOG_OPAIS", "PCN_HOG_ALIM_N", "PCN_HOG_ALIM", "PCN_ALIM_ADL1", "PCN_ALIM_ADL2",
  "PCN_ALIM_ADL3", "PCN_ING_ADL1", "PCN_ING_ADL2", "HOG_MEN_ALIM", "PCN_ALIM_MEN1",
  "PCN_ALIM_MEN2", "PCN_ALIM_MEN3", "PCN_ING_MEN1", "PCN_ING_MEN2", "PCN_ING_MEN3",
  "PCN_DESP_INSEG", "PCN_DESP_CATAS", "VIVPARHAB", "VIVPARHAB_C", "OCUPVIVPAR", "PROM_OCUP",
  "PRO_OCUP_C", "PCN_VPH_2_5OCU", "PCN_VPH_PDESH", "PCN_VPH_PASB", "PCN_VPH_PMAD", "PCN_VPH_PTAB",
  "PCN_VPH_TDESH", "PCN_VPH_TASB", "PCN_VPH_TLOSA", "PCN_VPH_TOTRO", "PCN_VPH_PISOTI",
  "PCN_VPH_PISOCEM", "PCN_VPH_PISOMAD", "PCN_VPH_1CUART", "PCN_VPH_2CUART", "PCN_VPH_3YMASC",
  "PCN_VPH_1DOR", "PCN_VPH_2YMASD", "PCN_VPH_CINT", "PCN_VPH_CSEP", "PCN_VPH_COTRO",
  "PCN_VPH_COMGAS", "PCN_VPH_COMELE", "PCN_VPH_C_ELEC", "PCN_VPH_AGUADV", "PCN_VPH_DRENAJ",
  "PCN_VPH_C_SERV", "PCN_VPH_EXCSA", "PCN_VPH_DSADMA", "PCN_VPH_TINACO", "PCN_VPH_CISTER",
  "PCN_VPH_BOMBA", "PCN_VPH_REGA", "PCN_VPH_BOILER", "PCN_VPH_SOLAR", "PCN_VPH_AIRE",
  "PCN_VPH_PANEL", "PCN_VPH_ORGANI", "PCN_VPH_ANIMAL", "PCN_VPH_PLANTA", "PCN_VPH_VENDER",
  "PCN_VPH_CAMBASU", "PCN_VPH_CNTBASU", "PCN_VPH_ELIMBAS", "PCN_VPH_REFRI", "PCN_VPH_LAVAD",
  "PCN_VPH_HMICRO", "PCN_VPH_AUTOM", "PCN_VPH_MOTO", "PCN_VPH_BICI", "PCN_VPH_RADIO", "PCN_VPH_TV",
  "PCN_VPH_PC", "PCN_VPH_TELEF", "PCN_VPH_CEL", "PCN_VPH_INTER", "PCN_VPH_TVP", "PCN_VPH_PROPIA",
  "PCN_VPH_ALQUI", "PCN_VPH_PREST", "PCN_VPH_OTRASIT", "PCN_VPH_PROPRESI", "PCN_VPH_PERNORES",
  "PCN_VPH_NOESCRI", "PCN_VPH_ESCRIDES",
] as const;

/** The 8 identity columns; the other 341 are numeric (or MI / NA). */
export const IDENTITY_COLUMNS = 8;

/** Lower-cased SQL column names; source CVE_MUN -> `mun` (Censo convention). */
export function sqlColumnNames(header: readonly string[] = EIC2025_HEADER): string[] {
  return header.map((c) => {
    const lc = c.toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(lc)) {
      throw new Error(`load-eic2025: unsafe column name "${c}"`);
    }
    return lc === "cve_mun" ? "mun" : lc;
  });
}

/** Throws unless `header` is exactly EIC2025_HEADER. */
export function assertHeader(header: readonly string[]): void {
  if (header.length !== EIC2025_HEADER.length) {
    throw new Error(`load-eic2025: header has ${header.length} columns, expected ${EIC2025_HEADER.length}`);
  }
  const diff = EIC2025_HEADER.flatMap((c, i) => (header[i] === c ? [] : [`#${i + 1} "${header[i]}" != "${c}"`]));
  if (diff.length > 0) {
    throw new Error(`load-eic2025: header differs from EIC2025_HEADER: ${diff.slice(0, 5).join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface LoaderArgs {
  zip: string;
  apply: boolean;
}

export function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-") || !p.startsWith("/") || /[\0\n\r]/.test(p)) {
    throw new Error(`load-eic2025: ${label} inválido "${p}" (absolute path, not starting with '-')`);
  }
}

export function parseArgs(argv: readonly string[], cwd = process.cwd()): LoaderArgs {
  let zip: string | undefined;
  let apply = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--zip=")) zip = arg.slice("--zip=".length);
    else throw new Error(`load-eic2025: unknown argument "${arg}"`);
  }
  if (apply && dryRun) throw new Error("load-eic2025: --apply and --dry-run are exclusive");
  if (zip !== undefined && (zip.length === 0 || zip.startsWith("-"))) {
    throw new Error(`load-eic2025: --zip inválido "${zip}"`);
  }
  const abs = zip === undefined ? join(REPO_ROOT, DEFAULT_ZIP) : resolve(cwd, zip);
  assertSafePath("--zip", abs);
  return { zip: abs, apply };
}

// ---------------------------------------------------------------------------
// Source checks
// ---------------------------------------------------------------------------

/** sha256 must match the pin and, when present, the SHA256SUMS next to the zip. */
export function assertZipIdentity(zip: string): string {
  const bytes = readFileSync(zip);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`load-eic2025: ${zip} is not a zip (no PK magic; INEGI decoy page?)`);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== EIC2025_ZIP_SHA256) {
    throw new Error(`load-eic2025: sha256 ${sha}, expected ${EIC2025_ZIP_SHA256}`);
  }
  const sums = join(dirname(zip), "SHA256SUMS");
  if (existsSync(sums)) {
    const listed = readFileSync(sums, "utf-8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2 && basename(p[1] ?? "") === basename(zip))
      .map((p) => p[0]);
    if (listed.length === 0 || listed.some((h) => h !== sha)) {
      throw new Error(`load-eic2025: ${sums} does not list ${basename(zip)} with sha256 ${sha}`);
    }
  }
  return sha;
}

function unzipMember(zip: string, member: string): Buffer {
  assertSafePath("zip", zip);
  return execFileSync("unzip", ["-p", zip, member], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
}

/** ISO-8859-1 -> UTF-8 with iconv, then the two decode guards. */
export function decodeLatin1(bytes: Buffer): string {
  const utf8 = execFileSync("iconv", ["-f", "ISO-8859-1", "-t", "UTF-8"], {
    input: bytes,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const text = utf8.toString("utf-8");
  assertDecoded(text);
  return text;
}

export function assertDecoded(text: string): void {
  if (text.includes("�")) {
    throw new Error("load-eic2025: U+FFFD after decoding (source is not clean ISO-8859-1)");
  }
  if (!text.includes(ENCODING_PROBE)) {
    throw new Error(`load-eic2025: "${ENCODING_PROBE}" not found after decoding (wrong source encoding?)`);
  }
}

/** Minimal RFC 4180 reader (quoted fields, doubled quotes, LF or CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("load-eic2025: unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Dictionary rows are `<n>,<indicador>,<descripción>,<MNEMÓNICO>,<rangos>,<long>`. */
export function dictionaryMnemonics(dictText: string): string[] {
  return parseCsv(dictText.replace(/^﻿/, ""))
    .filter((r) => /^\d+$/.test((r[0] ?? "").trim()) && (r[3] ?? "").trim() !== "")
    .map((r) => (r[3] ?? "").trim());
}

export interface SourceStats {
  rows: number;
  mi: number;
  na: number;
  municipioValor: number;
  municipioKeys: number;
  municipioRows: number;
  pobtotSum: number;
  pobtotNational: number | null;
  pobtotNull: number;
  enumeracionCompleta: number;
  muestraInsuficiente: number;
  municipioValorMi: number;
  municipioValorNa: number;
  byKey: Map<string, number | null>;
}

const NUM_RE = /^\d+(\.\d+)?$/;

/** Host-side counts over the parsed rows (header excluded); rejects ragged rows and stray values. */
export function sourceStats(rows: readonly string[][]): SourceStats {
  const ix = (c: string): number => EIC2025_HEADER.indexOf(c as (typeof EIC2025_HEADER)[number]);
  const [iEnt, iMun, iNom, iLoc, iEst, iPob] = ["CVE_ENT", "CVE_MUN", "NOM_MUN", "CVE_LOC", "ESTIMADOR", "POBTOT"].map(ix) as [
    number, number, number, number, number, number,
  ];
  const s: SourceStats = {
    rows: rows.length, mi: 0, na: 0, municipioValor: 0, municipioKeys: 0, municipioRows: 0,
    pobtotSum: 0, pobtotNational: null, pobtotNull: 0, enumeracionCompleta: 0, muestraInsuficiente: 0,
    municipioValorMi: 0, municipioValorNa: 0, byKey: new Map(),
  };
  rows.forEach((r, n) => {
    if (r.length !== EIC2025_HEADER.length) {
      throw new Error(`load-eic2025: data row ${n + 1} has ${r.length} fields, expected ${EIC2025_HEADER.length}`);
    }
    let mi = 0;
    let na = 0;
    for (let i = IDENTITY_COLUMNS; i < r.length; i++) {
      const v = r[i] as string;
      if (v === "MI") mi++;
      else if (v === "NA") na++;
      else if (!NUM_RE.test(v)) {
        throw new Error(`load-eic2025: row ${n + 1} ${EIC2025_HEADER[i]} = "${v}" is neither numeric nor MI/NA`);
      }
    }
    s.mi += mi;
    s.na += na;
    const ent = r[iEnt] as string;
    const mun = r[iMun] as string;
    const valor = r[iEst] === "Valor";
    if (ent === "00" && valor) s.pobtotNational = NUM_RE.test(r[iPob] as string) ? Number(r[iPob]) : null;
    if (r[iLoc] !== "0000" || mun === "000" || mun === "997") return;
    s.municipioRows++;
    if (!valor) return;
    s.municipioValor++;
    s.municipioValorMi += mi;
    s.municipioValorNa += na;
    const nom = r[iNom] as string;
    if (/\*\*$/.test(nom)) s.muestraInsuficiente++;
    else if (/\*$/.test(nom)) s.enumeracionCompleta++;
    const pob = r[iPob] as string;
    const val = NUM_RE.test(pob) ? Number(pob) : null;
    if (val === null) s.pobtotNull++;
    else s.pobtotSum += val;
    s.byKey.set(ent + mun, val);
  });
  s.municipioKeys = s.byKey.size;
  return s;
}

/** Host-side preflight: the same numbers the in-transaction assertion checks. */
export function assertSourceStats(s: SourceStats): void {
  const problems: string[] = [];
  const eq = (label: string, got: unknown, want: unknown): void => {
    if (got !== want) problems.push(`${label} = ${String(got)}, expected ${String(want)}`);
  };
  eq("data rows", s.rows, EXPECTED.rawRows);
  eq("municipio Valor rows", s.municipioValor, EXPECTED.municipios);
  eq("distinct municipio keys", s.municipioKeys, EXPECTED.municipios);
  eq("municipio precision rows", s.municipioRows - s.municipioValor, EXPECTED.moeRows);
  eq("POBTOT NULL (MI/NA) on municipio Valor rows", s.pobtotNull, 0);
  eq("SUM(POBTOT) over municipios", s.pobtotSum, EXPECTED.pobtotNational);
  eq("national POBTOT", s.pobtotNational, EXPECTED.pobtotNational);
  eq("12001 POBTOT", s.byKey.get("12001"), EXPECTED.acapulco12001);
  for (const [k, v] of NEW_KEYS_POBTOT) eq(`${k} POBTOT`, s.byKey.get(k), v);
  eq("muestra_insuficiente (**)", s.muestraInsuficiente, EXPECTED.muestraInsuficiente);
  eq("enumeracion_completa (*)", s.enumeracionCompleta, EXPECTED.enumeracionCompleta);
  if (problems.length > 0) throw new Error(`load-eic2025: source check failed: ${problems.join("; ")}`);
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

/** migrate-eic2025-views.sql verbatim (no BEGIN/COMMIT, no meta-commands). */
export function eicViewsSql(): string {
  return readFileSync(join(SCRIPTS_DIR, "migrate-eic2025-views.sql"), "utf-8");
}

export function stagingDdl(header: readonly string[] = EIC2025_HEADER): string {
  const cols = sqlColumnNames(header).map((c) => `  "${c}" TEXT`).join(",\n");
  return `DROP TABLE IF EXISTS ${STAGING_TABLE};\nCREATE TABLE ${STAGING_TABLE} (\n${cols}\n);`;
}

/** Views depend on each other (parity -> municipio), so drop in this order. */
export function dropViewsSql(): string[] {
  return [...EIC_VIEWS].reverse().map((v) => `DROP VIEW IF EXISTS ${v};`);
}

export const POST_SWAP_SQL = `
ALTER TABLE ${RAW_TABLE} ADD COLUMN cve_mun TEXT GENERATED ALWAYS AS (cve_ent || mun) STORED;
ALTER TABLE ${RAW_TABLE} ADD CONSTRAINT ${RAW_TABLE}_cvegeo_estimador_key UNIQUE (cvegeo, estimador);
-- Serves the municipio views (their filter is cve_loc = '0000').
CREATE INDEX idx_${RAW_TABLE}_cve_mun ON ${RAW_TABLE} (cve_mun, estimador) WHERE cve_loc = '0000';
COMMENT ON TABLE ${RAW_TABLE} IS 'INEGI Encuesta Intercensal 2025, principales resultados (conjunto_de_datos_eic2025_105, pub. 2026-09-22), all 13,880 rows verbatim as TEXT (national, entidad, municipio, localidades >= 50k; 5 estimators each). Source ${EIC2025_ZIP_NAME} sha256 ${EIC2025_ZIP_SHA256}. Loaded by scripts/load-eic2025.ts; typed views eic_2025_municipio / _moe / _censo_parity.';
ANALYZE ${RAW_TABLE};
`;

/** In-transaction checks; any failure raises and rolls the whole load back. */
export function assertionSql(): string {
  const keys = NEW_KEYS_POBTOT.map(([k, v]) => `('${k}', ${v})`).join(", ");
  const [vMun, vMoe] = [EIC_VIEWS[0], EIC_VIEWS[1]];
  return `DO $$
DECLARE
  n bigint; d bigint; s numeric; nat numeric; ent numeric; bad text;
BEGIN
  SELECT count(*) INTO n FROM ${RAW_TABLE};
  IF n <> ${EXPECTED.rawRows} THEN
    RAISE EXCEPTION '${RAW_TABLE}: % rows, expected ${EXPECTED.rawRows}', n;
  END IF;
  SELECT count(*), count(DISTINCT cve_mun) INTO n, d FROM ${vMun};
  IF n <> ${EXPECTED.municipios} OR d <> ${EXPECTED.municipios} THEN
    RAISE EXCEPTION '${vMun}: % rows / % distinct cve_mun, expected ${EXPECTED.municipios} / ${EXPECTED.municipios}', n, d;
  END IF;
  SELECT count(*) INTO n FROM ${vMoe};
  IF n <> ${EXPECTED.moeRows} THEN
    RAISE EXCEPTION '${vMoe}: % rows, expected ${EXPECTED.moeRows} (2,478 x se/li90/ls90/cv; encoding of ESTIMADOR?)', n;
  END IF;
  SELECT count(*) INTO n FROM ${vMun} WHERE pobtot IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '${vMun}: % municipios with pobtot IS NULL, expected 0', n;
  END IF;
  SELECT sum(pobtot) INTO s FROM ${vMun};
  IF s IS DISTINCT FROM ${EXPECTED.pobtotNational} THEN
    RAISE EXCEPTION '${vMun}: SUM(pobtot) = %, expected ${EXPECTED.pobtotNational}', s;
  END IF;
  SELECT pobtot::numeric INTO nat FROM ${RAW_TABLE}
   WHERE cvegeo = '000000000' AND estimador = 'Valor';
  IF nat IS DISTINCT FROM s THEN
    RAISE EXCEPTION '${RAW_TABLE}: national POBTOT = %, municipio sum = %', nat, s;
  END IF;
  SELECT count(*), sum(pobtot::numeric) INTO n, ent FROM ${RAW_TABLE}
   WHERE cve_ent <> '00' AND mun = '000' AND cve_loc = '0000' AND estimador = 'Valor';
  IF n <> ${EXPECTED.entidades} OR ent IS DISTINCT FROM s THEN
    RAISE EXCEPTION '${RAW_TABLE}: % entidad rows summing %, expected ${EXPECTED.entidades} summing %', n, ent, s;
  END IF;
  SELECT pobtot INTO s FROM ${vMun} WHERE cve_mun = '12001';
  IF s IS DISTINCT FROM ${EXPECTED.acapulco12001} THEN
    RAISE EXCEPTION '${vMun}: 12001 pobtot = %, expected ${EXPECTED.acapulco12001}', s;
  END IF;
  SELECT string_agg(k.cve || '=' || coalesce(m.pobtot::text, 'absent'), ' ' ORDER BY k.cve) INTO bad
    FROM (VALUES ${keys}) AS k(cve, pobtot)
    LEFT JOIN ${vMun} m ON m.cve_mun = k.cve
   WHERE m.pobtot IS DISTINCT FROM k.pobtot;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '${vMun}: new 2025 municipios wrong or absent: %', bad;
  END IF;
  SELECT count(*) INTO n FROM ${vMun} WHERE muestra_insuficiente;
  IF n <> ${EXPECTED.muestraInsuficiente} THEN
    RAISE EXCEPTION '${vMun}: muestra_insuficiente = %, expected ${EXPECTED.muestraInsuficiente}', n;
  END IF;
  SELECT count(*) INTO n FROM ${vMun} WHERE enumeracion_completa;
  IF n <> ${EXPECTED.enumeracionCompleta} THEN
    RAISE EXCEPTION '${vMun}: enumeracion_completa = %, expected ${EXPECTED.enumeracionCompleta}', n;
  END IF;
  -- Same 2,478 keys as the canonical universe view. A read inside a DO
  -- block creates no view dependency, so a Censo reload can still drop that
  -- view; the check is skipped while it does not exist.
  IF to_regclass('public.municipios_2025') IS NOT NULL THEN
    SELECT count(*) INTO n FROM ${vMun} e
     WHERE NOT EXISTS (SELECT 1 FROM public.municipios_2025 m WHERE m.cve_mun = e.cve_mun);
    SELECT count(*) INTO d FROM public.municipios_2025 m
     WHERE NOT EXISTS (SELECT 1 FROM ${vMun} e WHERE e.cve_mun = m.cve_mun);
    IF n <> 0 OR d <> 0 THEN
      RAISE EXCEPTION '${vMun}: % keys not in municipios_2025, % municipios_2025 keys not in EIC, expected 0 / 0', n, d;
    END IF;
  ELSE
    RAISE NOTICE 'eic2025: municipios_2025 absent, key anti-join skipped';
  END IF;
  RAISE NOTICE 'eic2025: OK ${EXPECTED.rawRows} raw rows, ${EXPECTED.municipios} municipios, ${EXPECTED.moeRows} moe rows, SUM(pobtot) ${EXPECTED.pobtotNational} = national = entidades';
END $$;`;
}

/** Every relation the load (re)creates; grants and existence checks use it. */
export const LOADED_RELATIONS = [RAW_TABLE, ...EIC_VIEWS] as const;

/** The single-transaction reload script (runPsqlScript adds --single-transaction). */
export function buildReloadSql(header: readonly string[] = EIC2025_HEADER): string {
  return [
    "SET client_encoding = 'UTF8';",
    "SET LOCAL lock_timeout = '10s';",
    "SET LOCAL statement_timeout = '10min';",
    // supabase-db has a 64 MB /dev/shm: no parallel workers.
    "SET LOCAL max_parallel_workers_per_gather = 0;",
    stagingDdl(header),
    `\\copy ${STAGING_TABLE} FROM '${CONTAINER_CSV}' WITH (FORMAT csv, HEADER true)`,
    swapInStagingSql(RAW_TABLE, dropViewsSql()),
    POST_SWAP_SQL,
    eicViewsSql(),
    postLoadGrants([...LOADED_RELATIONS]),
    assertionSql(),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const log = (msg: string): void => console.log(`[load-eic2025] ${msg}`);

export interface Prepared {
  csv: string;
  stats: SourceStats;
}

/** Every host-side check; returns the decoded UTF-8 CSV. */
export function prepareSource(zip: string): Prepared {
  if (!existsSync(zip) || !statSync(zip).isFile()) throw new Error(`load-eic2025: zip not found: ${zip}`);
  log(`zip ${zip} (${statSync(zip).size.toLocaleString()} B)`);
  assertZipIdentity(zip);
  log("sha256 + PK magic OK");
  const csv = decodeLatin1(unzipMember(zip, INNER_CSV));
  log(`decoded ISO-8859-1 -> UTF-8 (${Buffer.byteLength(csv).toLocaleString()} B); no U+FFFD; "${ENCODING_PROBE}" present`);
  const rows = parseCsv(csv);
  const header = rows.shift() ?? [];
  assertHeader(header);
  const dict = dictionaryMnemonics(unzipMember(zip, INNER_DICT).toString("utf-8"));
  if (dict.join(",") !== EIC2025_HEADER.join(",")) {
    throw new Error(`load-eic2025: dictionary mnemonics (${dict.length}) differ from the CSV header`);
  }
  log(`header OK: ${header.length} columns = EIC2025_HEADER = dictionary mnemonics`);
  const stats = sourceStats(rows);
  assertSourceStats(stats);
  log(`rows ${stats.rows.toLocaleString()} (349 fields each); sentinels MI ${stats.mi.toLocaleString()} / NA ${stats.na.toLocaleString()}`);
  log(`municipios ${stats.municipioValor.toLocaleString()} Valor rows / ${stats.municipioKeys.toLocaleString()} keys; ${(stats.municipioRows - stats.municipioValor).toLocaleString()} precision rows; Valor MI ${stats.municipioValorMi.toLocaleString()} / NA ${stats.municipioValorNa.toLocaleString()}`);
  log(`SUM(POBTOT) ${stats.pobtotSum.toLocaleString()} = national ${String(stats.pobtotNational?.toLocaleString())}; 12001 ${String(stats.byKey.get("12001")?.toLocaleString())}; * ${stats.enumeracionCompleta} / ** ${stats.muestraInsuficiente}`);
  log(`new 2025 keys: ${NEW_KEYS_POBTOT.map(([k]) => `${k} ${String(stats.byKey.get(k))}`).join(" · ")}`);
  return { csv, stats };
}

function countOf(container: string, sql: string): number {
  const out = execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
    { encoding: "utf-8", timeout: 60_000 },
  ).trim();
  const n = Number.parseInt(out, 10);
  if (!Number.isFinite(n)) throw new Error(`load-eic2025: unexpected count output "${out}"`);
  return n;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  const { csv } = prepareSource(args.zip);
  const sql = buildReloadSql();

  if (!args.apply) {
    log(`dry run: SQL script (${Buffer.byteLength(sql).toLocaleString()} B), \\copy reads ${CONTAINER_CSV}:`);
    console.log(sql);
    log("dry run done; nothing sent to psql. Re-run with --apply to load.");
    return;
  }

  const container = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  assertSafeContainer(container);
  const hostDir = mkdtempSync(join(tmpdir(), "eic2025-"));
  const hostCsv = join(hostDir, "eic2025.csv");
  let out = "";
  try {
    writeFileSync(hostCsv, csv, "utf-8");
    execFileSync("docker", ["cp", "--", hostCsv, `${container}:${CONTAINER_CSV}`], { encoding: "utf-8", timeout: 60_000 });
    log(`copied decoded CSV to ${container}:${CONTAINER_CSV}; loading (one transaction) ...`);
    out = runPsqlScript(container, sql, 15 * 60_000);
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
    try {
      execFileSync("docker", ["exec", container, "rm", "-f", CONTAINER_CSV], { encoding: "utf-8", timeout: 30_000 });
    } catch {
      // best effort: never mask the real error
    }
  }
  log(out.match(/^COPY \d+$/m)?.[0] ?? "COPY ?");
  assertRelationsExist(container, [...LOADED_RELATIONS]);
  const raw = countOf(container, `SELECT count(*) FROM ${RAW_TABLE};`);
  const mun = countOf(container, `SELECT count(*) FROM ${EIC_VIEWS[0]};`);
  log(`committed: ${RAW_TABLE} ${raw.toLocaleString()} rows, ${EIC_VIEWS[0]} ${mun.toLocaleString()} municipios (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  log(`next (only if a relation is missing from api-role.sql's allowlist; postLoadGrants restores denue_sage and denue_api): ${API_ROLE_LINE}`);
  log(`then: ${LEDGER_LINE}`);
}

const isMain = import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[load-eic2025] ✗ ${msg}`);
    process.exit(1);
  });
}
