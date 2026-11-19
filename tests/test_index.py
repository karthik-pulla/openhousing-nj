"""Phase 3: index formulas (hand-checked) and the staged dataset."""
import json

import numpy as np
import pandas as pd
import pytest

from pipeline.common import load_config
from pipeline.fetchers.base import INTERIM
from pipeline.index import BUILD, annual_mortgage_payment, cv_level, percentile_rank, weighted_score

CFG = load_config()


# ---------------------------------------------------------------- hand-checked formulas

def test_mortgage_textbook_value():
    # $125,000 home, 20% down -> $100,000 loan at 6% for 30 years = $599.55/month.
    assert annual_mortgage_payment(125_000, 6.0, 20, 30) / 12 == pytest.approx(599.55, abs=0.01)


def test_mortgage_zero_rate():
    assert annual_mortgage_payment(120_000, 0.0, 0, 10) == pytest.approx(12_000)


def test_percentile_rank_by_hand():
    # burdens 10,20,30,40 -> midpoint percentiles 12.5/37.5/62.5/87.5 -> flipped
    got = percentile_rank(pd.Series([10.0, 20.0, 30.0, 40.0]))
    assert got.tolist() == pytest.approx([87.5, 62.5, 37.5, 12.5])


def test_percentile_rank_ties_and_missing():
    got = percentile_rank(pd.Series([10.0, 10.0, 30.0, np.nan]))
    assert got.iloc[:3].tolist() == pytest.approx([100 - 100 / 3, 100 - 100 / 3, 100 - 250 / 3])
    assert np.isnan(got.iloc[3])


def test_weighted_score_rescales_over_available():
    p = pd.DataFrame({"a": [80.0, np.nan], "b": [60.0, np.nan], "c": [np.nan, np.nan]})
    s, n = weighted_score(p, {"a": 1, "b": 1, "c": 1}, 1)
    assert s.iloc[0] == pytest.approx(70.0) and n.iloc[0] == 2
    assert np.isnan(s.iloc[1])                         # nothing available -> no score
    s2, _ = weighted_score(p, {"a": 2, "b": 1, "c": 1}, 1)
    assert s2.iloc[0] == pytest.approx((2 * 80 + 60) / 3)


def test_cv_tiers():
    cfg = CFG["confidence"]
    est = pd.Series([100.0, 100.0, 100.0, 0.0])
    moe = pd.Series([16.45, 49.35, 82.25, 5.0])          # CV 0.10, 0.30, 0.50, undefined
    assert cv_level(est, moe, cfg).tolist() == ["high", "medium", "low", "low"]


# ---------------------------------------------------------------- staged dataset

@pytest.fixture(scope="module")
def built():
    p = BUILD / "openhousing_nj.csv"
    if not p.exists():
        pytest.skip("run python -m pipeline.index")
    return pd.read_csv(p, dtype={"geoid": str, "mun_code": str, "county_fips": str})


def test_no_town_dropped(built):
    assert len(built) == 564 and built.geoid.is_unique


def test_every_town_has_confidence(built):
    assert built.confidence.isin(["high", "medium", "low", "insufficient data"]).all()
    assert (built.affordability_score.isna() == (built.confidence == "insufficient data")).all()


def test_scores_and_ranks_consistent(built):
    s = built.dropna(subset=["affordability_score"])
    assert s.affordability_score.between(0, 100).all()
    assert s.affordability_rank.min() == 1 and s.affordability_rank.max() <= len(s)
    top = s.sort_values("affordability_rank")
    assert top.affordability_score.is_monotonic_decreasing


@pytest.mark.parametrize("town", ["Newark City", "Princeton", "Cherry Hill Township", "Cape May Point Borough"])
def test_ownership_cost_hand_check(built, town):
    """Recompute a town's ownership burden straight from the interim inputs."""
    r = built[built.name == town].iloc[0]
    acs = pd.read_csv(INTERIM / "acs_municipal.csv", dtype={"geoid": str}).set_index("geoid").loc[r.geoid]
    county = pd.read_csv(INTERIM / "acs_county.csv", dtype={"county_fips": str}).set_index("county_fips").loc[r.county_fips]
    tax = pd.read_csv(INTERIM / "property_tax_municipal.csv", dtype={"geoid": str}).set_index("geoid").loc[r.geoid]
    rate = json.loads((INTERIM / "fred_mortgage30.meta.json").read_text())["rate_used_pct"]
    value = acs.median_home_value                           # ACS while Zillow isn't cleared
    loan = value * 0.8
    i = rate / 100 / 12
    annual = 12 * loan * i / (1 - (1 + i) ** -360) + tax.avg_res_tax_bill
    assert r.annual_ownership_cost == pytest.approx(annual, rel=1e-9)
    assert r.ownership_burden == pytest.approx(annual / county.median_hh_income, rel=1e-9)
    if np.isnan(acs.median_gross_rent):                     # e.g. Cape May Point: no ACS rent
        assert np.isnan(r.rent_burden)
    else:
        assert r.rent_burden == pytest.approx(12 * acs.median_gross_rent / county.median_hh_income, rel=1e-9)


def test_score_is_mean_of_component_percentiles(built):
    cols = ["ownership_burden_pctl", "rent_burden_pctl", "renters_cost_burdened_pctl"]
    w = pd.Series(CFG["index"]["weights"]).rename(lambda c: f"{c}_pctl")[cols]
    p = built[cols]
    expect = (p.fillna(0) * w).sum(axis=1) / (p.notna() * w).sum(axis=1)
    ok = built.affordability_score.notna()
    assert np.allclose(built.affordability_score[ok], expect[ok])


def test_home_value_source_recorded(built):
    has = built.ownership_burden.notna()
    assert built.loc[has, "home_value_source"].notna().all()
    assert built.loc[has, "home_value_vintage"].notna().all()


def test_zillow_absent_until_cleared(built):
    if not CFG["sources"]["zillow"]["cleared_for_publication"]:
        assert (built.home_value_source != "Zillow ZHVI").all()
        assert built.zhvi.isna().all()


def test_barriers_not_in_score():
    assert set(CFG["index"]["weights"]) == {"ownership_burden", "rent_burden", "renters_cost_burdened"}


def test_urban_aid_zeros_are_real(built):
    qua = built[built.qualified_urban_aid == True]  # noqa: E712
    assert len(qua) == 47 and (qua.prospective_need_capped == 0).all()


def test_tiny_towns_kept_not_scored(built):
    for t in ["Tavistock Borough", "Walpack Township"]:
        r = built[built.name == t].iloc[0]
        assert r.confidence == "insufficient data" and np.isnan(r.affordability_score)
