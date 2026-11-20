"""Affordability over time: the inputs for price-to-income and rent-to-income
in every ACS 5-year release from 2005-2009 to the latest.

Two tables (Census data, public domain):
  acs_rent_history    municipality x release: median gross rent (B25064)
  acs_income_history  county and statewide x release: median household income
                      (B19013); statewide rows also carry the state's median home
                      value (B25077) and median gross rent (B25064), for the
                      statewide line on the graphs.

Combined with acs_home_value_history (B25077 by municipality) at publish time:
  price_to_income = median home value / county median household income
  rent_to_income  = 12 x median gross rent / county median household income
Both come from the same ACS release, so numerator and denominator describe
the same five-year period. Same caveats as the home value history:
overlapping periods, nominal dollars, top-coded values flagged, and years
where a GEOID's Census name differs from today's are dropped (boundary change).
"""
from __future__ import annotations

import pandas as pd

from ..common import GEO, STATE_FIPS, census_get, latest_acs5_year, load_config, log
from .base import FetchResult

FIRST_YEAR = 2009
RENT_TOP = {1001, 2001, 3501}            # ACS open-ended top categories for rent, across years


def _num(v):
    x = pd.to_numeric(v, errors="coerce")
    return None if x is None or pd.isna(x) or x < 0 else float(x)   # negative = Census "jam" codes


def fetch() -> list[FetchResult]:
    last = load_config()["sources"]["acs"]["year"] or latest_acs5_year()
    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    current = dict(zip(munis.geoid, munis.census_name))
    counties = set(munis.county_fips)
    rent, inc, dropped = [], [], []
    for year in range(FIRST_YEAR, last + 1):
        ds, period = f"{year}/acs/acs5", f"{year - 4}-{year}"
        for r in census_get(ds, ["NAME", "B25064_001E", "B25064_001M"], "county subdivision:*", f"state:{STATE_FIPS}",
                            filename=f"acs5_{year}_cousub_rent.json"):
            geoid = r["state"] + r["county"] + r["county subdivision"]
            if geoid not in current:
                continue
            name = r["NAME"].split(",")[0].strip()
            if name != current[geoid]:
                dropped.append(f"{year} {geoid}: {name!r} (now {current[geoid]!r})")
                continue
            v = _num(r["B25064_001E"])
            v = v if v and v > 99 else None     # 99 = open-ended "less than $100" category: not a usable median
            rent.append({"geoid": geoid, "year": year, "period": period, "median_gross_rent": v,
                         "moe": _num(r["B25064_001M"]), "topcoded": bool(v is not None and int(v) in RENT_TOP)})
        for r in census_get(ds, ["NAME", "B19013_001E", "B19013_001M"], "county:*", f"state:{STATE_FIPS}",
                            filename=f"acs5_{year}_county_income.json"):
            fips = r["state"] + r["county"]
            if fips in counties:
                inc.append({"geo": fips, "year": year, "period": period, "median_hh_income": _num(r["B19013_001E"]),
                            "moe": _num(r["B19013_001M"]), "median_home_value": None, "median_gross_rent": None})
        for r in census_get(ds, ["NAME", "B19013_001E", "B19013_001M", "B25077_001E", "B25064_001E"],
                            f"state:{STATE_FIPS}", None, filename=f"acs5_{year}_state_trend.json"):
            inc.append({"geo": STATE_FIPS, "year": year, "period": period, "median_hh_income": _num(r["B19013_001E"]),
                        "moe": _num(r["B19013_001M"]), "median_home_value": _num(r["B25077_001E"]),
                        "median_gross_rent": _num(r["B25064_001E"])})
    for d in dropped:
        log.info("rent history: dropped (different area under same GEOID?) %s", d)
    rent_df = pd.DataFrame(rent).sort_values(["geoid", "year"]).reset_index(drop=True)
    inc_df = pd.DataFrame(inc).sort_values(["geo", "year"]).reset_index(drop=True)
    if rent_df.geoid.nunique() != 564:
        raise RuntimeError(f"rent history covers {rent_df.geoid.nunique()} municipalities, expected 564")
    if inc_df[inc_df.geo != STATE_FIPS].geo.nunique() != 21:
        raise RuntimeError("county income history does not cover all 21 counties")
    vintage = f"ACS 5-year releases {FIRST_YEAR - 4}-{FIRST_YEAR} to {last - 4}-{last}"
    common = dict(vintage=vintage, url="https://api.census.gov/data/",
                  attribution="Source: U.S. Census Bureau, American Community Survey 5-year estimates.",
                  extra={"first_year": FIRST_YEAR, "last_year": last})
    return [
        FetchResult("acs_rent_history", rent_df, "geoid_year",
                    source="U.S. Census Bureau, American Community Survey 5-year estimates, table B25064 (median gross rent)",
                    notes=["Overlapping 5-year periods; dollars of each period's final year.",
                           "Years where the GEOID's Census name differs from today's are dropped (boundary change)."],
                    **{**common, "extra": {**common["extra"], "dropped": dropped}}),
        FetchResult("acs_income_history", inc_df, "geo_year",
                    source="U.S. Census Bureau, American Community Survey 5-year estimates, tables B19013, B25077, B25064 "
                           "(county and state)",
                    notes=["geo = 5-digit county FIPS, or 34 for New Jersey statewide.",
                           "Statewide rows also carry the state median home value and median gross rent."],
                    **common),
    ]
