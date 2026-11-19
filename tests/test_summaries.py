"""Phase 6: template summaries: formatting, rules, rendering against real rows, safety checks."""
import json

import pandas as pd
import pytest
import yaml

from pipeline import summaries as S
from pipeline.common import load_config
from pipeline.index import BUILD

CFG = load_config()


# ---------------------------------------------------------------- formatting

@pytest.mark.parametrize("v,expected", [(9467, "$9,500"), (1_051_234, "$1,051,000"), (99_950, "$100,000"),
                                        (512, "$510"), (2_000_001, "$2,000,000")])
def test_money(v, expected):
    assert S.money(v) == expected


def test_rent_and_pct():
    assert S.rent_money(1234) == "$1,230"
    assert S.pct(0.396) == "40%" and S.pct(1.533) == "153%"


@pytest.mark.parametrize("n,expected", [(1, "1st"), (2, "2nd"), (3, "3rd"), (4, "4th"), (11, "11th"),
                                        (12, "12th"), (13, "13th"), (21, "21st"), (22, "22nd"),
                                        (111, "111th"), (342, "342nd"), (1001, "1,001st")])
def test_ordinal(n, expected):
    assert S.ordinal(n) == expected


@pytest.mark.parametrize("text", ["costs {x} a year", "worth about nan.", "it met its obligation",
                                  "the town failed to build", "Value: None."])
def test_check_text_catches_problems(text):
    assert S.check_text(text)


def test_clean_text_passes():
    assert S.check_text("In Absecon City, Atlantic County, the typical home is worth about $412,000.") == []


# ---------------------------------------------------------------- rendering real rows

@pytest.fixture(scope="module")
def df():
    p = BUILD / "openhousing_nj.csv"
    if not p.exists():
        pytest.skip("run the pipeline first")
    return pd.read_csv(p, dtype={"geoid": str, "mun_code": str, "county_fips": str})


@pytest.fixture(scope="module")
def renderer(df):
    templates = yaml.safe_load(S.TEMPLATES.read_text())
    return S.Renderer(df, CFG, templates, "ACS 2020-2024 5-year")


def _text(renderer, row):
    return " ".join(s["text"] for s in renderer.town(row))


def row(df, name):
    return df[df.name == name].iloc[0].copy()


@pytest.mark.parametrize("name", ["Princeton", "Cherry Hill Township", "Hoboken City"])
def test_summary_numbers_come_from_the_row(df, renderer, name):
    r = row(df, name)
    t = _text(renderer, r)
    n_own = int(df.ownership_score.notna().sum())
    assert f"worth about {S.money(r.home_value)}" in t
    assert f"costs about {S.money(r.annual_ownership_cost)} a year" in t
    assert f"property tax bill of {S.money(r.avg_property_tax_bill)}" in t
    assert f"{S.pct(r.ownership_burden)} of the county's median household income" in t
    assert f"ranks {S.ordinal(r.ownership_rank)} of {n_own:,}" in t
    if not S._true(r.qualified_urban_aid):
        assert f"is {S.number(r.prospective_need_capped)} affordable" in t
        assert f"({r.prospective_need_per_1000_hh:.1f} per 1,000 households)" in t


def test_urban_aid_wording(df, renderer):
    t = _text(renderer, row(df, "Newark City"))
    assert "Qualified Urban Aid municipality, so it has no prospective need obligation" in t
    assert "met" not in t.split() and "failed" not in t


def test_least_affordable_rule(df, renderer):
    n = int(df.ownership_score.notna().sum())
    worst = df.loc[df.ownership_rank == n].iloc[0]
    assert "one of the least affordable municipalities in New Jersey in which to own" in _text(renderer, worst)
    middle = df.loc[df.ownership_rank == n // 2].iloc[0]
    t = _text(renderer, middle)
    assert "least affordable" not in t and "most affordable municipalities" not in t


def test_most_affordable_rule(df, renderer):
    best = df.loc[df.ownership_rank == 1].iloc[0]
    assert "one of the most affordable municipalities in New Jersey in which to own" in _text(renderer, best)


def test_topcoded_value_says_at_least(df, renderer):
    t = _text(renderer, row(df, "Mantoloking Borough"))
    assert "worth at least $2,000,000" in t
    assert "Estimates for this town are based on limited data" in t


def test_missing_data_wording(df, renderer):
    t = _text(renderer, row(df, "Tavistock Borough"))
    assert "There isn't enough data to estimate the typical home value" in t
    assert "There isn't enough rental data" in t


def test_unreliable_renter_share_is_labelled(df, renderer):
    r = row(df, "Barnegat Light Borough")
    if r.renters_cost_burdened_confidence != "low":
        pytest.skip("estimate not low-confidence this vintage")
    assert "very small sample and is not reliable" in _text(renderer, r)


@pytest.mark.parametrize("own,rent,phrase", [
    (True, True, "could afford both"), (False, False, "could afford neither"),
    (False, True, "could afford the median rent but not"), (True, False, "but not the median rent"),
])
def test_ami_verdicts(df, renderer, own, rent, phrase):
    r = row(df, "Princeton")
    r["ownership_affordable_at_ami80"], r["rent_affordable_at_ami80"] = own, rent
    assert phrase in _text(renderer, r)


def test_restrictive_zoning_note(df, renderer):
    cut = df.zri.dropna().quantile(CFG["summaries"]["restrictive_zoning_quantile"])
    hi = df[df.zri >= cut].iloc[0]
    lo = df[df.zri < cut].iloc[0]
    assert "most restrictive" in _text(renderer, hi)
    assert "most restrictive" not in _text(renderer, lo)


def test_template_with_unknown_blank_fails(df):
    bad = yaml.safe_load(S.TEMPLATES.read_text())
    bad["home_value"] = "In {name}, the value is {no_such_field}."
    r = S.Renderer(df, CFG, bad, "ACS 2020-2024 5-year")
    with pytest.raises(KeyError):
        r.town(row(df, "Princeton"))


# ---------------------------------------------------------------- built file

def test_every_town_has_a_traceable_summary(df):
    if not S.OUT.exists():
        pytest.skip("summaries not built")
    out = json.loads(S.OUT.read_text())
    assert set(out["towns"]) == set(df.geoid)
    assert "no language model" in out["generator"]
    keys = set(out["sources"])
    for t in out["towns"].values():
        assert t["summary"] and S.check_text(t["summary"]) == []
        for s in t["sentences"]:
            assert s["sources"] and set(s["sources"]) <= keys and s["fields"]
