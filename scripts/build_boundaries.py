"""Build the simplified municipal boundary file the v2 site draws (v2/data/boundaries.geojson).

    python scripts/build_boundaries.py

Source: NJOGIS "NJ Municipal Boundaries" feature service (public state data).
The service simplifies server-side (maxAllowableOffset, ~50 m) so the file
stays small. Each feature carries `geoid` and `mun_code` so the map joins
on IDs, never names. Boundaries rarely change, so this runs by hand (not in
the monthly refresh) and the output is committed. The site uses this file,
so it doesn't depend on the state server being up when someone visits.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.common import download, setup_logging, log  # noqa: E402

URL = ("https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/"
       "NJ_Municipal_Boundaries_3424/FeatureServer/0/query")
OUT = ROOT / "v2" / "data" / "boundaries.geojson"


def main() -> None:
    setup_logging()
    params = {"where": "1=1", "outFields": "MUN_CODE,CENSUS2020", "outSR": "4326",
              "geometryPrecision": "5", "maxAllowableOffset": "0.0005", "f": "geojson"}
    path = download("njogis", "municipal_boundaries_simplified.geojson", URL, params=params)
    gj = json.loads(path.read_text())
    feats = []
    for f in gj["features"]:
        p = f["properties"]
        feats.append({"type": "Feature", "geometry": f["geometry"],
                      "properties": {"geoid": str(p["CENSUS2020"]), "mun_code": str(p["MUN_CODE"]).zfill(4)}})
    if len(feats) != 564 or len({f["properties"]["geoid"] for f in feats}) != 564:
        raise SystemExit(f"expected 564 unique municipalities, got {len(feats)}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    log.info("wrote %s (%d features, %.1f MB)", OUT, len(feats), OUT.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
