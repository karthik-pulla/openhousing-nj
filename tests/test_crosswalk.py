"""Phase 1: name normalisation, Zillow crosswalk integrity, overrides, NZLUD join."""
import json

import pandas as pd
import pytest

from pipeline.common import CROSSWALKS, GEO
from pipeline.crosswalk import base_key, full_key, match_regions


@pytest.fixture(scope="module")
def munis():
    return pd.read_csv(GEO / "municipalities.csv", dtype=str)


@pytest.fixture(scope="module")
def zillow():
    return pd.read_csv(CROSSWALKS / "zillow_crosswalk.csv", dtype=str)


# ---------------------------------------------------------------- normalisation

@pytest.mark.parametrize("a,b", [
    ("Mt Laurel Township", "Mount Laurel township"),
    ("Ho-Ho-Kus", "Ho-Ho-Kus borough"),
    ("Long Valley CDP (part)", "Long Valley"),
    ("Township of Washington", "Washington township"),
])
def test_base_key_equivalent(a, b):
    assert base_key(a) == base_key(b)


def test_full_key_and_vs_hyphen():
    assert full_key("Peapack-Gladstone") == full_key("Peapack and Gladstone")


def test_borough_and_township_differ_in_full_key():
    assert full_key("Chatham borough") != full_key("Chatham township")


# ---------------------------------------------------------------- matching rules

def _regions(*rows):
    return pd.DataFrame(rows, columns=["region_id", "region_name", "county"])


def test_twin_names_are_ambiguous_not_guessed():
    links, unmatched = match_regions("test", _regions(("t1", "Mendham", "Morris County")))
    assert links.empty
    assert unmatched.reason.iloc[0].startswith("ambiguous")


def test_type_word_resolves_twin():
    links, _ = match_regions("test", _regions(("t2", "Mendham Township", "Morris County")))
    assert links.mun_code.tolist() == ["1419"]


def test_city_with_doubled_type_word():
    links, _ = match_regions("test", _regions(("t3", "Jersey City", "Hudson County")))
    assert links.mun_code.tolist() == ["0906"]


def test_cdp_split_across_towns():
    links, _ = match_regions("test", _regions(("t4", "Sicklerville", "Camden County")))
    assert sorted(links.mun_code) == ["0415", "0436"]       # Gloucester Twp, Winslow Twp


def test_unknown_name_is_reported():
    links, unmatched = match_regions("test", _regions(("t5", "Atlantis", "Ocean County")))
    assert links.empty and len(unmatched) == 1


# ---------------------------------------------------------------- built crosswalk

def test_zillow_links_point_to_real_municipalities(zillow, munis):
    m = munis.set_index("mun_code").geoid
    assert zillow.geoid.isin(munis.geoid).all()
    assert (zillow.mun_code.map(m) == zillow.geoid).all()


def test_no_zillow_region_dropped():
    meta = json.loads((CROSSWALKS / "zillow_crosswalk.meta.json").read_text())
    assert meta["regions_linked"] + meta["regions_unmatched_or_excluded"] == meta["regions_in_file"]


def test_region_not_both_linked_and_unmatched(zillow):
    unmatched = pd.read_csv(CROSSWALKS / "zillow_unmatched.csv", dtype=str)
    assert not set(zillow.region_id) & set(unmatched.region_id)


def test_no_duplicate_links(zillow):
    assert not zillow.duplicated(["region_id", "geoid"]).any()


@pytest.mark.parametrize("region,expected", [
    ("Boonton", {"1401"}),          # town; Zillow lists Boonton Township separately
    ("Morristown", {"1424"}),       # v1 had this under Morris Township
    ("Manahawkin", {"1531"}),       # Stafford Twp (v1 had South Toms River)
    ("Waretown", {"1521"}),         # Ocean Twp, Ocean County (v1 had Mantoloking)
    ("Sewell", {"0810"}),           # Census CDP lies entirely in Mantua Twp
])
def test_known_answers(zillow, region, expected):
    assert set(zillow[zillow.region_name == region].mun_code) == expected


# ---------------------------------------------------------------- overrides

def test_overrides_are_documented(munis):
    o = pd.read_csv(CROSSWALKS / "overrides.csv", dtype=str, comment="#")
    assert o.note.notna().all() and (o.note.str.len() > 10).all()
    assert o.mun_code.isin(set(munis.mun_code) | {"NONE"}).all()
    assert not o.duplicated(["source", "region_id", "mun_code"]).any()


# ---------------------------------------------------------------- NZLUD

def test_nzlud_joins_by_code(munis):
    n = pd.read_csv(CROSSWALKS / "nzlud_crosswalk.csv", dtype=str)
    assert len(n) == 105
    assert n.geoid.notna().all() and n.geoid.isin(munis.geoid).all()
    assert n.geoid.is_unique
    assert (n.name_check == "True").all()
