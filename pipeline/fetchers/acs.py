"""Census ACS 5-year estimates for every municipality and county (Census Data API).

ACS covers all 564 municipalities, including very small ones, so it is the
fallback for every other source. Small towns have large margins of error
(MOE); we keep the MOE for every estimate so Phase 3 can flag confidence
instead of dropping towns.

Census "jam values" (large negative numbers) mean "no estimate" and become
missing. Medians in an open-ended top bracket are top-coded (e.g. income
"250,000+" is published as 250001); those get a *_topcoded flag.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import requests

from ..common import STATE_FIPS, census_get, latest_acs5_year, load_config
from .base import FetchResult

# variable -> (column name, expected label fragment). Labels are checked each run
# so a renamed or redefined table stops the pipeline instead of silently changing meaning.
VARS = {
    "B19013_001": ("median_hh_income", "Median household income"),
    "B25077_001": ("median_home_value", "Median value"),
    "B25064_001": ("median_gross_rent", "Median gross rent"),
    "B25088_002": ("median_owner_cost_mortgage", "Housing units with a mortgage"),
    "B25088_003": ("median_owner_cost_no_mortgage", "Housing units without a mortgage"),
    "B25003_001": ("households", "Total"),
    "B25003_003": ("renter_households", "Renter occupied"),
    "B25001_001": ("housing_units", "Total"),
    "B25070_001": ("rent_burden_universe", "Total"),
    "B25070_007": ("rent_30_34", "30.0 to 34.9 percent"),
    "B25070_008": ("rent_35_39", "35.0 to 39.9 percent"),
    "B25070_009": ("rent_40_49", "40.0 to 49.9 percent"),
    "B25070_010": ("rent_50_plus", "50.0 percent or more"),
    "B25070_011": ("rent_not_computed", "Not computed"),
}
# Values published at the top of the open-ended bracket.
TOP_CODES = {"median_hh_income": 250001, "median_home_value": 2000001, "median_gross_rent": 3501}


def check_labels(year: int) -> None:
    for var, (_, fragment) in VARS.items():
        r = requests.get(f"https://api.census.gov/data/{year}/acs/acs5/variables/{var}E.json", timeout=30)
        r.raise_for_status()
        label = r.json()["label"]
        if fragment.lower() not in label.lower():
            raise RuntimeError(f"ACS {year} {var}E label changed: {label!r} (expected {fragment!r})")


def _clean(s: pd.Series) -> pd.Series:
    v = pd.to_numeric(s, errors="coerce")
    return v.where(v > -100000000)          # jam values are <= -111111111


def _moe_sum(*moes) -> pd.Series:
    """ACS approximation for the MOE of a sum: sqrt of the sum of squared MOEs."""
    return np.sqrt(sum(m.fillna(0) ** 2 for m in moes))


def _moe_proportion(num, den, moe_num, moe_den) -> pd.Series:
    """ACS Handbook formula for a proportion p = num/den (falls back to the ratio formula)."""
    p = num / den
    radicand = moe_num ** 2 - p ** 2 * moe_den ** 2
    ratio_radicand = moe_num ** 2 + p ** 2 * moe_den ** 2
    return np.sqrt(radicand.where(radicand >= 0, ratio_radicand)) / den


def _query(year: int, geo_for: str, geo_in: str | None, filename: str) -> pd.DataFrame:
    names = [f"{v}E" for v in VARS] + [f"{v}M" for v in VARS]
    rows = census_get(f"{year}/acs/acs5", ["NAME"] + names, geo_for, geo_in, filename)
    df = pd.DataFrame(rows)
    out = pd.DataFrame({"name_acs": df["NAME"]})
    for var, (col, _) in VARS.items():
        out[col] = _clean(df[f"{var}E"])
        out[f"{col}_moe"] = _clean(df[f"{var}M"]).abs()
    for col, top in TOP_CODES.items():
        out[f"{col}_topcoded"] = out[col] == top

    # Share of renters paying 30%+ of income on gross rent, out of renters for
    # whom the ratio can be computed.
    num = out.rent_30_34 + out.rent_35_39 + out.rent_40_49 + out.rent_50_plus
    den = out.rent_burden_universe - out.rent_not_computed
    moe_num = _moe_sum(out.rent_30_34_moe, out.rent_35_39_moe, out.rent_40_49_moe, out.rent_50_plus_moe)
    moe_den = _moe_sum(out.rent_burden_universe_moe, out.rent_not_computed_moe)
    out["renters_cost_burdened_share"] = (num / den).where(den > 0)
    out["renters_cost_burdened_share_moe"] = _moe_proportion(num, den, moe_num, moe_den).where(den > 0)
    out["renters_cost_burdened_n"] = den
    drop = [c for c in out if c.startswith(("rent_3", "rent_4", "rent_5", "rent_not", "rent_burden"))]
    return pd.concat([df, out.drop(columns=drop)], axis=1)


def fetch() -> list[FetchResult]:
    year = load_config()["sources"]["acs"]["year"] or latest_acs5_year()
    check_labels(year)
    vintage = f"ACS {year - 4}-{year} 5-year"
    url = f"https://api.census.gov/data/{year}/acs/acs5"

    m = _query(year, "county subdivision:*", f"state:{STATE_FIPS}", f"acs5_{year}_cousub.json")
    m = m[m["county subdivision"] != "00000"]               # water-only placeholders
    m.insert(0, "geoid", m.state + m.county + m["county subdivision"])
    m = m.drop(columns=[c for c in m.columns if c.endswith(("E", "M")) and c[:1] == "B"]
               + ["NAME", "state", "county", "county subdivision"])

    c = _query(year, "county:*", f"state:{STATE_FIPS}", f"acs5_{year}_county.json")
    c.insert(0, "county_fips", c.state + c.county)
    c = c.drop(columns=[x for x in c.columns if x.endswith(("E", "M")) and x[:1] == "B"]
               + ["NAME", "state", "county"])

    src = "U.S. Census Bureau, American Community Survey 5-year estimates (Census Data API)"
    notes = ["Jam values (no estimate) are missing, not zero.",
             "Top-coded medians are flagged *_topcoded (income 250,000+, value 2,000,000+, rent 3,500+).",
             "renters_cost_burdened_share = renters paying 30%+ of income on gross rent / renters with "
             "a computable ratio (B25070); MOE by the ACS Handbook proportion formula."]
    return [
        FetchResult("acs_municipal", m, "geoid", vintage, src, url,
                    attribution="Source: U.S. Census Bureau, " + vintage + ".", notes=notes,
                    extra={"acs_year": year, "variables": {k: v[0] for k, v in VARS.items()}}),
        FetchResult("acs_county", c, "county_fips", vintage, src, url, notes=notes,
                    extra={"acs_year": year}),
    ]
