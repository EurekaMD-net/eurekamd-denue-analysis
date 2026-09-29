# EIC 2025 municipal loader brief (2026-09-28, read-only recon)

Step 2 of the municipio bridge ruling (`docs/EIC-2025-RECON-2026-09-28.md`
§5, option (b) staged). Source on disk: `raw/eic2025/conjunto_de_datos_eic2025_105_csv.zip`
(8.3 MB, sha256 in `raw/eic2025/SHA256SUMS`; inside: `conjunto_de_datos/conjunto_datos_eic2025_105.csv`
26.9 MB ISO-8859-1, `diccionario_datos/diccionario_datos_eic2025_105.csv` UTF-8, `metadatos/…txt`).

Corrections to the recon doc: 20 renames (13 real + 7 accent fixes: 07008,
18011, 21173, 26003, 26044, 31025, 31094); `*` covers 750 municipios (747 old
keys + 12083/12084/12085); `GRAPROES` is an average (maps directly);
`censo_municipios` has 66 columns (5 identity + 61 data).

## 1. CSV shape (verified)

- 349 columns, unique ASCII names = dictionary mnemonics in order, no BOM.
  First 12: `CVEGEO, CVE_ENT, NOM_ENT, CVE_MUN, NOM_MUN, CVE_LOC, NOM_LOC, ESTIMADOR, POBTOT, POBFEM, POBMAS, P_3YMAS`.
  `CVEGEO` = 9 chars (ENT+MUN+LOC).
- 13,880 data rows, none ragged, LF only, 0 blank fields. ISO-8859-1 (accents
  in names AND in `ESTIMADOR` values: `Error estándar`, `Límite …`,
  `Coeficiente de variación`). 5 quoted lines (20549, name with a comma).
  Longest `NOM_MUN` 76 chars (dictionary says 50).
- Numbers: point decimal, no thousands separator, no negatives; absolutes are
  integers on `Valor` rows, decimals on SE/LI/LS rows. `PHOG_IND`/`PHOG_AFRO`
  carry decimals even on `Valor`.
- `ESTIMADOR` × 2,776 units each: `Valor`, `Error estándar`, `Límite inferior
  de confianza`, `Límite superior de confianza`, `Coeficiente de variación`
  (90 %).
- Geo levels: national `CVE_ENT='00'` (1); entidad `CVE_MUN='000'` (32);
  **municipio `CVE_LOC='0000' AND CVE_MUN NOT IN ('000','997')` (2,478 units,
  12,390 rows)**; entidad totals of localities < 50k `CVE_MUN='997'` (32);
  localities ≥ 50k (233).
- Sentinels: `MI` 8,855 (only the 7 `**` municipios, 253 columns each; their
  88 demographic columns are still populated), `NA` 5,065 (structural zero
  denominators: PNACOP family 125, P3HLI* 39–87, HOG_AFRO 59, HOG_IND 49,
  PCLIM_PMEN 6). Municipio `Valor` rows: 1,771 MI / 1,009 NA.
- `NOM_MUN` suffixes on municipio rows only: none 1,721 · `*` 750 (fully
  enumerated) · `**` 7 (sample too small). `NOM_LOC` = `Total del municipio`.
- POBTOT non-numeric on municipio `Valor` rows: 0.

## 2. Dictionary groups (349 = 8 identity + 46 absolute + 278 `PCN_*` + 17 avg/ratio)

