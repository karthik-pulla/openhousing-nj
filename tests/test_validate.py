"""Phase 4: validation catches broken data, and a failed run never replaces the published dataset."""
import pandas as pd
import pytest

from pipeline import validate as V
from pipeline.common import load_config

CFG = load_config()


@pytest.fixture(scope="module")
def good():
    if not V.BUILD_CSV.exists():
        pytest.skip("run scripts/refresh_data.py first")
    return V._read(V.BUILD_CSV)


def failed_checks(df, previous=None, cfg=CFG):
    rep = V.validate(df, previous, cfg)
    return {r["check"] for r in rep.results if not r["passed"] and r["level"] == "error"}, rep


def test_current_build_passes(good):
    errors, rep = failed_checks(good, previous=good)
    assert errors == set() and rep.ok


def test_dropped_town_fails(good):
    errors, _ = failed_checks(good.iloc[1:])
    assert {"rows", "geoids"} <= errors


def test_duplicate_geoid_fails(good):
    df = good.copy()
    df.loc[1, "geoid"] = df.loc[0, "geoid"]
    assert "geoids" in failed_checks(df)[0]


def test_null_required_field_fails(good):
    df = good.copy()
    df.loc[5, "county_median_hh_income"] = None
    assert "required" in failed_checks(df)[0]


def test_too_many_missing_fails(good):
    df = good.copy()
    df.loc[:40, "median_gross_rent"] = None
    assert "missing" in failed_checks(df)[0]


def test_implausible_value_fails(good):
    df = good.copy()
    df.loc[3, "mortgage_rate_pct"] = 72.0                 # e.g. a units bug (0.072 vs 7.2)
    assert "ranges" in failed_checks(df)[0]


def test_schema_change_fails(good):
    assert "schema" in failed_checks(good.assign(surprise_column=1))[0]
    assert "schema" in failed_checks(good.drop(columns=["rental_score"]))[0]


def test_inconsistent_rank_fails(good):
    df = good.copy()
    i = df.ownership_rank.idxmin()
    df.loc[i, "ownership_rank"] = 500
    assert "consistency" in failed_checks(df)[0]


def test_zillow_values_blocked_until_cleared(good):
    if CFG["sources"]["zillow"]["cleared_for_publication"]:
        pytest.skip("Zillow cleared")
    df = good.copy()
    df.loc[0, "zhvi"] = 500000.0
    assert "zillow_terms" in failed_checks(df)[0]


def test_coverage_drop_fails(good):
    df = good.copy()
    df.loc[df.rental_score.notna().cumsum() <= 20, ["rental_score", "rental_rank"]] = None
    df.loc[df.rental_score.isna(), "rental_confidence"] = "insufficient data"
    assert "coverage" in failed_checks(df, previous=good)[0]


def test_score_jump_is_warning_only(good):
    prev = good.copy()
    prev.loc[prev.ownership_score.notna(), "ownership_score"] = (
        prev.ownership_score - 30).clip(lower=0)
    errors, rep = failed_checks(good, previous=prev)
    jumps = next(r for r in rep.results if r["check"] == "jumps")
    assert not jumps["passed"] and jumps["level"] == "warning"
    assert "jumps" not in errors and rep.ok


def test_failed_run_keeps_last_good_dataset(good, tmp_path, monkeypatch):
    """A broken build must not overwrite data/published or the manifest."""
    build, pub = tmp_path / "build", tmp_path / "published"
    build.mkdir()
    pub.mkdir()
    live = pub / "openhousing_nj.csv"
    good.to_csv(live, index=False)
    live_before = live.read_bytes()
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"marker": "last good"}')

    good.iloc[10:].to_csv(build / "openhousing_nj.csv", index=False)   # 554 rows: broken
    monkeypatch.setattr(V, "BUILD", build)
    monkeypatch.setattr(V, "BUILD_CSV", build / "openhousing_nj.csv")
    monkeypatch.setattr(V, "PUBLISHED", pub)
    monkeypatch.setattr(V, "PUBLISHED_CSV", live)
    monkeypatch.setattr(V, "MANIFEST", manifest)

    assert V.run(publish_if_ok=True) is False
    assert live.read_bytes() == live_before
    assert manifest.read_text() == '{"marker": "last good"}'
    assert (build / "validation.json").exists()           # the failure is reported


def test_manifest_lists_sources_with_vintages():
    import json
    if not V.MANIFEST.exists():
        pytest.skip("not published yet")
    m = json.loads(V.MANIFEST.read_text())
    assert m["rows"] == 564 and m["validation"]["passed"]
    names = {s["name"] for s in m["sources"]}
    assert {"acs_municipal", "property_tax_municipal", "hud_county", "fred_mortgage30",
            "nzlud_municipal", "fourth_round_municipal"} <= names
    assert all(s["vintage"] and s["fetched_at"] for s in m["sources"])
    if not m["zillow_included"]:
        assert not any("zillow" in s["name"] for s in m["sources"])
