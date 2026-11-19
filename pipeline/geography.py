"""Phase 1: the canonical table of all 564 New Jersey municipalities.

Output: data/geo/municipalities.csv, one row per municipality, keyed on the
10-digit Census county-subdivision GEOID (state 2 + county 3 + cousub 5).

Sources (both official, both public):
  * Census Data API, ACS 5-year, `county subdivision` geography: GEOID,
    official Census name, county, population with margin of error.
  * NJOGIS "NJ Municipal Boundaries" feature service: the NJ 4-digit
    municipal code (MUN_CODE) that the v1 map and state datasets use, plus
    the Census 2020 GEOID for each boundary (field CENSUS2020).

The two are joined on GEOID, never on names; the build stops if they don't
agree on exactly the same 564 GEOIDs.

Also builds (once, then reused) data/static/census/place_parts_2020.csv:
how the 2020 housing units of every Census place (cities, boroughs and
unincorporated CDPs such as "Long Valley") split across municipalities.
The Zillow/Redfin crosswalk uses it to place unincorporated names.

Run:  python -m pipeline.geography [--rebuild-static]
"""
from __future__ import annotations

import argparse
import json

import pandas as pd

from .common import (EXPECTED_MUNICIPALITIES, GEO, STATE_FIPS, STATIC, census_get, download,
                     latest_acs5_year, log, setup_logging, today, write_json)

NJOGIS_URL = ("https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/"
              "NJ_Municipal_Boundaries_3424/FeatureServer/0/query")
NJOGIS_FIELDS = "MUN_CODE,CENSUS2020,MUN_LABEL,MUN_TYPE,COUNTY,GNIS,POP2020"

PLACE_PARTS = STATIC / "census" / "place_parts_2020.csv"
MUNI_CSV = GEO / "municipalities.csv"
MUNI_META = GEO / "municipalities.meta.json"


def nj_county_code_to_fips(code2: str) -> str:
    """NJ numbers its 21 counties 01-21 alphabetically; Census FIPS are the odd numbers 001-041."""
    return f"{2 * int(code2) - 1:03d}"


def fetch_census_cousubs(year: int) -> pd.DataFrame:
    rows = census_get(f"{year}/acs/acs5", ["NAME", "B01003_001E", "B01003_001M"],
                      "county subdivision:*", f"state:{STATE_FIPS}",
                      filename=f"acs5_{year}_cousub_population.json")
    df = pd.DataFrame(rows)
    df["geoid"] = df["state"] + df["county"] + df["county subdivision"]
    # Census lists a water-only "County subdivisions not defined" (code 00000)
    # in 5 coastal counties. They are not municipalities and have 0 population.
    placeholders = df[df["county subdivision"] == "00000"]
    log.info("dropping %d Census water-only placeholder rows (cousub 00000): %s", len(placeholders),
             "; ".join(placeholders["NAME"]))
    df = df[df["county subdivision"] != "00000"].copy()
    return pd.DataFrame({
        "geoid": df["geoid"],
        "county_fips": df["state"] + df["county"],
        "cousub_fips": df["county subdivision"],
        "census_name": df["NAME"].str.split(",").str[0].str.strip(),
        "county_name": df["NAME"].str.split(",").str[1].str.strip(),
        "pop_acs": pd.to_numeric(df["B01003_001E"]).astype("Int64"),
        "pop_acs_moe": pd.to_numeric(df["B01003_001M"]).astype("Int64"),
    })


def fetch_njogis() -> pd.DataFrame:
    params = {"where": "1=1", "outFields": NJOGIS_FIELDS, "returnGeometry": "false", "f": "json"}
    path = download("njogis", "municipal_boundaries_attributes.json", NJOGIS_URL, params=params)
    payload = json.loads(path.read_text())
    if payload.get("exceededTransferLimit"):
        raise RuntimeError("NJOGIS returned a partial result (exceededTransferLimit); add paging.")
    df = pd.DataFrame([f["attributes"] for f in payload["features"]])
    return pd.DataFrame({
        "geoid": df["CENSUS2020"].astype(str),
        "mun_code": df["MUN_CODE"].astype(str).str.zfill(4),
        "name": df["MUN_LABEL"],
        "mun_type": df["MUN_TYPE"],
        "njogis_county": df["COUNTY"],
        "gnis": df["GNIS"].astype(str),
        "pop_2020_census": df["POP2020"].astype("Int64"),
    })


