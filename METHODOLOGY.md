# OpenHousing NJ v2: Methodology

This document specifies every measure, formula, assumption and data source behind OpenHousing NJ v2, plus the rules for flagging uncertain estimates and the known limitations. It describes the code as of the dataset published **2026-11-19**. Where a number can change (rates, data periods, counts), the current value is given and its source of truth is named.

**Sources of truth.** All tunable assumptions live in [`config.yaml`](config.yaml). Each published dataset records the values it used in [`data/published/index_meta.json`](data/published/index_meta.json) and [`data/manifest.json`](data/manifest.json). If this document and those files disagree, the files describe the published numbers.

---

## 1. Research question

> For each of New Jersey's 564 municipalities, how large a share of a typical regional household's income would it take to **own** or to **rent** the typical home there?

Two design choices follow from this.

1. **Regional denominator.** Costs are divided by the **county** median household income, not the municipality's own. Dividing by a town's own income is circular: a town can look affordable *because* only high-income households can live there. The county denominator asks whether households from the surrounding region could afford to live in the town, which is the regional framing of New Jersey's Mount Laurel doctrine. Town-income ratios are published for comparison (`*_town_income` columns) and are never used in a score.
2. **Two markets, two scores.** Ownership and rental affordability are measured and ranked separately, with no combined index. Across municipalities the two rankings are only moderately related (Spearman ρ ≈ 0.54 in the current data).

The **barriers layer** (zoning restrictiveness and affordable-housing obligations) describes possible causes of unaffordability. It is published alongside the scores and is never part of either one.

## 2. Unit of analysis and geography

- **Units:** all 564 New Jersey municipalities, keyed on the 10-digit Census county-subdivision **GEOID** (state 2 + county 3 + county subdivision 5). Every dataset joins on GEOID or a code crosswalked to it, **never on names**: New Jersey reuses names across counties (for example, five municipalities are named "Washington township").
- **Backbone:** [`data/geo/municipalities.csv`](data/geo/municipalities.csv), built from the Census ACS county-subdivision list. Census lists 569 NJ county subdivisions: the 564 municipalities plus five water-only "County subdivisions not defined" rows (code 00000), which are dropped. The backbone is cross-checked against the NJOGIS municipal boundary service, whose features carry both the NJ 4-digit municipal code (`MUN_CODE`) and the Census 2020 GEOID. The build fails unless both sources contain exactly the same 564 GEOIDs, and each `MUN_CODE` county prefix matches the Census county (NJ county code *c* ↔ FIPS 2*c* − 1).
- **Invariant:** every published dataset has exactly 564 rows, and validation enforces it (§9). Towns with no usable data stay in the dataset, with empty values and an "insufficient data" flag.

## 3. Measures

### 3.1 Ownership cost and burden

$$
\text{AnnualOwnershipCost}_m = 12 \cdot P\!\left(L_m, r, n\right) + T_m,\qquad
P(L, r, n) = L\,\frac{r/12}{1-(1+r/12)^{-n}},\qquad L_m = (1-d)\,V_m
$$

$$
\text{OwnershipBurden}_m = \frac{\text{AnnualOwnershipCost}_m}{Y_{c(m)}}
$$

| Symbol | Meaning | Current value / source |
|---|---|---|
| $V_m$ | Typical home value | ACS median value of owner-occupied units (B25077), §3.4 |
| $d$ | Down payment share | 20% (`ownership.down_payment_pct`), so no private mortgage insurance applies |
| $n$ | Number of monthly payments | 360 (30-year fixed; `ownership.loan_term_years`) |
| $r$ | Annual mortgage rate | **7.203%**: mean of the last 4 weekly Freddie Mac PMMS 30-year fixed rates, 2026-10-29 to 2026-11-19 (FRED `MORTGAGE30US`; `sources.fred.trailing_weeks`) |
| $T_m$ | Property tax | Average total residential property tax bill (county + municipal + school), NJ DCA 2025 Property Tax Tables, before credits and deductions |
| $Y_{c(m)}$ | Denominator | Median household income of the municipality's county, ACS B19013 |

**Excluded costs** (so true ownership costs are higher): homeowners insurance, private mortgage insurance, HOA or condo fees, maintenance, utilities, closing costs.

**Why the average bill rather than a rate.** DCA publishes the average bill and the average *assessed* value; dividing the bill by an equalized value gives an effective tax rate (also published, `effective_tax_rate`). For the two mutual-housing municipalities (Winfield, Audubon Park), assessments make that rate implausible (Winfield ≈ 23%), so the index uses the bill directly, as specified.

