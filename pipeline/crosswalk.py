"""Crosswalks from name-only sources (Zillow, Redfin) and NZLUD to municipality GEOIDs.

Zillow and Redfin identify "cities" by name, and many of their NJ "cities"
are not municipalities at all: they are unincorporated places (Census CDPs)
such as Long Valley or Sewell, sometimes spanning two townships. Joining on
names alone silently drops or mismatches towns, so every region goes
through these steps, in order, and records which one placed it:

  1. override      data/crosswalks/overrides.csv (hand-maintained, keyed on the
                   source's own region ID). Always wins.
  2. muni_full     name incl. type word ("Washington Township", "Jersey City")
                   equals exactly one municipality's Census name (with or
                   without its type word) in the same county.
  3. muni_base     name without type word ("Wyckoff") equals exactly one
                   municipality's base name in the same county. If it equals
                   two (e.g. Washington borough and Washington township in
                   Warren), the region is AMBIGUOUS and needs an override.
  4. census_place  name equals a 2020 Census place (usually a CDP) with land in
                   the same county; the region is linked to every municipality
                   holding at least MIN_PART_SHARE of that place's 2020
                   housing units.

Anything left is written to <source>_unmatched.csv with a reason, and the
build reports it. Nothing is dropped silently.

NZLUD rows carry a 7-digit code = state FIPS + the 5-digit FIPS code that
Census also uses for the municipality's county subdivision, so it joins on
code, not name (NZLUD writes names without spaces, e.g. "AsburyPark").

Run:  python -m pipeline.crosswalk zillow|nzlud
"""
from __future__ import annotations

import argparse
import re
import sys

import pandas as pd

from .common import CROSSWALKS, GEO, STATIC, log, setup_logging, today, write_json

MIN_PART_SHARE = 0.10   # a CDP is linked to a municipality holding >=10% of its housing units
TYPE_WORDS = ("township", "borough", "city", "town", "village", "cdp")
OVERRIDES = CROSSWALKS / "overrides.csv"
PLACE_PARTS = STATIC / "census" / "place_parts_2020.csv"

_ABBREV = {r"\bmt\b": "mount", r"\bft\b": "fort", r"\bst\b": "saint", r"\btwp\b": "township",
           r"\bboro\b": "borough", r"\bvlg\b": "village"}


def clean(name: str) -> str:
    """Lowercase, expand common abbreviations, drop punctuation and '(part)'."""
    s = str(name).lower().replace("&", " and ")
    s = re.sub(r"\(part\)", " ", s)
    s = re.sub(r"[-–./,']", " ", s)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    for pat, rep in _ABBREV.items():
        s = re.sub(pat, rep, s)
    return re.sub(r"\s+", " ", s).strip()


def squash(s: str) -> str:
    """Comparison key tolerant of spacing and 'and': 'Peapack-Gladstone' == 'Peapack and Gladstone'."""
    return re.sub(r"\band\b|\s", "", s)


def full_key(name: str) -> str:
    return squash(clean(name))


def base_key(name: str) -> str:
    s = clean(name)
    s = re.sub(r"^(township|borough|city|town|village) of ", "", s)
    s = re.sub(r"\b(" + "|".join(TYPE_WORDS) + r")$", "", s).strip()
    return squash(s)


def county_key(name: str) -> str:
    return clean(re.sub(r"\s+County$", "", str(name), flags=re.I))


# --------------------------------------------------------------------------- inputs

def load_munis() -> pd.DataFrame:
    m = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    m["ck"] = m.county.map(county_key)
    m["fk"] = m.census_name.map(full_key)
    m["bk"] = m.census_name.map(base_key)
    return m


def load_places(munis: pd.DataFrame) -> pd.DataFrame:
    """One row per (place, municipality) part with housing-unit shares."""
    p = pd.read_csv(PLACE_PARTS, dtype={"geoid": str, "place_fips": str})
    p = p[p.place_fips != "99999"].copy()                  # "Remainder of X township"
    p["place_name"] = p.place_part_name.str.replace(r"\s*\(part\)$", "", regex=True)
    p["bk"] = p.place_name.map(base_key)
    total = p.groupby("place_fips").housing_units_2020.transform("sum")
    p["share"] = (p.housing_units_2020 / total).where(total > 0, 0.0)
    p = p.merge(munis[["geoid", "ck"]], on="geoid", how="left")
    return p


def muni_housing_units() -> pd.Series:
    p = pd.read_csv(PLACE_PARTS, dtype={"geoid": str})
    return p.groupby("geoid").housing_units_2020.sum()


