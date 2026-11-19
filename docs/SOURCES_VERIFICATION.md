# Data source verification

Checked 2026-11-19 by fetching each endpoint and reading each source's own terms page. Re-check before publishing v2 and once a year after that.

| Source | Endpoint verified | NJ coverage | Vintage used | Terms of use | Status |
|---|---|---|---|---|---|
| Census ACS 5-year | `api.census.gov/data/2024/acs/acs5` (2025 not yet released: HTTP 404) | 564/564 (Tavistock and Walpack have no income or rent estimate) | ACS 2020–2024 | U.S. government work, public domain. Cite the Census Bureau. | ✅ Using |
| NJOGIS municipal boundaries | ArcGIS FeatureServer `NJ_Municipal_Boundaries_3424` | 564/564 | Current | NJ state open data | ✅ Using |
| Census 2020 DHC place parts | `api.census.gov/data/2020/dec/dhc`, geography `place/remainder (or part)` | 564/564 | 2020 Census | Public domain | ✅ Using (crosswalk only) |
| USGS GNIS | `prd-tnm.s3.amazonaws.com/.../DomesticNames_NJ_Text.zip` | Statewide | Current | Public domain | ✅ Using (override evidence only) |
| Zillow ZHVI (city) | `files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv` (HTTP 200, 96 MB, through Oct 2026) | 548 NJ regions → 485 towns | Oct 2026 | **Not verified.** zillow.com/research/data and zillow.com/z/corp/terms block automated access (HTTP 403 / bot check). The data page itself shows no terms. | ⚠️ Using locally; **you need to read the terms** before Zillow values go on the public site or in the CSV download |
| Redfin Data Center | Old S3 files (`redfin-public-data.s3…/city_market_tracker*.tsv000.gz`) now return **403 Access Denied**. The new Download Hub (redfin.com/news/data-center/downloads/) builds filtered CSVs from a web form, with no stable file URL. | Cities selectable in the form | n/a | redfin.com/about/terms-of-use §2.3.3–2.3.5: no redistribution or derivative works, no automated querying without prior written permission. No data-specific license found. | ❌ **Not used.** Needs Redfin's written permission. v1 shows Redfin figures; see note below. |
| NJ property tax | `nj.gov/dca/dlgs/resources/Property_Tax_info.shtml` → `Property_Tax/25_data/25taxes.xls`, sheet "Municipal Tax Summary" | 564/564 by MuniCode | Tax year 2025 | NJ public government data. No specific terms stated on the page. | ✅ Using |
| HUD USER API | `huduser.gov/hudapi/public/il/data/{county}99999` and `/fmr/data/...` (token works) | 21/21 counties | FY2026 Income Limits, FY2027 FMRs | huduser.gov/portal/dataset/api-terms-of-service.html: display allowed. **Required notice:** "This product uses the HUD User Data API but is not endorsed or certified by HUD User." Limit 60 calls/min. | ✅ Using |
| FRED MORTGAGE30US | `api.stlouisfed.org/fred/series/observations` (key works) | National | Weekly, latest 2026-11-19 (7.28%) | Series is "Copyrighted: Citation Required" (Freddie Mac PMMS). freddiemac.com/pmms: "may be used with proper attribution". FRED API terms require the notice: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." | ✅ Using |
| NZLUD | `github.com/mtmleczko/nzlud`, `nzlud_muni.csv` | 105/564 | File last changed 2023-03-17. Your copy is byte-identical (SHA-256 `994b7b67…`). | Repo LICENSE is MIT, but it covers "the software"; it doesn't say whether the data is covered. No citation text in the README. evictionlab.org blocks automated access. | ✅ Using with citation; ⚠️ data license unclear |
| Fourth Round obligations | Your PDF: DCA, *Affordable Housing Obligations for 2025-2035 (Fourth Round) Methodology and Background*, created 2024-10-21. Appendix A parsed to `data/static/fourth_round/obligations_dca_2024.csv`. | 564/564 | Oct 2024 DCA calculation | NJ public government document | ✅ Using. Parsed totals match the report's TOTAL row (65,410 / 84,698 / 80,798). |

## Findings that change the plan

1. **Redfin is out.** Its terms bar redistribution and automated access. The planned Zillow → Redfin → ACS priority becomes **Zillow → ACS**, and the "Zillow and Redfin disagree" flag becomes **"Zillow and ACS median value disagree"**. ACS owner-reported value is a different measure, so the threshold needs to be wider. To bring Redfin back, ask Redfin for written permission.
2. **The live v1 site shows Redfin figures.** By the terms above, that may need Redfin's permission too. That's your call; I haven't changed v1.
3. **Urban-aid exemption, confirmed from the state's own document.** Report pp. 9–10: 47 municipalities are Qualified Urban Aid. p. 18: they "received an average allocation factor of 0 since they have no prospective need obligations under the Affordable Housing Law." They **can still have a present need** (Atlantic City: 875).
4. **Obligations are DCA's calculation, not final numbers.** Under P.L.2024, c.2, towns could adopt their own numbers, with disputes going to the Affordable Housing Dispute Resolution Program. Label them "DCA calculated obligation (Oct 2024)". To use adopted or settled numbers instead, edit the CSV and fill in `last_hand_update` in its `.meta.json`.
5. **HUD areas.** Several NJ counties are in Small Area FMR areas (Bergen-Passaic, Monmouth-Ocean, Jersey City, Philadelphia metro). We use the area-wide ("MSA level") FMR and flag it.
6. **Property tax.** The table gives the average bill on a residential property before credits (ANCHOR, Senior Freeze). Deriving an "effective rate" gives absurd values for the mutual-housing townships Winfield (23%) and Audubon Park (6.9%), so the index should use the bill, not a derived rate.

7. **Zillow: the API terms aren't the research-data terms (2026-11-19).** The owner pasted Zillow's "Terms of Use" for the **Zillow API**. That document licenses "Zillow Data" retrieved through the Zillow API by approved licensees holding a ZWSID. Its links point to 2023 archive.org copies, and its copyright line reads 2006-2014. We don't use the API. We download the public research CSV, so these terms don't govern our use. (If they did, they would rule out storing the data, bulk download, and redistribution.) The terms that apply to the research CSVs are still unknown: whatever zillow.com/research/data says about use and attribution, plus Zillow's general Terms of Use. Zillow stays local until those are found.

## Attribution block for the site and the CSV

- Source: U.S. Census Bureau, American Community Survey 2020–2024 5-year estimates.
- Zillow Home Value Index (ZHVI), Zillow Research. *(wording pending your check of Zillow's terms)*
- NJ Department of Community Affairs, 2025 Property Tax Tables; Affordable Housing Obligations for 2025-2035 (Fourth Round), October 2024.
- This product uses the HUD User Data API but is not endorsed or certified by HUD User.
- Freddie Mac, 30-Year Fixed Rate Mortgage Average in the United States [MORTGAGE30US], retrieved from FRED, Federal Reserve Bank of St. Louis. This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.
- Mleczko, M. and Desmond, M. (2023). National Zoning and Land Use Database (NZLUD).
