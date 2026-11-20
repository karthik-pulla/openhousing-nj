# Crosswalks

Every dataset joins to `data/geo/municipalities.csv` on **GEOID** (10-digit Census county subdivision). These files connect sources that don't use GEOIDs.

| File | What it is | Edited by |
|---|---|---|
| `overrides.csv` | Hand decisions for regions the rules can't place. Always wins. | **You** |
| `zillow_crosswalk.csv` | Zillow region ID → municipality, one row per link, with the rule used (`method`) | pipeline |
| `zillow_unmatched.csv` | Every Zillow NJ region **not** linked, with the reason | pipeline |
| `zillow_review.csv` | USGS GNIS evidence for unmatched regions (`python scripts/review_unmatched.py zillow`) | script |
| `zillow_unmatched_stats.csv` | Statistical test of each excluded region against its candidate towns: Zillow size rank vs. housing units, and price level vs. ACS (`python scripts/twin_region_stats.py`) | script |
| `nzlud_crosswalk.csv` | NZLUD code → GEOID (joined by FIPS code, name checked) | pipeline |
| `*.meta.json` | Counts: regions in file, linked, unmatched, municipalities covered | pipeline |

## When a refresh logs a new UNMATCHED region

1. Run `python scripts/review_unmatched.py zillow` and open `zillow_review.csv`.
2. If the evidence clearly places the region, add a row to `overrides.csv` with the region **ID** (not its name), the 4-digit `mun_code`, and a note citing the evidence (e.g. the GNIS feature ID).
3. If it can't be placed with confidence, add it with `mun_code` `NONE` and say why. It stays listed as excluded, never silently dropped.
4. Rerun `python -m pipeline.crosswalk zillow` and `python -m pytest`.

Boundaries come from NJOGIS. Unincorporated places come from the 2020 Census (`data/static/census/place_parts_2020.csv`). Community locations come from USGS GNIS.
