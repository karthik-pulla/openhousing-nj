"""Phase 7: the v2 site only reads columns that exist, only reads published files, and holds no secrets."""
import json
import re

import pytest

from pipeline.common import DATA, ROOT

V2 = ROOT / "v2"
APP = (V2 / "app.js").read_text()
LANDING = (V2 / "landing.js").read_text()
SCHEMA_COLS = {c["name"] for c in json.loads((DATA / "schema" / "openhousing_nj.schema.json").read_text())["columns"]}


def columns_used_by_site() -> set[str]:
    cols = set(re.findall(r'\bkey:\s*"([a-z0-9_]+)"', APP))                 # map layers
    cols |= set(re.findall(r'\b(?:rank|conf):\s*"([a-z0-9_]+)"', APP))     # rank / confidence columns
    cols |= set(re.findall(r'^\s*\["([a-z0-9_]+)",\s*"', APP, re.M))         # profile, compare, table rows
    # direct row access (r.column), skipping method calls like r.json() and fetch-response fields
    cols |= set(re.findall(r'\br\.([a-z][a-z0-9_]+)\b(?!\s*\()', APP)) - {"ok", "status", "map", "length"}
    return cols - {"geoid"} | {"geoid"}


def test_every_column_the_site_reads_exists():
    ignore = {"name", "county", "length", "map", "table", "compare", "__own_rank", "__rent_rank",
              "top", "left", "bottom", "width", "peek", "half", "full"}   # always present, view names, pseudo-rows, DOMRect fields
    missing = sorted(c for c in columns_used_by_site() - ignore if c not in SCHEMA_COLS)
    assert not missing, f"v2/app.js reads columns not in the published schema: {missing}"


def test_site_reads_only_published_files():
    paths = set(re.findall(r'"(\.\./data/[^"]+|data/[^"]+)"', APP + LANDING))
    assert paths, "no data paths found"
    for p in paths:
        assert p.startswith(("../data/published/", "../data/manifest.json", "data/boundaries.geojson")), p
        target = (V2 / p).resolve()
        assert target.exists(), f"{p} does not exist (run the pipeline / build_boundaries.py)"


@pytest.mark.parametrize("page", ["index.html", "map.html", "methodology.html", "app.js", "app.css",
                                  "landing.js", "landing.css"])
def test_no_secrets_or_private_terms_in_site(page):
    text = (V2 / page).read_text()
    assert not re.search(r"sk\.eyJ", text), "Mapbox SECRET token in public site"      # public pk. tokens are fine
    for env in ("CENSUS_API_KEY", "HUD_API_TOKEN", "FRED_API_KEY"):
        assert env not in text
    for term in ("Think Tank", "Rutgers", "qualitative"):
        assert term.lower() not in text.lower(), f"{term!r} must not appear on the public site"


def test_boundaries_join_on_geoid():
    gj = json.loads((V2 / "data" / "boundaries.geojson").read_text())
    ids = {f["properties"]["geoid"] for f in gj["features"]}
    munis = {l.split(",")[0] for l in (DATA / "geo" / "municipalities.csv").read_text().splitlines()[1:]}
    assert len(gj["features"]) == 564 and ids == munis


@pytest.mark.parametrize("src", [APP, LANDING], ids=["app.js", "landing.js"])
def test_localstorage_is_guarded(src):
    """Every localStorage access is inside try/catch (private mode, blocked storage)."""
    for m in re.finditer(r"localStorage\.(getItem|setItem|removeItem)", src):
        before = src[max(0, m.start() - 120):m.start()]
        assert "try" in before, src[m.start() - 80:m.end() + 20]


def test_pages_link_to_each_other():
    landing, mapp, meth = ((V2 / f).read_text() for f in ("index.html", "map.html", "methodology.html"))
    assert 'href="map.html"' in landing and 'href="methodology.html"' in landing
    assert 'href="./"' in mapp and 'href="methodology.html"' in mapp
    assert 'href="map.html"' in meth


def test_reduced_motion_respected():
    for css in ("app.css", "landing.css"):
        assert "prefers-reduced-motion" in (V2 / css).read_text(), css


def test_v1_pages_untouched():
    import subprocess
    out = subprocess.run(["git", "diff", "--name-only", "39c92c3", "--", "index.html", "app.html",
                          "methodology.html", "sources.html", "nj_affordability_master.csv"],
                         cwd=ROOT, capture_output=True, text=True).stdout.strip()
    assert out == "", f"v1 files changed: {out}"