### 3.2 Rent burden

$$
\text{RentBurden}_m = \frac{12 \cdot R_m}{Y_{c(m)}}
$$

$R_m$ = median gross rent (contract rent plus utilities), ACS B25064.

### 3.3 Context measures (published, **not scored**)

| Column | Definition | Why not scored |
|---|---|---|
| `renters_cost_burdened_share` | Renter households paying ≥ 30% of household income on gross rent ÷ renter households with a computable ratio: ACS B25070 (sum of 30.0–34.9, 35.0–39.9, 40.0–49.9, ≥ 50.0%) ÷ (total − not computed) | It measures residents' outcomes, which depend on residents' incomes, rather than prices. Its rank correlation with the two price burdens is about −0.12 and −0.01, and its sampling error is large in small municipalities (coefficient of variation above 40% for 105 towns). |
| `ownership_burden_town_income`, `rent_burden_town_income` | Same numerators ÷ the municipality's own median household income | Circular (§1). |
| `ownership_burden_ami80`, `rent_burden_ami80`, `*_affordable_at_ami80` | Numerators ÷ HUD's FY2026 low-income limit (80% AMI) for a 4-person household in the county's HUD area. "Affordable" = ≤ 30%. | Describes the population affordable-housing programs serve. Shown as a separate view. |

MOE of the proportion uses the ACS Handbook formula: $\mathrm{MOE}_p = \sqrt{\mathrm{MOE}_{num}^2 - p^2\,\mathrm{MOE}_{den}^2}\,/\,den$, falling back to the ratio formula (plus sign) when the radicand is negative. Numerator and denominator MOEs are root-sum-of-squares of their parts.

### 3.4 Home value source

The configured priority is **Zillow ZHVI → ACS median value** (`ownership.home_value_priority`). Each row records which source and vintage it used (`home_value_source`, `home_value_vintage`).

- **Currently all 561 home values come from ACS.** Zillow's terms for republishing its research data have not been confirmed (`sources.zillow.cleared_for_publication: false`), so the published index excludes Zillow. A build that includes it, kept locally and not committed, changes the ownership ranking little (Spearman ρ = 0.955 against the ACS-only ranking).
- **ACS value** is the median of owner-occupants' own estimates of their home's value, pooled over 2020–2024. It lags current market prices and runs below them; the Zillow/ACS ratio has a median of 1.27 across towns. Burdens are therefore likely understated in level, with less effect on ranks.
- **Zillow, when enabled:** the ZHVI "All Homes (SFR, Condo/Co-op), middle tier, smoothed, seasonally adjusted" city series. Zillow "cities" are often unincorporated communities, so values reach municipalities through a documented crosswalk (§7.1). A municipality uses the Zillow region named after itself if one exists. Otherwise it uses the mean of the community regions inside it, weighted by each community's 2020 Census housing units in the municipality.
- **Redfin is not used.** The planned Zillow → Redfin → ACS cascade dropped Redfin because its public files are no longer downloadable and its terms bar redistribution and automated access (see [`docs/SOURCES_VERIFICATION.md`](docs/SOURCES_VERIFICATION.md)).

### 3.5 Home value history (profile graph; not scored)

Each town profile graphs the ACS median value of owner-occupied homes (B25077) from every 5-year release, 2005–2009 through 2020–2024 (`data/published/home_value_history.csv`). Caveats: consecutive releases overlap by four years, so changes are smoothed and not independent; values are in dollars of each period's final year (not adjusted to today); open-ended top categories changed from $1,000,000+ to $2,000,000+ (top-coded points are flagged); the shaded band is the 90% margin of error. Because a GEOID can be reused for a different area, a year is kept only if Census's name for that GEOID matches today's. This drops Princeton's 2009–2012 values, which describe the former Princeton borough. Pine Valley's 2022 merger into Pine Hill (population about 12) is not detectable this way and is negligible.

## 4. Scores and ranks

Each measure $x$ is converted to an **affordability percentile** across the $N_x$ municipalities that have it:

$$
\text{pctl}_m = 100 - 100\cdot\frac{\operatorname{rank}(x_m) - 0.5}{N_x}
$$

where $\operatorname{rank}$ is ascending, with ties assigned their average rank. This is the midpoint (Hazen) percentile, flipped so that **100 = smallest burden = most affordable**. Missing values receive no rank.

A score is the weighted mean of its measures' percentiles, with weights rescaled over the measures a municipality has:

