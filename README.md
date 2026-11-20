# OpenHousing NJ

**How affordable is it to own, or to rent, a home in each of New Jersey's 564 municipalities?**

OpenHousing NJ is a free, open map and dataset that answers that question for every municipality in the state, with every number traceable to its source. It is built for housing advocates, researchers, policy analysts and residents.

- **Live site (v1):** https://karthik-pulla.github.io/nj-housing-index/
- **v2 preview:** `/v2/` (landing page) and `/v2/map.html` (the map) on the same site once published (this branch)
- **How it's calculated:** [METHODOLOGY.md](METHODOLOGY.md), or the plain-English [v2 methodology page](v2/methodology.html)
- **Download the data:** [data/published/openhousing_nj.csv](data/published/openhousing_nj.csv), one row per municipality

## What it shows

| | |
|---|---|
| **Ownership affordability score** | Yearly cost of owning the typical home (mortgage at today's rate + the town's average property tax bill) as a share of **county** median household income, ranked as a 0–100 percentile |
| **Rental affordability score** | Yearly median rent as a share of county median household income, ranked the same way |
| **Context** (not scored) | Share of renters paying 30%+ of income; whether a household at HUD's 80% income limit could afford the typical home or rent; burdens using the town's own income |
| **Barriers** (never in the scores) | Zoning restrictiveness (NZLUD, 105 towns); Fourth Round present and prospective need (NJ DCA, Oct 2024), per 1,000 households; Qualified Urban Aid status |
| **Confidence flags** | High / medium / low / insufficient data for every score, with the reason. Small towns are flagged, never dropped. |
| **Town summaries** | Plain-English paragraphs assembled from fixed templates and the town's numbers. No AI writes them. |

The v2 site has a short home page (what OpenHousing is, what it does, how), separate Methodology, Sources and Data pages, and a map app with layer switching, a "New Jersey" reset button, an NJ snapshot, town profiles with sources and data periods, side-by-side comparison of up to three towns, favorites, CSV downloads, a sortable table view, keyboard navigation and a color-blind-safe palette. It is a static site with no accounts, no tracking and no backend.

## Data sources

U.S. Census Bureau (American Community Survey, 2020 Census) · NJ Department of Community Affairs (Property Tax Tables; Fourth Round obligations) · HUD (Income Limits, Fair Market Rents) · Freddie Mac PMMS via FRED (mortgage rate) · National Zoning and Land Use Database (Eviction Lab, Princeton) · NJOGIS (boundaries). Zillow home values are wired in but held back until Zillow's terms are confirmed. Redfin is not used. Details, data periods and terms: [docs/SOURCES_VERIFICATION.md](docs/SOURCES_VERIFICATION.md).

*This product uses the HUD User Data API but is not endorsed or certified by HUD User. This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.*

## Repository layout

```
config.yaml                  every assumption: weights, mortgage terms, confidence rules, validation limits
scripts/refresh_data.py      one command: rebuild everything from the sources
pipeline/
  geography.py               the 564-municipality backbone, keyed on Census GEOID
  crosswalk.py               name-based sources (Zillow) and NZLUD -> GEOID
  fetchers/                  one module per source (acs, zillow, property_tax, hud, fred, nzlud, fourth_round)
  index.py                   scores, ranks, confidence flags, barriers layer
  summaries.py               template summaries (wording in templates/summary_templates.yaml)
  validate.py                checks; publishes only if they pass; writes data/manifest.json
data/
  geo/                       municipalities.csv (backbone)
  crosswalks/                Zillow + NZLUD crosswalks, overrides.csv (hand-maintained), unmatched logs
  static/                    files with no API: NZLUD, Fourth Round CSV + source PDF, 2020 Census place parts
  interim/                   one tidy table per source, each with a .meta.json (vintage, source, coverage)
  build/                     latest build + validation report (not yet published)
  published/                 the validated, live dataset (CSV, web JSON, summaries)
  manifest.json              sources, vintages, fetch times, coverage, validation results
  raw/                       cached downloads (gitignored)
v2/                          the v2 website: index.html (home), map.html (map app), methodology.html, sources.html,
                             data.html; app.js/app.css (map + shared styles), pages.js/pages.css (text pages),
                             data/boundaries.geojson
tests/                       pytest suite
docs/                        AUTOMATION.md, SOURCES_VERIFICATION.md
legacy/                      the first prototype, kept for reference
index.html, app.html, ...    the live v1 site (unchanged)
```

## Run it locally