| Group | Absolutes | Percentages (base) | Avg / ratio |
| --- | --- | --- | --- |
| Population/sex/age | POBTOT (private dwellings only), POBFEM, POBMAS, P_3/5/12/15YMAS(_F/_M), P_6A14, POB0_14, POB15_64, POB65_MAS, P_15A49_F | PCN_P_0A4 … PCN_P_75YMAS ×(_F/_M) (POBTOT); groups sum to 100 ± 0.2 | REL_H_M, MEDIANA_*, INDICE_ENV*, RAZON_DEP_* |
| Fertility | — | PCN_HF | PROM_HNV, TGF |
| Migration | PNACOP | PCN_PNACENT/PNACOE/PNACOP (POBTOT); PCN_PNACOP_NAC/_NONAC (PNACOP); PCN_PRES*20 (P_5YMAS; reference **Oct 2020**) | — |
| Ethnicity | HOG_IND, PHOG_IND, HOG_AFRO, PHOG_AFRO | PCN_POB_IND/AFRO (POBTOT); PCN_P3YM_HLI, PCN_P3NHLI_CLI (P_3YMAS); PCN_P3HLINHE, PCN_P3HLI_HE (**indigenous-language speakers**) | — |
| Disability | PCON_DISC, PCON_LIMI, PCLIM_PMEN, PSIND_LIM | PCN_PCON_DISC*, PCN_PCDISC_*, PCN_PCLIM_* | — |
| Education | — | PCN_P3YM_ASIS; PCN_P6A14_NOA; **PNC_**P6A14AN (INEGI typo); PCN_P15YM_AN/SE/EB/EMS/ES/POS (P_15YMAS) | GRAPROES(_F/_M) |
| Employment | POCUPADA | PCN_PEA, PCN_PE_INAC (P_12YMAS); PCN_POCUPADA, PCN_PDESOCUP (PEA); PCN_POCUP_ASA/EMP/CPRO/SPAG (POCUPADA) | — |
| Health | PDER_SS, PUSU_SS | PCN_PDER_SS, PCN_PSINDER, PCN_PcSSyRecAc (mixed case) (POBTOT); PCN_PDER_IMSS/ISTE/IMSSB, PAFIL_PDOM/IPUB/IPRIV/OTRAI (**PDER_SS**); PCN_PUSU_* (PUSU_SS) | — |
| Mobility | — | PCN_PASIS_* ×15 (school attendees); PCN_POCUP_* ×16 (POCUPADA) | — |
| Marital | — | PCN_P12YM_SOLT/CUL/SEPA ×(_F/_M) (P_12YMAS) | — |
| Households/income/food | TOTHOG, HOGJEF_F/_M, POBHOG, PHOGJEF_*, HOG_MEN_ALIM | PCN_HOG_*, PCN_POBHOG_*, PCN_ALIM_*, PCN_ING_*, PCN_DESP_* | — |
| Housing `VPH_*` | VIVPARHAB, **VIVPARHAB_C**, OCUPVIVPAR | PCN_VPH_* ×64 (**base VIVPARHAB_C**) | PROM_OCUP, PRO_OCUP_C |

Identities: TOTHOG = VIVPARHAB; OCUPVIVPAR = POBHOG = POBTOT; POBFEM + POBMAS =
POBTOT. No religion columns. A single "× POBTOT" derivation is wrong for most
families: bases differ (VIVPARHAB_C, PDER_SS, speakers, PEA, P_5YMAS).

## 3. Parity map to `censo_municipios` (every handler-consumed column)

Consumers: `municipioDetailHandler` (analytics.ts ~4538-4557, all columns);
`locustMuniSql` (~4964-4977: cve_mun, nom_mun, pobtot, pea, graproes,
p_12ymas, psinder); `pobtot_muni` (layers-values.ts ~163); six pobtot/nom_mun
joins. D = direct absolute; R = `PCN_X × base / 100` rounded; — = none.

| censo col | Status | EIC source |
| --- | --- | --- |
| cve_mun / entidad / mun / nom_ent | D | CVE_ENT‖CVE_MUN / CVE_ENT / CVE_MUN / NOM_ENT |
| nom_mun | D | NOM_MUN, `*`/`**` stripped (20 names differ from 2020) |
| pobtot / pobfem / pobmas | D | POBTOT / POBFEM / POBMAS (private dwellings only) |
| p_12ymas / p_15ymas | D | P_12YMAS / P_15YMAS |
| p_60ymas | R | (PCN_P_60A64+65A69+70A74+75YMAS) × POBTOT |
| p_18ymas | — | 15–19 is one group |
| pea | R | PCN_PEA × P_12YMAS (12001: 353,004 vs POCUPADA/PCN_POCUPADA 353,012); rates: use PCN_PEA directly |
| pocupada | D | POCUPADA |
| graproes | D | GRAPROES |
| tvivhab | D≈ | VIVPARHAB (Censo includes collective; 12001: 224,027 vs 245,875) |
| tvivpar | — | no uninhabited dwellings |
| pcatolica, pro_crieva, potras_rel, psin_relig | — | no religion data |
| p3ym_hli | R | PCN_P3YM_HLI × P_3YMAS |
| p3hlinhe / p3hli_he | R (2-step) | PCN_P3HLINHE / PCN_P3HLI_HE × p3ym_hli / 100 |
| phog_ind | D | PHOG_IND (NA in 49) |
| pob_afro | R | PCN_POB_AFRO × POBTOT |
| pnacent / pnacoe | R | PCN_PNACENT / PCN_PNACOE × POBTOT |
| pres2015 / presoe15 | R* | PCN_PRESE20 / PCN_PRESOE20 × P_5YMAS — reference 2020: name them `pres2020` / `presoe20` |
| p15ym_an / p15ym_se | R | × P_15YMAS |
| p15pri_in/co, p15sec_in/co | — | only aggregated PCN_P15YM_EB |
| p18ym_pb | — | closest (EMS+ES+POS) × P_15YMAS but 15+ base |
| p12ym_solt / casa / sepa | R | PCN_P12YM_SOLT / CUL / SEPA × P_12YMAS |
| pcon_disc / pcon_limi / psind_lim | D | same names |
| psinder | R | PCN_PSINDER × POBTOT; rates: PCN_PSINDER directly |
| pder_ss | D | PDER_SS |
| pder_imss / pder_iste / pder_imssb / pafil_ipriv | R | × **PDER_SS** |
| pder_segp | R≈ | PCN_PAFIL_IPUB × PDER_SS |
| vph_inter, autom, refri, lavad, hmicro, moto, bici, radio, tv, pc, telef, cel, stvp(TVP) | R | × **VIVPARHAB_C** |
| vph_spmvpi, vph_cvj, vph_snbien | — | not in EIC |