$$
S_m = \frac{\sum_k w_k\,\text{pctl}_{k,m}\,\mathbb{1}[\text{pctl}_{k,m}\ \text{exists}]}{\sum_k w_k\,\mathbb{1}[\text{pctl}_{k,m}\ \text{exists}]}
$$

| Score | Measures (weights) | Municipalities scored |
|---|---|---|
| Ownership | `ownership_burden` (1) | 561 of 564 |
| Rental | `rent_burden` (1) | 548 of 564 |

With one measure per score, each score equals that measure's percentile. The general form is kept so that measures can be added in `config.yaml` (`index.scores`) without code changes. Ranks: 1 = most affordable; tied scores share the lowest rank (`method="min"`).

**Unscored municipalities.**
- *Ownership* (3): Teterboro, Tavistock and Walpack have no ACS home value.
- *Rental* (16): municipalities with too few renters for ACS to publish a median rent (Buena Vista, Chesilhurst, Tavistock, Cape May Point, Sea Isle City, Shiloh, East Greenwich, Logan, Wenonah, Alexandria, Delaware, Loch Arbour, Barnegat Light, Harvey Cedars, Mantoloking, Walpack). Tavistock and Walpack (population about 4 each) have neither score.

### Worked example: Princeton (Mercer County)

| Step | Value |
|---|---|
| Home value $V$ (ACS median, 2020–2024) | $1,050,600 |
| Loan $L = 0.8\,V$ | $840,480 |
| Monthly P&I at 7.203%, 360 months | $5,706.79 → **$68,481 / yr** |
| Average residential tax bill $T$ (2025) | $23,412 |
| Annual ownership cost | **$91,893** |
| Mercer County median household income $Y$ | $100,645 |
| Ownership burden | 91,893 / 100,645 = **0.913** |
| Rank of burden (ascending, of 561) | 539 → pctl = 100 − 100·(539 − 0.5)/561 = **4.0** |
| Ownership score / rank | **4.0**, 539th of 561 |

## 5. Confidence flags

Each score carries `high`, `medium`, `low` or `insufficient data` (`*_confidence`), with plain-English reasons (`*_confidence_reasons`).

1. **Sampling precision (ACS).** $\mathrm{CV} = (\mathrm{MOE}/1.645)/\text{estimate}$. CV ≤ 12% → high; ≤ 40% → medium; > 40% → low (common ACS reliability tiers; `confidence.cv_high_max`, `cv_medium_max`). A zero estimate has no defined CV and is low.
2. **Source cap.** An ACS home value is at most **medium**, however small its MOE, because it is a five-year owner estimate, not a current market price (`confidence.acs_home_value_max_confidence`). Zillow values, when enabled, are high for a municipality's own region and medium when built from community regions.
3. **Top-coding.** ACS publishes open-ended medians at a ceiling (home value $2,000,001; gross rent $3,501; household income $250,001). A score built on a top-coded value is **low**, and its reason says the true value is "at least" the ceiling. Currently 7 home values and 17 rents are top-coded, and 10 town incomes, which affect only the display-only town-income ratios.
4. **Combination.** A score's flag is the weakest flag among its measures. One missing measure caps it at medium and two or more missing make it low; no measure at all gives "insufficient data" and no score. (With one measure per score, only the last case occurs.)
5. **Source disagreement** (when Zillow is enabled). A municipality is flagged when its Zillow/ACS ratio differs from the statewide median ratio by more than a factor of 1.30 in either direction (`confidence.value_disagreement_factor`). The comparison is relative because ACS runs below Zillow everywhere.

Current distribution: ownership 554 medium, 7 low, 3 insufficient; rental 413 high, 106 medium, 29 low, 16 insufficient.

## 6. Barriers layer (never in a score)

### 6.1 Zoning restrictiveness (NZLUD)

`zri` is the Zoning Restrictiveness Index from the National Zoning and Land Use Database (Mleczko & Desmond 2023), based on municipal surveys from 2019–2022. Higher values mean more restrictive zoning. Coverage is **105 of 564** NJ municipalities (`zoning_data_available`). NZLUD identifies municipalities by state FIPS + the 5-digit FIPS place/county-subdivision code, which joins exactly to the GEOID's last five digits (all 105 matched; names checked). The static file is byte-identical to the upstream repository copy (SHA-256 recorded and re-checked each run).

### 6.2 Fourth Round obligations (NJ DCA, October 2024)

From Appendix A of NJ DCA, *Affordable Housing Obligations for 2025–2035 (Fourth Round) Methodology and Background* (October 2024), calculated under P.L.2024, c.2:

- `present_need`: deficient housing occupied by low- and moderate-income households;
- `prospective_need`: the municipality's allocation of regional prospective need;
- `prospective_need_capped`: after the cap in the state's table ("1,000/20% Cap"), which is the obligation figure used;
- `qualified_urban_aid`: the report's Yes/No column;
- derived: `prospective_need_per_1000_hh` = capped prospective need ÷ ACS households × 1,000, and `total_need_per_1000_hh` = (present + capped prospective) ÷ households × 1,000.

The appendix was extracted from the PDF to [`data/static/fourth_round/obligations_dca_2024.csv`](data/static/fourth_round/obligations_dca_2024.csv). Extraction is refused unless all 564 rows parse and the column totals equal the report's TOTAL row: present need 65,410; prospective need 84,698; capped 80,798. The rows join to GEOIDs on (Census-style name, county), which is unique in NJ, and every row must match exactly one municipality.

**Qualified Urban Aid municipalities** (47; report pp. 9–10) "received an average allocation factor of 0 since they have no prospective need obligations under the Affordable Housing Law" (report p. 18). Their prospective need of 0 is a legal result, not missing data, and they may still have a present need (Atlantic City: 875).

**Interpretation limits.** These are DCA's *calculated* obligations. Municipalities could adopt different figures through the statutory dispute-resolution process, so final obligations may differ. They are obligations, not construction records. OpenHousing has no data on units built and never describes a municipality as having met or failed its obligation; the summary generator rejects such wording.

## 7. Data processing

### 7.1 Name-based crosswalk (Zillow)

Rules apply in order; each link records the rule that made it ([`pipeline/crosswalk.py`](pipeline/crosswalk.py)):

1. **override**: hand-maintained [`data/crosswalks/overrides.csv`](data/crosswalks/overrides.csv), keyed on Zillow's region ID, with a written justification for every row. Most cite a USGS GNIS "Populated Place" whose official point lies inside the municipality (point-in-polygon against NJOGIS boundaries).
2. **muni_full**: the full name, including the type word, equals exactly one municipality's Census name in the same county.
3. **muni_base**: the base name, without the type word, equals exactly one municipality's base name in the county. Borough/township "twins" sharing a name are ambiguous and are never guessed.
4. **census_place**: the name equals a 2020 Census place (usually a CDP) with land in the county. The region is linked to every municipality holding at least 10% of that place's 2020 housing units, recording the housing units for weighting.

Every region is either linked or recorded as unmatched or excluded with a reason; the build fails if any region is unaccounted for. Current file: 548 NJ regions; 540 linked to 485 municipalities; 6 borough/township twins (Chatham, Chester, Freehold, Hopewell, Mendham, Rockaway) left unassigned by decision, because Zillow's region likely spans both; 2 excluded as unplaceable (Asbury, Newfoundland).

### 7.2 Missing data

Missing means missing. ACS "jam" values (large negative codes) become empty, never zero. Nothing is imputed, interpolated or generated. Display layers show "Unavailable" or "No data".

### 7.3 Written summaries

Each municipality's summary is assembled from fixed sentence templates ([`templates/summary_templates.yaml`](templates/summary_templates.yaml)) chosen by deterministic rules (`config.yaml` → `summaries`) and filled with values from the dataset. No language model is involved. Every sentence records the data columns and sources it used. Every statistic in a summary is tagged with the dataset column it came from and its sources; on the site it is underlined, and hovering or focusing it shows the source, data period and retrieval date. Rounding in summaries and on the site: home values and annual costs to the nearest $1,000 (nearest $100 below $100,000), rents to the nearest $10, shares to whole percent, per-1,000 rates to 0.1.

## 8. Sources

Verified 2026-11-19; details and terms in [`docs/SOURCES_VERIFICATION.md`](docs/SOURCES_VERIFICATION.md).

