"""County, housing-region and statewide summaries of the town dataset.

Every figure is calculated from the published town rows; nothing new is
estimated. Averages of town measures are weighted by households (renter
households for rent measures), so a town of 60,000 households counts more
than a town of 60. "Median town" figures count each town once.

Housing regions are the six regions New Jersey uses for affordable-housing
obligations (the Fourth Round calculation); their county lists are read from
the data, not typed in.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _wmean(v: pd.Series, w: pd.Series):
    ok = v.notna() & w.notna() & (w > 0)
    return float(np.average(v[ok], weights=w[ok])) if ok.any() else None


def _share(flag: pd.Series, w: pd.Series, value: bool):
    """Share of weight (households) living in towns where flag == value, among towns where flag is known."""
    f = flag.map(lambda x: None if pd.isna(x) else (x in (True, "True")))
    ok = f.notna() & (w > 0)
    return float(w[ok & (f == value)].sum() / w[ok].sum()) if ok.any() and w[ok].sum() > 0 else None


def _summary(g: pd.DataFrame) -> dict:
    hh, rhh = g.households.astype(float), g.renter_households.astype(float)
    return {
        "towns": len(g),
        "population": int(g.population.sum()),
        "households": int(hh.sum()),
        "renter_households": int(rhh.sum()),
        "towns_with_ownership_score": int(g.ownership_score.notna().sum()),
        "towns_with_rental_score": int(g.rental_score.notna().sum()),
        "ownership_burden_hh_weighted": _wmean(g.ownership_burden, hh),
        "rent_burden_renter_weighted": _wmean(g.rent_burden, rhh),
        "price_to_income_hh_weighted": _wmean(g.price_to_income, hh),
        "median_town_home_value": None if g.home_value.isna().all() else float(g.home_value.median()),
        "median_town_rent": None if g.median_gross_rent.isna().all() else float(g.median_gross_rent.median()),
        "share_hh_where_owning_unaffordable_ami80": _share(g.ownership_affordable_at_ami80, hh, False),
        "share_renters_where_rent_unaffordable_ami80": _share(g.rent_affordable_at_ami80, rhh, False),
        "present_need_total": int(g.present_need.sum()),
        "prospective_need_total": int(g.prospective_need_capped.sum()),
        "total_need_per_1000_hh": float((g.present_need.sum() + g.prospective_need_capped.sum()) / hh.sum() * 1000)
        if hh.sum() > 0 else None,
        "urban_aid_towns": int(g.qualified_urban_aid.map(lambda x: x in (True, "True")).sum()),
        "zoning_data_towns": int(g.zri.notna().sum()),
    }


def build(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for county, g in df.groupby("county"):
        rows.append({"level": "county", "id": str(g.county_fips.iloc[0]), "name": f"{county} County",
                     "counties": county,
                     "county_median_hh_income": float(g.county_median_hh_income.iloc[0]), **_summary(g)})
    for reg, g in df.groupby("housing_region"):
        counties = sorted(g.county.unique())
        rows.append({"level": "housing_region", "id": str(int(reg)), "name": f"Housing Region {int(reg)}",
                     "counties": ", ".join(counties), "county_median_hh_income": None, **_summary(g)})
    rows.append({"level": "state", "id": "34", "name": "New Jersey", "counties": "All 21 counties",
                 "county_median_hh_income": None, **_summary(df)})
    out = pd.DataFrame(rows)
    if len(out) != 21 + 6 + 1:
        raise RuntimeError(f"expected 28 summary rows (21 counties, 6 regions, state), got {len(out)}")
    return out