16 direct, 27 derived, 15 without equivalent.

## 4. Schema

- `eic_2025_municipio_raw` (table, staging swap): all 349 TEXT columns from
  the lower-cased header (`pcn_pcssyrecac`), source `cve_mun` renamed `mun`
  in DDL (Censo convention) + generated `cve_mun = cve_ent || mun`; load ALL
  13,880 rows (like `censo_iter`; national/entidad rows serve verification);
  `UNIQUE (cvegeo, estimador)`, index `(cve_mun, estimador) WHERE cve_loc='0000'`.
- `eic_2025_municipio` (view, Valor only, 2,478): filter
  `estimador='Valor' AND cve_loc='0000' AND mun NOT IN ('000','997')`;
  `regexp_replace(nom_mun,'\*+$','')`, `enumeracion_completa` (750),
  `muestra_insuficiente` (7); numeric columns
  `NULLIF(NULLIF(NULLIF(x,''),'MI'),'NA')::numeric`; native `pcn_*` exposed.
- `eic_2025_municipio_moe` (view, 9,912 = 2,478 × 4): `se`, `li90`, `ls90`, `cv`.
- `eic_2025_municipio_censo_parity` (view): the derived absolutes of §3 with
  the correct bases, `pres2020`/`presoe20` names.
- Relation to `municipios_2025`: 1:1 on 2,478 keys; `municipios_2025.pobtot`
  STAYS Censo 2020 (different universe + a sample survey with MOE); EIC is
  exposed as `pobtot_2025` via join, never overwriting. **No EIC view may
  depend on `municipios_2025` or `censo_*`**: `load-censo.ts` drops
  `municipios_2025` without CASCADE, so a dependent view would break every
  Censo reload (join in handlers instead).

## 5. Loader shape (`scripts/load-eic2025.ts`)

1. `--zip=` (default the raw path); sha256 vs `SHA256SUMS`; `PK` magic bytes
   (INEGI decoy-200); `assertSafePath` + container regex as `load-clues.ts`.
2. Extract via `unzip -p` called directly with an argv array (`execFileSync("unzip", ["-p", zip, member])`, no shell; the zip path is absolute and cannot start with `-`).
3. Encoding: host-side `iconv -f ISO-8859-1 -t UTF-8` (`load-sinba.ts:35-43,97`)
   or `\copy … ENCODING 'LATIN1'`; guard: fail on U+FFFD or if
   `Error estándar` is missing after decoding.
4. Header pin `EIC2025_HEADER` (349 exact names) with a test (count, first 8,
   last = `PCN_VPH_ESCRIDES`, equals dictionary mnemonics; identifier regex
   from `load-censo.ts:96`).
5. One `runPsqlScript` transaction (`load-censo.ts:137-150`): staging from
   header → `\copy … WITH (FORMAT csv, HEADER true)` (no NULL option: no
   blanks) → `swapInStagingSql` with explicit `DROP VIEW` of the 3 views →
   generated column + indexes → views from `scripts/migrate-eic2025-views.sql`
   (no BEGIN/COMMIT, no meta-commands) → `postLoadGrants([...])`.
