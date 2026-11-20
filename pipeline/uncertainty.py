"""Rank ranges: how far a town's rank could move given the Census margins of error.

The published ranks use the ACS point estimates. Each estimate has a 90% margin
of error, so the true value could be somewhat higher or lower. This module
redraws every uncertain input many times and recomputes every town's rank,
then reports the middle 90% of the ranks each town got:

  * ACS median home value  ~ Normal(estimate, MOE / 1.645), per town
  * ACS median gross rent  ~ Normal(estimate, MOE / 1.645), per town
  * ACS county median household income ~ Normal(estimate, MOE / 1.645),
    drawn once per county so every town in a county moves together
  * Fixed: the mortgage rate, down payment, loan term and property tax bill
    (published administrative values), Zillow and NJ DCA values (no published
    margin of error), and top-coded ACS values (only a lower bound is known).

Draws are clipped at a small positive floor. The random seed is fixed in
config.yaml, so the same inputs always give the same ranges. Towns at the extremes can
only move toward the middle when others are redrawn, so pipeline/index.py widens each
range to include the published rank.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

Z90 = 1.645


def _draws(est: pd.Series, moe: pd.Series, uncertain: pd.Series, n: int, rng, floor: float) -> np.ndarray:
    e = est.to_numpy(dtype=float)
    sd = (moe.to_numpy(dtype=float) / Z90)
    sd = np.where(uncertain.to_numpy(dtype=bool) & np.isfinite(sd), sd, 0.0)
    out = e[None, :] + rng.standard_normal((n, len(e))) * sd[None, :]
    return np.maximum(out, floor)


def _rank_interval(burden: np.ndarray, lo_q: float, hi_q: float) -> tuple[np.ndarray, np.ndarray]:
    """Rank 1 = smallest burden (most affordable), among towns that have the measure."""
    ok = np.isfinite(burden[0])
    b = np.where(ok[None, :], burden, np.inf)
    ranks = np.argsort(np.argsort(b, axis=1), axis=1) + 1
    lo = np.floor(np.quantile(ranks, lo_q, axis=0))
    hi = np.ceil(np.quantile(ranks, hi_q, axis=0))
    return np.where(ok, lo, np.nan), np.where(ok, hi, np.nan)


def rank_ranges(df: pd.DataFrame, rate_pct: float, down_payment_pct: float, term_years: int,
                draws: int, seed: int, interval: float) -> pd.DataFrame:
    from .index import annual_mortgage_payment
    rng = np.random.default_rng(seed)
    lo_q, hi_q = (1 - interval) / 2, 1 - (1 - interval) / 2

    # county income: one draw per county, shared by its towns
    cty = df[["county_fips", "county_median_hh_income", "county_median_hh_income_moe"]].drop_duplicates("county_fips")
    cd = _draws(cty.county_median_hh_income, cty.county_median_hh_income_moe,
                pd.Series(True, index=cty.index), draws, rng, 1000.0)
    col = {f: i for i, f in enumerate(cty.county_fips)}
    inc = cd[:, df.county_fips.map(col).to_numpy()]

    acs_value = (df.home_value_source == "ACS median value") & ~df.acs_median_home_value_topcoded.fillna(False).astype(bool)
    hv = _draws(df.home_value, df.acs_median_home_value_moe, acs_value, draws, rng, 1000.0)
    hv[:, df.home_value.isna().to_numpy()] = np.nan
    own_cost = annual_mortgage_payment(hv, rate_pct, down_payment_pct, term_years) + \
        df.avg_property_tax_bill.to_numpy(dtype=float)[None, :]
    o_lo, o_hi = _rank_interval(own_cost / inc, lo_q, hi_q)

    rent_unc = ~df.median_gross_rent_topcoded.fillna(False).astype(bool)
    rd = _draws(df.median_gross_rent, df.median_gross_rent_moe, rent_unc, draws, rng, 50.0)
    rd[:, df.median_gross_rent.isna().to_numpy()] = np.nan
    r_lo, r_hi = _rank_interval(12 * rd / inc, lo_q, hi_q)

    out = pd.DataFrame({"ownership_rank_low": o_lo, "ownership_rank_high": o_hi,
                        "rental_rank_low": r_lo, "rental_rank_high": r_hi}, index=df.index)
    return out.astype("Int64")
