"""Zillow Home Value Index (ZHVI), city-level research CSV.

No API: Zillow's research data is a public CSV (the Zillow/Bridge API is for
businesses). Zillow "cities" are often unincorporated communities, so values
reach municipalities only through data/crosswalks/zillow_crosswalk.csv,
which is rebuilt from the downloaded file on every run.

Town value (config sources.zillow.aggregation = town_region_first):
  1. If a Zillow region is the town itself (matched by the town's own name,
     or by an override whose region name is the town's name), use it.
  2. Otherwise use the mean of the community regions linked to the town,
     weighted by each community's 2020 housing units inside the town.
Towns with no linked region are missing here and fall back to other sources
in Phase 3. Nothing is filled in.
"""
from __future__ import annotations

import pandas as pd

from ..common import GEO, load_config
from ..crosswalk import base_key, write_crosswalk, zillow_regions
from ..common import download
from .base import FetchResult

ATTRIBUTION = "Zillow Home Value Index (ZHVI), Zillow Research, https://www.zillow.com/research/data/"
HISTORY_YEARS = 26


def _town_values(values: pd.DataFrame, links: pd.DataFrame, munis: pd.DataFrame,
                 date_cols: list[str]) -> pd.DataFrame:
    """Aggregate region values (rows = region_id, cols = dates) to municipalities."""
    l = links.merge(munis[["geoid", "census_name"]], on="geoid")
    l["is_town_region"] = l.method.isin(["muni_full", "muni_base"]) | (
        (l.method == "override") & (l.region_name.map(base_key) == l.census_name.map(base_key)))
    l = l.merge(values, left_on="region_id", right_index=True, how="left")

    rows = []
    for geoid, g in l.groupby("geoid"):
        town = g[g.is_town_region]
        use = town if len(town) else g
        w = use.link_hu_2020.astype(float).fillna(0) if not len(town) else pd.Series(1.0, index=use.index)
        if w.sum() == 0:
            w = pd.Series(1.0, index=use.index)
        rec = {"geoid": geoid,
               "zillow_method": "town region" if len(town) else (
                   "community region" if len(use) == 1 else
                   f"housing-unit-weighted mean of {len(use)} community regions"),
               "zillow_regions": "; ".join(f"{r.region_name} ({r.region_id})" for r in use.itertuples())}
        for c in date_cols:
            v, ww = use[c], w[use[c].notna()]
            rec[c] = float((v.dropna() * ww).sum() / ww.sum()) if ww.sum() > 0 else None
        rows.append(rec)
    return pd.DataFrame(rows)


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["zillow"]
    if cfg["aggregation"] != "town_region_first":
        raise ValueError(f"unknown zillow aggregation {cfg['aggregation']!r}")
    path = download("zillow", cfg["url"].rsplit("/", 1)[-1], cfg["url"], timeout=600,
                    reuse_if_unchanged=True)
    links = write_crosswalk("zillow", zillow_regions(path), {"input_file": path.name})

    z = pd.read_csv(path)
    z = z[z.State == "NJ"]
    date_cols = [c for c in z.columns if c[:2] in ("19", "20") and "-" in c]
    latest = date_cols[-1]
    # Annual points at the latest month, for growth and sparklines.
    month = latest[5:7]
    yearly = [c for c in date_cols if c[5:7] == month][-HISTORY_YEARS:]
    values = z.set_index(z.RegionID.astype(str))[yearly]

    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    t = _town_values(values, links, munis, yearly)
    t = t.rename(columns={c: f"zhvi_{c[:7]}" for c in yearly})
    latest_col = f"zhvi_{latest[:7]}"
    t.insert(1, "zhvi", t[latest_col])
    t.insert(2, "zhvi_month", latest[:7])
    t = t[t.zhvi.notna()]

    month_name = pd.Timestamp(latest).strftime("%b %Y")
    return [FetchResult(
        "zillow_municipal", t, "geoid", vintage=f"Zillow ZHVI {month_name}",
        source="Zillow Research, " + cfg["series"], url=cfg["url"], attribution=ATTRIBUTION,
        notes=["Town value: the town's own Zillow region if one exists, else the housing-unit-weighted "
               "mean of community regions inside the town (see zillow_method).",
               "History columns zhvi_YYYY-MM are annual points at the latest month.",
               "Terms of use for republishing Zillow values: NOT YET VERIFIED (zillow.com blocks "
               "automated access); see docs/SOURCES_VERIFICATION.md."],
        extra={"latest_month": latest[:7], "nj_regions_in_file": int(len(z))})]