6. `finally` rm the container temp file; `assertRelationsExist`; `EIC_VIEWS`
   constant next to `CENSO_VIEWS`.
7. Allowlists: `sage-role.sql` GRANT lines (views; raw only if Sage should
   see it); `api-role.sql` FOREACH; print the api-role "next:" hint
   (`postLoadGrants` restores only `denue_sage`).
8. Ledger: `record-dataset-version.ts --dataset=eic_2025 --edition=2025
   --source="INEGI EIC 2025 datos abiertos (conjunto_de_datos_eic2025_105, pub. 2026-09-22)" --rows=13880 --apply`.

Verification (confirmed from the CSV): raw 13,880; view 2,478 = 2,478 keys;
moe 9,912; `SUM(pobtot)` over municipios = 130,393,389 = national row = sum
of 32 entidad rows (also POBFEM 67,678,902; P_12YMAS 108,891,526; POCUPADA
58,247,695; PDER_SS 94,573,536; VIVPARHAB 39,699,242); 12001 = 767,454; the 9
new keys: 02007 20,520 · 04013 18,366 · 12082 8,097 · 12083 11,015 · 12084
7,755 · 12085 5,837 · 24059 170,650 · 25019 37,266 · 25020 41,229;
`muestra_insuficiente` 7; `enumeracion_completa` 750; `pobtot IS NULL` 0;
anti-join vs `municipios_2025` = 0 both ways; vs `censo_municipios` = exactly
the 9.

## 6. Data-quality flags

- `**` (7): 07125, 08015, 08047, 13068, 18005, 20140, 20407.
- Smallest POBTOT 20047 = 84; 56 municipios < 500 (Oaxaca, `*`). Largest
  02004 Tijuana 1,999,816.
- POBTOT is estimated: 12001 CV 5.62 % (696,413–838,495); 77 municipios CV >
  15 %; 20275 CV 31.14 %.
- EIC/Censo 2020 ratio median 1.003; lows 05034 0.42, 20119 0.45, 28024
  0.57, 12023 0.62 (parent of 12085); highs 23009 Tulum 1.61, 30120 1.58,
  19025 1.46, 22011 1.41. Any "growth" column carries the universe caveat.
- Source quirks: `PNC_P6A14AN*` typo, `PCN_PcSSyRecAc` mixed case, one
  quoted comma name, NOM_MUN > 50 chars, PHOG_* decimals.

## 7. Loader (implemented)

`scripts/load-eic2025.ts` (+ `scripts/migrate-eic2025-views.sql`, the only
definition of the three views; `EIC_VIEWS` in `scripts/_psql-tx.ts`).
Without `--apply` it is a dry run: every source check (sha256 pin +
`SHA256SUMS`, `PK` magic, ISO-8859-1 decode guards, header = `EIC2025_HEADER`
= dictionary mnemonics, 13,880 rows × 349 fields, the §5 totals) and the SQL
printed; nothing reaches psql. `--apply` runs the same checks, then one
transaction whose closing DO block re-checks §5 in the database (raw 13,880;
2,478 rows = keys; moe 9,912; `pobtot IS NULL` 0; `SUM(pobtot)` 130,393,389 =
national row = 32 entidad rows; 12001; the 9 new keys; `**` 7; `*` 750; keys = `municipios_2025` both
ways, read in the DO block only when that view exists, so no view dependency).
Any failure rolls back and leaves the previous load in place.

```
npx tsx scripts/load-eic2025.ts --dry-run
npx tsx scripts/load-eic2025.ts --apply
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql
npx tsx scripts/record-dataset-version.ts --dataset=eic_2025 --edition=2025 --source="INEGI EIC 2025 datos abiertos (conjunto_de_datos_eic2025_105, pub. 2026-09-22)" --rows=13880 --apply
```

Apply order: load → `api-role.sql` (the load recreates the relations and
`postLoadGrants` restores only `denue_sage`, so `denue_api` needs the re-run)
→ ledger (the loader never writes `dataset_versions`). `--zip=` defaults to
`raw/eic2025/conjunto_de_datos_eic2025_105_csv.zip` under the repo root and
accepts an absolute path. `scripts/migrations/029-eic2025-grants.sql`
re-applies the grants (anon / authenticated / trustr_app none; `denue_sage`
and `denue_api` SELECT) idempotently for a grants audit. No service restart
is needed: no handler reads the EIC relations yet; restart only when a
handler change that reads them ships.