def build_municipalities(year: int | None = None) -> pd.DataFrame:
    year = year or latest_acs5_year()
    census = fetch_census_cousubs(year)
    njogis = fetch_njogis()

    c_ids, n_ids = set(census.geoid), set(njogis.geoid)
    if c_ids != n_ids:
        raise RuntimeError(
            f"Census and NJOGIS disagree on GEOIDs. Only in Census: {sorted(c_ids - n_ids)}; "
            f"only in NJOGIS: {sorted(n_ids - c_ids)}")
    if njogis.mun_code.duplicated().any() or census.geoid.duplicated().any():
        raise RuntimeError("Duplicate MUN_CODE or GEOID in source data")

    df = census.merge(njogis, on="geoid", how="inner", validate="one_to_one")

    # Cross-check the two sources against each other on county, by code.
    expected_fips = STATE_FIPS + df.mun_code.str[:2].map(nj_county_code_to_fips)
    bad = df[expected_fips != df.county_fips]
    if len(bad):
        raise RuntimeError(f"MUN_CODE county prefix disagrees with Census county for: "
                           f"{bad[['geoid', 'mun_code', 'name']].to_dict('records')}")

    df["county"] = df["county_name"].str.replace(r" County$", "", regex=True)
    df["acs_vintage"] = f"ACS {year - 4}-{year} 5-year"
    cols = ["geoid", "mun_code", "name", "census_name", "mun_type", "county", "county_fips",
            "cousub_fips", "gnis", "pop_acs", "pop_acs_moe", "acs_vintage", "pop_2020_census"]
    df = df[cols].sort_values("geoid").reset_index(drop=True)

    if len(df) != EXPECTED_MUNICIPALITIES:
        raise RuntimeError(f"Expected {EXPECTED_MUNICIPALITIES} municipalities, got {len(df)}")
    return df


def build_place_parts() -> pd.DataFrame:
    """2020 Census housing units for every place-part within every municipality.

    The Census API only allows this geography one county subdivision at a
    time, so this makes 564 small requests. 2020 Census counts never change,
    so the result is committed to data/static and rebuilt only on request.
    """
    munis = pd.read_csv(MUNI_CSV, dtype=str)
    out = []
    for i, m in enumerate(munis.itertuples(), 1):
        county3 = m.county_fips[2:]
        rows = census_get("2020/dec/dhc", ["NAME", "H1_001N"],
                          "place/remainder (or part):*",
                          f"state:{STATE_FIPS} county:{county3} county subdivision:{m.cousub_fips}",
                          filename=f"dhc2020_place_parts/{m.geoid}.json")
        for r in rows:
            out.append({"geoid": m.geoid, "place_fips": r["place/remainder (or part)"],
                        "place_part_name": r["NAME"].split(",")[0].strip(),
                        "housing_units_2020": int(r["H1_001N"])})
        if i % 100 == 0:
            log.info("place parts: %d/%d municipalities", i, len(munis))
    df = pd.DataFrame(out)
    PLACE_PARTS.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(PLACE_PARTS, index=False)
    log.info("wrote %s (%d rows)", PLACE_PARTS, len(df))
    return df


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--rebuild-static", action="store_true",
                    help="re-download the 2020 Census place-part table (564 API calls)")
    args = ap.parse_args(argv)
    setup_logging()

    df = build_municipalities()
    GEO.mkdir(parents=True, exist_ok=True)
    df.to_csv(MUNI_CSV, index=False)
    write_json(MUNI_META, {
        "built": today(),
        "rows": len(df),
        "key": "geoid (Census county subdivision, 10 digits)",
        "sources": [
            {"name": "U.S. Census Bureau, ACS 5-year (Census Data API)",
             "vintage": df.acs_vintage.iloc[0],
             "fields": ["geoid", "census_name", "county", "pop_acs", "pop_acs_moe"]},
            {"name": "NJOGIS, NJ Municipal Boundaries (NJ_Municipal_Boundaries_3424)",
             "url": NJOGIS_URL.rsplit("/query", 1)[0],
             "fields": ["mun_code", "name", "mun_type", "gnis", "pop_2020_census"]},
        ],
    })
    log.info("wrote %s (%d municipalities)", MUNI_CSV, len(df))

    if args.rebuild_static or not PLACE_PARTS.exists():
        build_place_parts()


if __name__ == "__main__":
    main()