def load_overrides(source: str, munis: pd.DataFrame) -> pd.DataFrame:
    o = pd.read_csv(OVERRIDES, dtype=str, comment="#").fillna("")
    o = o[o.source == source].copy()
    known = set(munis.mun_code)
    bad = o[(o.mun_code != "NONE") & ~o.mun_code.isin(known)]
    if len(bad):
        raise ValueError(f"overrides.csv has unknown mun_code(s): {bad.to_dict('records')}")
    return o.merge(munis[["mun_code", "geoid"]], on="mun_code", how="left")


# --------------------------------------------------------------------------- matching

def match_regions(source: str, regions: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """regions: columns region_id, region_name, county (any of 'Morris' / 'Morris County').

    Returns (links, unmatched). `links` has one row per (region, municipality);
    a region split across municipalities has several rows. `link_hu_2020` is
    the region's 2020 housing units inside that municipality (whole-town
    housing units for town-named regions) for optional weighting later.
    """
    munis = load_munis()
    places = load_places(munis)
    hu = muni_housing_units()
    overrides = load_overrides(source, munis)
    ov_ids = set(overrides.region_id)

    links, unmatched = [], []
    seen_override_ids = set()
    for r in regions.itertuples(index=False):
        rid, rname, ck = str(r.region_id), r.region_name, county_key(r.county)
        base = {"source": source, "region_id": rid, "region_name": rname, "region_county": r.county}

        if rid in ov_ids:
            seen_override_ids.add(rid)
            for o in overrides[overrides.region_id == rid].itertuples():
                if o.mun_code == "NONE":
                    unmatched.append({**base, "reason": f"excluded by override: {o.note}"})
                    continue
                links.append({**base, "geoid": o.geoid, "mun_code": o.mun_code, "method": "override",
                              "link_hu_2020": None, "note": o.note})
            continue

        in_county = munis[munis.ck == ck]
        if in_county.empty:
            unmatched.append({**base, "reason": f"county not recognised: {r.county!r}"})
            continue

        # Census doubles the type word for some cities ("Jersey City city"), so a
        # region's full name may equal a municipality's base name.
        fk = full_key(rname)
        hit = in_county[(in_county.fk == fk) | (in_county.bk == fk)]
        method = "muni_full"
        if len(hit) != 1:
            hit = in_county[in_county.bk == base_key(rname)]
            method = "muni_base"
        if len(hit) == 1:
            m = hit.iloc[0]
            links.append({**base, "geoid": m.geoid, "mun_code": m.mun_code, "method": method,
                          "link_hu_2020": int(hu.get(m.geoid, 0)), "note": ""})
            continue
        if len(hit) > 1:
            unmatched.append({**base, "reason": "ambiguous: " + " | ".join(
                f"{x.census_name} ({x.mun_code})" for x in hit.itertuples())})
            continue

        cand = places[places.bk == base_key(rname)]
        cand = cand[cand.place_fips.isin(cand[cand.ck == ck].place_fips)]
        if cand.place_fips.nunique() == 1:
            keep = cand[cand.share >= MIN_PART_SHARE]
            for p in keep.itertuples():
                m = munis[munis.geoid == p.geoid].iloc[0]
                links.append({**base, "geoid": p.geoid, "mun_code": m.mun_code,
                              "method": "census_place", "link_hu_2020": int(p.housing_units_2020),
                              "note": f"{p.place_name}: {p.share:.0%} of 2020 housing units"})
            continue
        if cand.place_fips.nunique() > 1:
            unmatched.append({**base, "reason": "ambiguous Census places: " +
                              " | ".join(sorted(set(cand.place_name)))})
            continue
        unmatched.append({**base, "reason": "no municipality or Census place with this name in county"})

    stale = ov_ids - seen_override_ids
    if stale:
        log.warning("%s overrides reference region IDs not in this file (stale?): %s",
                    source, sorted(stale))

    id_cols = ["source", "region_id", "region_name", "region_county"]
    links_df = pd.DataFrame(links, columns=id_cols + ["geoid", "mun_code", "method",
                                                      "link_hu_2020", "note"])
    links_df["link_hu_2020"] = links_df["link_hu_2020"].astype("Int64")
    return links_df, pd.DataFrame(unmatched, columns=id_cols + ["reason"])


def write_crosswalk(source: str, regions: pd.DataFrame, extra_meta: dict | None = None) -> pd.DataFrame:
    links, unmatched = match_regions(source, regions)
    CROSSWALKS.mkdir(parents=True, exist_ok=True)
    links.sort_values(["region_id", "geoid"]).to_csv(CROSSWALKS / f"{source}_crosswalk.csv", index=False)
    unmatched.sort_values("region_name").to_csv(CROSSWALKS / f"{source}_unmatched.csv", index=False)

    n_regions = regions.region_id.astype(str).nunique()
    n_linked = links.region_id.nunique()
    n_unmatched = unmatched.region_id.nunique()
    meta = {
        "built": today(), "source": source, "regions_in_file": n_regions,
        "regions_linked": n_linked, "regions_unmatched_or_excluded": n_unmatched,
        "links": len(links), "municipalities_covered": links.geoid.nunique(),
        "by_method": links.groupby("method").region_id.nunique().to_dict(),
        "min_part_share": MIN_PART_SHARE, **(extra_meta or {}),
    }
    if n_linked + n_unmatched != n_regions:
        raise RuntimeError(f"{source}: {n_regions} regions but {n_linked} linked + "
                           f"{n_unmatched} unmatched; some region was dropped")
    write_json(CROSSWALKS / f"{source}_crosswalk.meta.json", meta)
    log.info("%s crosswalk: %d regions -> %d linked, %d unmatched; %d municipalities covered",
             source, n_regions, n_linked, n_unmatched, meta["municipalities_covered"])
    for u in unmatched.itertuples():
        log.warning("UNMATCHED %s %s (%s, %s): %s", source, u.region_id, u.region_name,
                    u.region_county, u.reason)
    return links


# --------------------------------------------------------------------------- sources

def zillow_regions(csv_path) -> pd.DataFrame:
    z = pd.read_csv(csv_path, usecols=["RegionID", "RegionName", "State", "CountyName"])
    z = z[z.State == "NJ"]
    return pd.DataFrame({"region_id": z.RegionID.astype(str), "region_name": z.RegionName,
                         "county": z.CountyName})


def build_nzlud() -> pd.DataFrame:
    """NZLUD -> GEOID by code, with a name sanity check."""
    munis = load_munis()
    n = pd.read_csv(STATIC / "nzlud" / "nzlud_muni.csv", encoding="latin1", dtype={"GEOID": str})
    n = n[n.statename.str.upper() == "NJ"].copy()
    n["code5"] = n.GEOID.str.zfill(7).str[2:]
    if munis.cousub_fips.duplicated().any():
        raise RuntimeError("cousub FIPS codes are not unique within NJ; NZLUD join needs county too")
    out = n.merge(munis[["cousub_fips", "geoid", "mun_code", "census_name"]],
                  left_on="code5", right_on="cousub_fips", how="left")
    # Name sanity check only (the join is by code). NZLUD writes names in
    # CamelCase, sometimes with the type glued on ("HamiltonTownship") and
    # sometimes with "City" dropped ("Jersey", type "City").
    def nz_ok(place, typ, census):
        if not isinstance(census, str):
            return False
        split = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(place))
        keys = {base_key(split), full_key(f"{split} {typ}")}
        return bool(keys & {base_key(census), full_key(census)})
    out["name_check"] = [nz_ok(p, t, c) for p, t, c in zip(out.place, out.type, out.census_name)]
    unmatched = out[out.geoid.isna()]
    mismatched = out[out.geoid.notna() & ~out.name_check]
    res = out[["GEOID", "place", "type", "geoid", "mun_code", "census_name", "name_check"]].rename(
        columns={"GEOID": "nzlud_geoid", "place": "nzlud_place", "type": "nzlud_type"})
    CROSSWALKS.mkdir(parents=True, exist_ok=True)
    res.to_csv(CROSSWALKS / "nzlud_crosswalk.csv", index=False)
    write_json(CROSSWALKS / "nzlud_crosswalk.meta.json", {
        "built": today(), "nzlud_nj_rows": len(n), "matched": int(out.geoid.notna().sum()),
        "unmatched": len(unmatched), "name_mismatches": len(mismatched),
        "municipalities_without_nzlud": 564 - int(out.geoid.nunique()),
    })
    log.info("NZLUD: %d NJ rows, %d matched by code, %d unmatched, %d name mismatches",
             len(n), out.geoid.notna().sum(), len(unmatched), len(mismatched))
    for r in pd.concat([unmatched, mismatched]).itertuples():
        log.warning("NZLUD check %s %s -> %s", r.GEOID, r.place, r.census_name)
    return res


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Build GEOID crosswalks")
    ap.add_argument("source", choices=["zillow", "nzlud"])
    ap.add_argument("--zillow-csv", help="path to Zillow city ZHVI CSV (default: newest in data/raw/zillow)")
    args = ap.parse_args(argv)
    setup_logging()
    if args.source == "nzlud":
        build_nzlud()
    else:
        from .common import RAW
        path = args.zillow_csv or sorted((RAW / "zillow").glob("*/City_zhvi_*.csv"))[-1]
        write_crosswalk("zillow", zillow_regions(path), {"input_file": str(path).split("data/")[-1]})


if __name__ == "__main__":
    sys.exit(main())