| Source | Used for | Vintage in current data | Access |
|---|---|---|---|
| U.S. Census Bureau, ACS 5-year (tables B19013, B25077, B25064, B25070, B25088, B25003, B25001, B01003) | Incomes, home value, rent, renter burden, households, population, MOEs | ACS 2020–2024 | Census Data API, https://api.census.gov/data/2024/acs/acs5 |
| U.S. Census Bureau, ACS 5-year releases 2005–2009 … 2020–2024 (B25077) | Home value history graph | 2009–2024 releases | Census Data API |
| U.S. Census Bureau, 2020 Census DHC (H1, place parts within county subdivisions) | Crosswalk weights for unincorporated places | 2020 | Census Data API |
| NJOGIS, NJ Municipal Boundaries | GEOID ↔ `MUN_CODE`, map boundaries, GNIS point-in-polygon | Current | https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipal_Boundaries_3424/FeatureServer/0 |
| NJ DCA, Division of Local Government Services, Property Tax Tables | Average residential tax bill | Tax year 2025 | https://www.nj.gov/dca/dlgs/resources/Property_Tax_info.shtml |
| HUD, Income Limits and Fair Market Rents (HUD USER API) | 80% AMI limits; FMRs (context) | FY2026 IL; FY2027 FMR | https://www.huduser.gov/portal/dataset/fmr-api.html |
| Freddie Mac PMMS via FRED (`MORTGAGE30US`) | Mortgage rate | 4-week mean to 2026-11-19 | https://fred.stlouisfed.org/series/MORTGAGE30US |
| Mleczko & Desmond, NZLUD (Eviction Lab, Princeton University) | Zoning restrictiveness | Surveys 2019–2022; file 2023 | https://github.com/mtmleczko/nzlud |
| NJ DCA, Fourth Round Methodology and Background, Appendix A | Present/prospective need, Qualified Urban Aid | October 2024 | Copy in `data/static/fourth_round/` |
| USGS GNIS Domestic Names (NJ) | Evidence for crosswalk overrides only | Current | https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/ |
| Zillow Research, ZHVI (city) | Home value (pending terms) | Not in current published data | https://www.zillow.com/research/data/ |

Required notices: *This product uses the HUD User Data API but is not endorsed or certified by HUD User. This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.*

## 9. Validation before publication

A build is published only if every error-level check passes ([`pipeline/validate.py`](pipeline/validate.py); limits in `config.yaml` → `validation`):

- exactly 564 rows; valid, unique GEOIDs equal to the backbone set;
- column schema unchanged (any change needs explicit approval);
- required fields non-null; optional fields missing for no more towns than allowed;
- values inside hard plausibility limits;
- internal consistency (ranks follow scores; confidence matches missingness; Qualified Urban Aid prospective need = 0; capped ≤ uncapped);
- no Zillow values unless cleared;
- every source fetched successfully;
- no score's coverage drops by more than 10 towns versus the published data;
- the home value history covers every municipality, with no duplicate or implausible values;
- every municipality has a template summary with no unfilled fields or prohibited wording, and every statistic in it is tagged with its sources.

Warnings, which don't block publication, cover score changes of more than 15 points since the last publication and stale sources. If validation fails, the previously published dataset stays live, and the monthly automation opens an issue describing the failure.

## 10. Known limitations

1. **Sampling error in small municipalities.** ACS estimates for towns of a few hundred people carry large MOEs; flags signal this, but ranks among small towns are uncertain.
2. **Home values lag and are self-reported** (ACS 2020–2024 pooled owner estimates). Ownership burdens are likely understated relative to current purchase costs. Ranks are less affected (ρ = 0.955 against a Zillow-based ranking).
3. **Medians and averages.** The "typical" home differs in type and size across towns; average tax bills refer to the average residential property, not the median-value home, and are before credits.
4. **Omitted ownership costs** (insurance, maintenance, HOA, utilities, closing costs) and a single down-payment assumption (20%). Lower down payments would add PMI and raise costs, especially in low-value towns.
5. **One rate for the whole state.** The PMMS national average ignores borrower-specific rates and points.
6. **County denominator.** County incomes mix very different towns; a regional (housing region or HUD area) denominator is a reasonable alternative and would change levels and some ranks.
7. **Second-home markets.** Shore municipalities rank as least affordable to own; their prices likely reflect buyers from outside the county.
8. **Mutual-housing municipalities** (Winfield, Audubon Park) have unusual values and assessments.
9. **Zoning coverage** is 105 of 564 municipalities and dates from 2019–2022.
10. **Obligations** are DCA's October 2024 calculations, not adopted or court-approved figures, and not construction outcomes.
11. **Zillow crosswalk** (when enabled) maps postal-style place names to municipalities; community regions are approximations of municipal areas.

## 11. Reproducibility

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv -r requirements.txt
cp .env.example .env    # add CENSUS_API_KEY, HUD_API_TOKEN, FRED_API_KEY
.venv/bin/python scripts/refresh_data.py
.venv/bin/python -m pytest -q
```

Raw downloads are cached under `data/raw/<source>/<date>/`. Package versions are pinned in `requirements.txt`. Tests include hand-checked cases: a textbook mortgage payment, percentile ties and missing values, per-town recomputation of burdens from raw inputs, and Fourth Round totals against the report.
