"""Evidence helper for hand-maintaining data/crosswalks/overrides.csv.

For each region in data/crosswalks/<source>_unmatched.csv, look up USGS GNIS
"Populated Place" features with the same name and report which municipality
each one's official coordinates fall inside (point-in-polygon against the
NJOGIS boundaries). Also shows the v1 site's assignment, if any.

This script only writes a review file, data/crosswalks/<source>_review.csv.
A person decides what goes into overrides.csv. A GNIS point marks a
community's center, not the extent of a Zillow/Redfin region, so it is
evidence, not proof.

Run:  python scripts/review_unmatched.py zillow
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.common import CROSSWALKS, GEO, RAW, download  # noqa: E402
from pipeline.crosswalk import base_key, county_key  # noqa: E402

GNIS_URL = ("https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/"
            "DomesticNames_NJ_Text.zip")
BOUNDS_URL = ("https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/"
              "NJ_Municipal_Boundaries_3424/FeatureServer/0/query")


def load_gnis() -> pd.DataFrame:
    import zipfile
    z = download("usgs_gnis", "DomesticNames_NJ_Text.zip", GNIS_URL)
    with zipfile.ZipFile(z) as zf:
        name = next(n for n in zf.namelist() if n.endswith("DomesticNames_NJ.txt"))
        with zf.open(name) as f:
            g = pd.read_csv(f, sep="|", dtype=str, encoding="utf-8-sig")
    g = g[(g.state_name == "New Jersey") & (g.feature_class == "Populated Place")].copy()
    g["bk"] = g.feature_name.map(base_key)
    g["ck"] = g.county_name.map(county_key)
    g["lat"] = g.prim_lat_dec.astype(float)
    g["lon"] = g.prim_long_dec.astype(float)
    return g


def load_polygons() -> list[tuple[str, list]]:
    params = {"where": "1=1", "outFields": "MUN_CODE", "outSR": "4326",
              "geometryPrecision": "6", "f": "geojson"}
    path = download("njogis", "municipal_boundaries_4326.geojson", BOUNDS_URL, params=params)
    out = []
    for f in json.loads(path.read_text())["features"]:
        geom = f["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        out.append((f["properties"]["MUN_CODE"], polys))
    return out


def _in_ring(x: float, y: float, ring: list) -> bool:
    """Ray casting: count edge crossings of a horizontal ray from (x, y)."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def muni_at(lon: float, lat: float, polygons) -> str | None:
    for code, polys in polygons:
        for poly in polys:  # poly = [outer ring, hole, hole, ...]
            if _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, h) for h in poly[1:]):
                return code
    return None


def v1_assignments() -> dict[str, list[str]]:
    v1 = ROOT / "nj_affordability_master.csv"
    if not v1.exists():
        return {}
    df = pd.read_csv(v1, dtype={"municipality_code": str})
    out: dict[str, list[str]] = {}
    for code, regs in zip(df.municipality_code, df.regions.fillna("")):
        for r in filter(None, (s.strip() for s in regs.split(";"))):
            out.setdefault(r, []).append(code)
    return out


def main(source: str) -> None:
    unmatched = pd.read_csv(CROSSWALKS / f"{source}_unmatched.csv", dtype=str)
    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str).set_index("mun_code")
    gnis, polys, v1 = load_gnis(), load_polygons(), v1_assignments()

    rows = []
    for u in unmatched.itertuples():
        hits = gnis[gnis.bk == base_key(u.region_name)]
        same_county = hits[hits.ck == county_key(u.region_county)]
        use = same_county if len(same_county) else hits
        evidence = []
        for h in use.itertuples():
            code = muni_at(h.lon, h.lat, polys)
            label = f"{munis.loc[code, 'name']} ({code}, {munis.loc[code, 'county']})" if code else "outside NJ polygons"
            evidence.append(f"GNIS {h.feature_id} '{h.feature_name}' [{h.county_name}] -> {label}")
        v1codes = v1.get(u.region_name, [])
        rows.append({
            "region_id": u.region_id, "region_name": u.region_name, "region_county": u.region_county,
            "reason": u.reason,
            "gnis_evidence": " | ".join(evidence) or "no GNIS populated place with this name",
            "v1_assignment": "; ".join(f"{munis.loc[c, 'name']} ({c})" for c in v1codes),
        })
    out = pd.DataFrame(rows)
    out.to_csv(CROSSWALKS / f"{source}_review.csv", index=False)
    print(out.to_string(max_colwidth=120))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "zillow")
