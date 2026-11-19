"""Phase 2: fetcher logic (offline unit tests) and the interim tables they produced."""
import json

import numpy as np
import pandas as pd
import pytest

from pipeline.common import DATA, GEO
from pipeline.fetchers.acs import _clean, _moe_proportion
from pipeline.fetchers.base import INTERIM
from pipeline.fetchers.fourth_round import REPORT_TOTALS
from pipeline.fetchers.zillow import _town_values


def interim(name, **kw):
    p = INTERIM / f"{name}.csv"
    if not p.exists():
        pytest.skip(f"{p.name} not built; run scripts/refresh_data.py")
    return pd.read_csv(p, **kw)


# ---------------------------------------------------------------- ACS math

def test_jam_values_become_missing():
    s = _clean(pd.Series(["-666666666", "-999999999", "51234", "0"]))
    assert s.isna().tolist() == [True, True, False, False]


def test_moe_proportion_matches_acs_handbook():
    # ACS Handbook worked pattern: p = 25/100, MOE_num = 5, MOE_den = 10
    got = _moe_proportion(pd.Series([25.0]), pd.Series([100.0]), pd.Series([5.0]), pd.Series([10.0]))
    assert got.iloc[0] == pytest.approx(np.sqrt(5**2 - 0.25**2 * 10**2) / 100)


# ---------------------------------------------------------------- Zillow aggregation

def _links(rows):
    return pd.DataFrame(rows, columns=["region_id", "region_name", "geoid", "method", "link_hu_2020"])


def test_town_region_preferred_over_communities():
    munis = pd.DataFrame({"geoid": ["g1"], "census_name": ["Vernon township"]})
    links = _links([("1", "Vernon", "g1", "muni_base", 9000), ("2", "Glenwood", "g1", "override", None)])
    values = pd.DataFrame({"2026-10": [300.0, 500.0]}, index=["1", "2"])
    out = _town_values(values, links, munis, ["2026-10"])
    assert out["2026-10"].iloc[0] == 300.0 and out.zillow_method.iloc[0] == "town region"


def test_communities_weighted_by_housing_units():
    munis = pd.DataFrame({"geoid": ["g1"], "census_name": ["Winslow township"]})
    links = _links([("1", "A", "g1", "census_place", 3000), ("2", "B", "g1", "census_place", 1000)])
    values = pd.DataFrame({"2026-10": [100.0, 200.0]}, index=["1", "2"])
    out = _town_values(values, links, munis, ["2026-10"])
    assert out["2026-10"].iloc[0] == pytest.approx(125.0)


# ---------------------------------------------------------------- Fourth Round

@pytest.fixture(scope="module")
def obligations():
    return pd.read_csv(DATA / "static" / "fourth_round" / "obligations_dca_2024.csv")


def test_obligations_totals_match_report(obligations):
    assert len(obligations) == 564
    for col, total in REPORT_TOTALS.items():
        assert obligations[col].sum() == total


def test_qualified_urban_aid_have_no_prospective_need(obligations):
    qua = obligations[obligations.qualified_urban_aid]
    assert len(qua) == 47                                   # report p. 10
    assert (qua.prospective_need_capped == 0).all()


def test_wrapped_names_parsed(obligations):
    for n in ["Parsippany-Troy Hills township", "Lower Alloways Creek township",
              "Peapack and Gladstone borough"]:
        assert (obligations.dca_name == n).sum() == 1


def test_capped_never_exceeds_uncapped(obligations):
    assert (obligations.prospective_need_capped <= obligations.prospective_need).all()


# ---------------------------------------------------------------- interim tables

@pytest.mark.parametrize("name,expected", [
    ("acs_municipal", 564), ("property_tax_municipal", 564), ("fourth_round_municipal", 564),
])
def test_full_coverage_sources(name, expected):
    df = interim(name, dtype={"geoid": str})
    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    assert len(df) == expected and set(df.geoid) == set(munis.geoid)


def test_partial_sources_only_contain_real_geoids():
    munis = set(pd.read_csv(GEO / "municipalities.csv", dtype=str).geoid)
    for name in ["zillow_municipal", "nzlud_municipal"]:
        df = interim(name, dtype={"geoid": str})
        assert df.geoid.is_unique and set(df.geoid) <= munis, name


def test_property_tax_effective_rate_formula():
    t = interim("property_tax_municipal", dtype={"geoid": str})
    r = t.iloc[0]
    assert r.effective_tax_rate == pytest.approx(
        r.avg_res_tax_bill / (r.avg_res_assessed_value / r.equalization_ratio))


def test_hud_income_limit_ordering():
    h = interim("hud_county", dtype={"county_fips": str})
    assert len(h) == 21
    assert (h.il30_p4 < h.il50_p4).all() and (h.il50_p4 < h.il80_p4).all()


def test_every_interim_table_has_vintage_and_source():
    for meta in INTERIM.glob("*.meta.json"):
        m = json.loads(meta.read_text())
        assert m["vintage"] and m["source"] and m["url"], meta.name


def test_home_value_history():
    h = interim("acs_home_value_history", dtype={"geoid": str})
    munis = set(pd.read_csv(GEO / "municipalities.csv", dtype=str).geoid)
    assert set(h.geoid) == munis and not h.duplicated(["geoid", "year"]).any()
    # Princeton's code belonged to Princeton borough before the 2013 merger: those years are dropped.
    assert h[h.geoid == "3402160900"].year.min() >= 2013
