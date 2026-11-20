"""Researcher features: dictionary, regions, affordability history, release archive."""
import gzip
import json

import pandas as pd

from pipeline.common import DATA, PUBLISHED, ROOT
from pipeline.dictionary import DICTIONARY

PUB = pd.read_csv(PUBLISHED / "openhousing_nj.csv", dtype={"geoid": str})


def test_every_published_column_is_in_the_dictionary():
    assert not [c for c in PUB.columns if c not in DICTIONARY]
    d = pd.read_csv(PUBLISHED / "data_dictionary.csv")
    assert list(d.column) == list(PUB.columns)
    assert d.description.str.len().min() > 10


def test_regions_add_up():
    r = pd.read_csv(PUBLISHED / "regions.csv", dtype={"id": str})
    assert (r.level == "county").sum() == 21 and (r.level == "housing_region").sum() == 6 and (r.level == "state").sum() == 1
    state = r[r.level == "state"].iloc[0]
    for lvl in ("county", "housing_region"):
        part = r[r.level == lvl]
        assert part.towns.sum() == state.towns == 564
        assert part.households.sum() == state.households == PUB.households.sum()
        assert part.present_need_total.sum() == state.present_need_total


def test_affordability_history_matches_its_inputs():
    h = pd.read_csv(PUBLISHED / "affordability_history.csv", dtype={"geoid": str})
    assert h.geoid.nunique() == 564 and not h.duplicated(["geoid", "year"]).any()
    ok = h.price_to_income.notna()
    assert ((h.loc[ok, "median_home_value"] / h.loc[ok, "county_median_hh_income"]) - h.loc[ok, "price_to_income"]).abs().max() < 1e-9
    w = json.loads((PUBLISHED / "affordability_history.web.json").read_text())
    assert len(w["state"]) == len(w["years"]) and len(w["towns"]) == 564


def test_archive_holds_the_published_release():
    idx = json.loads((DATA / "archive" / "index.json").read_text())
    latest = idx["releases"][0]
    with gzip.open(ROOT / latest["csv"], "rt") as f:
        arch = pd.read_csv(f, dtype={"geoid": str})
    pd.testing.assert_frame_equal(arch.reset_index(drop=True), PUB.reset_index(drop=True), check_dtype=False)
    tc = json.loads((PUBLISHED / "town_changes.web.json").read_text())
    assert tc["releases"][-1] == latest["release"] and len(tc["towns"]) == 564
    assert (DATA / "archive" / "CHANGELOG.md").read_text().startswith("# OpenHousing NJ data releases")


def test_license_and_citation_present():
    assert (ROOT / "LICENSE").exists() and (ROOT / "CITATION.cff").exists() and (ROOT / "data" / "LICENSE.md").exists()