You need Python 3.12 (via [uv](https://docs.astral.sh/uv/) or similar) and three free API keys (where to get them: [docs/AUTOMATION.md](docs/AUTOMATION.md#one-time-setup-create-three-secrets)).

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv -r requirements.txt
cp .env.example .env          # paste in CENSUS_API_KEY, HUD_API_TOKEN, FRED_API_KEY
.venv/bin/python scripts/refresh_data.py
.venv/bin/python -m pytest -q
```

`refresh_data.py` fetches every source, builds the index and summaries, validates the result, and publishes it to `data/published/` **only if every check passes**. It exits with code 1 and leaves the published data untouched otherwise; `data/build/validation.json` says why. Downloads are cached by date in `data/raw/`, so reruns the same day don't hit the sources again.

Useful pieces on their own:

```bash
.venv/bin/python scripts/refresh_data.py --only acs hud    # refetch some sources (doesn't rebuild the index)
.venv/bin/python -m pipeline.index                         # rebuild scores from data/interim
.venv/bin/python -m pipeline.validate --no-publish         # check the build without publishing
.venv/bin/python -m pipeline.index --preview-zillow        # local comparison including Zillow (gitignored output)
```

To view the site locally, serve the repository folder over HTTP (the pages fetch the data files) and open `/v2/`:

```bash
.venv/bin/python -m http.server 8000
```

## How the automation works

[`.github/workflows/refresh.yml`](.github/workflows/refresh.yml) runs on the 20th of every month, or on demand from the Actions tab. It runs the pipeline and the tests and commits the refreshed `data/` **only if everything passed**. On any failure it commits nothing, so the site keeps the last good data, and it opens a GitHub Issue (label `data-refresh-failure`) naming the failed step and the reason. API keys come from repository secrets and never appear in code or logs. Setup and troubleshooting: [docs/AUTOMATION.md](docs/AUTOMATION.md).

## Maintenance tasks

### Updating the Fourth Round obligations file

Obligations have no API. They live in a hand-maintained CSV:

- `data/static/fourth_round/obligations_dca_2024.csv`: one row per municipality, extracted from Appendix A of the DCA report (the PDF is in the same folder).
- `data/static/fourth_round/obligations_dca_2024.meta.json`: where the numbers came from.

To replace them, for example with adopted or court-approved figures:

1. Copy the CSV to a new file (e.g. `obligations_2026.csv`) and edit the numbers. Keep the same columns, all 564 rows, and the `dca_name` + `county` values, which are how rows are matched to municipalities.
2. Copy the `.meta.json` alongside it and update `source`, `published`, `status`, and `last_hand_update` (today's date, and what changed).
3. Point `config.yaml` → `sources.fourth_round.csv` at the new file.
4. Update the labels that say "as calculated by the state in October 2024": the obligation sentences in `templates/summary_templates.yaml`, the vintage text in `pipeline/fetchers/fourth_round.py`, and the methodology pages.
5. Run `scripts/refresh_data.py` and the tests. Validation still checks that Qualified Urban Aid towns have zero prospective need and that capped need never exceeds uncapped need.

To re-extract from a new DCA PDF instead, delete the CSV and point `sources.fourth_round.pdf` at the new report. The parser then rebuilds the CSV and refuses unless its totals match the report's TOTAL row; update `REPORT_TOTALS` in `pipeline/fetchers/fourth_round.py` for the new report.

### A refresh logs a new UNMATCHED Zillow region

See [data/crosswalks/README.md](data/crosswalks/README.md). In short: run `python scripts/review_unmatched.py zillow`, then add a justified row to `data/crosswalks/overrides.csv`.

### Enabling Zillow once its terms are confirmed

Set `sources.zillow.cleared_for_publication: true` in `config.yaml`, add Zillow's required attribution wording where the other notices appear (site footer/Sources panel, methodology), and run the pipeline. Home values then come from Zillow where available and ACS elsewhere, with source and confidence recorded per town.

### Changing the website's code

The pages load `app.js`, `app.css`, `pages.js` and `pages.css` with a version tag (`?v=20261119k`). After editing any of them, change the tag in every page in `v2/` (`index`, `map`, `methodology`, `sources`, `data`) (e.g. to today's date) so visitors' browsers load the new files instead of a cached copy. Data files don't need this; they are fetched fresh.

### Changing an assumption or weight

Edit `config.yaml` (down payment, loan term, rate averaging, score weights, confidence thresholds, summary rules, validation limits) and rerun. The methodology page and `data/published/index_meta.json` pick up the new values automatically. Update [METHODOLOGY.md](METHODOLOGY.md) by hand.

## Principles

- **Every number traces to a source.** Each row records its home-value source and vintage, and each summary sentence lists its sources.
- **Missing means missing.** Nothing is imputed or invented, and nothing is generated by AI.
- **No municipality is silently dropped.** Exactly 564 rows, enforced before publishing.
- **Joins use IDs, never names.**
- **Barriers explain; they never change the score.** Obligations are never described as "met" or "failed".

## Citation

> OpenHousing NJ (v2). Housing affordability scores for New Jersey municipalities. https://github.com/karthik-pulla/nj-housing-index

Please also cite the underlying sources listed above, especially NZLUD: Mleczko, M. and Desmond, M. (2023), *National Zoning and Land Use Database*.
