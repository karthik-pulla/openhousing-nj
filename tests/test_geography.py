"""Phase 1: the canonical municipality table (data/geo/municipalities.csv)."""
import pandas as pd
import pytest

from pipeline.common import EXPECTED_MUNICIPALITIES, GEO
from pipeline.geography import nj_county_code_to_fips


@pytest.fixture(scope="module")
def munis() -> pd.DataFrame:
    return pd.read_csv(GEO / "municipalities.csv", dtype=str)


def test_exactly_564_municipalities(munis):
    assert len(munis) == EXPECTED_MUNICIPALITIES


def test_geoid_is_unique_10_digit_nj(munis):
    assert munis.geoid.is_unique
    assert munis.geoid.str.fullmatch(r"34\d{8}").all()
    assert (munis.geoid == munis.county_fips + munis.cousub_fips).all()


def test_mun_code_is_unique_4_digit(munis):
    assert munis.mun_code.is_unique
    assert munis.mun_code.str.fullmatch(r"\d{4}").all()


def test_mun_code_county_matches_census_county(munis):
    """NJ county codes 01-21 map to Census FIPS 001-041 (odd numbers)."""
    expected = "34" + munis.mun_code.str[:2].map(nj_county_code_to_fips)
    assert (expected == munis.county_fips).all()


def test_21_counties(munis):
    assert munis.county.nunique() == 21
    assert munis.county_fips.nunique() == 21


def test_required_fields_present(munis):
    for col in ["name", "census_name", "county", "pop_acs", "pop_acs_moe", "acs_vintage"]:
        assert munis[col].notna().all(), col


def test_tiny_towns_are_kept(munis):
    """Small towns get low-confidence flags later; they are never dropped."""
    for name in ["Loch Arbour Village", "Tavistock Borough", "Walpack Township", "Teterboro Borough"]:
        assert (munis.name == name).sum() == 1, name


def test_duplicate_names_have_distinct_geoids(munis):
    """NJ reuses names across counties; that's why nothing joins on names."""
    wash = munis[munis.census_name == "Washington township"]
    assert len(wash) == 5
    assert wash.geoid.is_unique and wash.county.is_unique
    assert munis.census_name.duplicated().any()


def test_known_crosswalk_rows(munis):
    m = munis.set_index("mun_code")
    assert m.loc["1114", "geoid"] == "3402160900"    # Princeton (consolidated 2013)
    assert m.loc["1438", "geoid"] == "3402777240"    # Washington Township, Morris
    assert m.loc["0503", "geoid"] == "3400910330"    # Cape May Point
