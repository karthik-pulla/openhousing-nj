"""Median home value over time: every ACS 5-year release from 2005-2009 to the latest.

Feeds the home value graph on each town profile. Census data (public domain),
so it is available for every municipality, unlike Zillow.

Caveats, carried into the metadata and shown on the site:
  * Each point is a 5-year pooled estimate; consecutive releases overlap by
    four years, so year-to-year changes are smoothed and not independent.
  * Values are in dollars of each period's final year (not adjusted to today).
  * Open-ended top categories changed over time ($1,000,000+ in older releases,
    $2,000,000+ later); top-coded points are flagged.
  * Boundary changes: a GEOID can be reused for a different area. Princeton
    borough's code became the consolidated Princeton's in 2013. A year is
    kept only if Census's name for that GEOID matches today's name; other
    years are dropped (logged), never relabelled.
"""
from __future__ import annotations

import pandas as pd

from ..common import GEO, STATE_FIPS, census_get, latest_acs5_year, load_config, log
from .base import FetchResult

FIRST_YEAR = 2009
TOP_CODES = {1000001, 2000001}


def fetch() -> list[FetchResult]:
    last = load_config()["sources"]["acs"]["year"] or latest_acs5_year()
    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)[["geoid", "census_name"]]
    current = dict(zip(munis.geoid, munis.census_name))
    rows, dropped = [], []
    for year in range(FIRST_YEAR, last + 1):
        data = census_get(f"{year}/acs/acs5", ["NAME", "B25077_001E", "B25077_001M"],
                          "county subdivision:*", f"state:{STATE_FIPS}",
                          filename=f"acs5_{year}_cousub_home_value.json")
        for r in data:
            geoid = r["state"] + r["county"] + r["county subdivision"]
            if geoid not in current:
                continue                                    # placeholders, dissolved towns
            name = r["NAME"].split(",")[0].strip()
            if name != current[geoid]:
                dropped.append(f"{year} {geoid}: {name!r} (now {current[geoid]!r})")
                continue
            v = pd.to_numeric(r["B25077_001E"], errors="coerce")
            moe = pd.to_numeric(r["B25077_001M"], errors="coerce")
            v = v if v is not None and v > 0 else None      # jam values -> missing
            moe = abs(moe) if moe is not None and moe > -100000000 else None
            rows.append({"geoid": geoid, "year": year, "period": f"{year - 4}-{year}",
                         "median_home_value": v, "moe": moe,
                         "topcoded": bool(v is not None and int(v) in TOP_CODES)})
    for d in dropped:
        log.info("home value history: dropped (different area under same GEOID?) %s", d)
    df = pd.DataFrame(rows).sort_values(["geoid", "year"]).reset_index(drop=True)
    if df.geoid.nunique() != 564:
        raise RuntimeError(f"home value history covers {df.geoid.nunique()} municipalities, expected 564")
    return [FetchResult(
        "acs_home_value_history", df, "geoid_year",
        vintage=f"ACS 5-year releases {FIRST_YEAR - 4}-{FIRST_YEAR} to {last - 4}-{last}",
        source="U.S. Census Bureau, American Community Survey 5-year estimates, table B25077 (median value)",
        url="https://api.census.gov/data/",
        attribution="Source: U.S. Census Bureau, American Community Survey 5-year estimates.",
        notes=["Overlapping 5-year periods; dollars of each period's final year; owner-reported values.",
               "Years where the GEOID's Census name differs from today's are dropped (boundary change)."],
        extra={"first_year": FIRST_YEAR, "last_year": last, "dropped": dropped})]
