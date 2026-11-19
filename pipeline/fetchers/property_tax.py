"""Average residential property tax bill by municipality (NJ DCA, Division of
Local Government Services, "Property Tax Tables" workbook, sheet
"Municipal Tax Summary").

Keyed by the NJ 4-digit municipal code, so it joins exactly. The newest tax
year is found by probing the file URL from this year downward.

Columns kept:
  avg_res_assessed_value  average assessed value of a residential property
  avg_res_tax_bill        average total property tax (county + municipal + school) on a
                          residential property at that value, before credits and deductions
  equalization_ratio      State Equalization Table average ratio (assessed / market value)
  effective_tax_rate      avg_res_tax_bill / (avg_res_assessed_value / equalization_ratio):
                          the tax as a share of estimated market value (derived here)
"""
from __future__ import annotations

import datetime as dt

import pandas as pd
import requests

from ..common import GEO, download, load_config, log
from .base import FetchResult

SHEET = "Municipal Tax Summary"
COLS = {
    "MuniCode": "mun_code",
    "Average Residential Property Value": "avg_res_assessed_value",
    "Average Total Property Taxes (not including credits and deductions)": "avg_res_tax_bill",
    "State Equalization Table Average Ratio (Decimal Form)": "equalization_ratio",
}


def newest_year(pattern: str) -> tuple[int, str]:
    this = dt.date.today().year
    for year in range(this, this - 4, -1):
        url = pattern.format(yy=f"{year % 100:02d}")
        try:
            if requests.head(url, timeout=30, allow_redirects=True).status_code == 200:
                return year, url
        except requests.RequestException as e:
            log.warning("probe failed %s: %s", url, e)
    raise RuntimeError("No NJ DCA property tax table found for the last 4 years")


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["property_tax"]
    year, url = newest_year(cfg["url_pattern"])
    path = download("nj_dlgs", url.rsplit("/", 1)[-1], url)
    raw = pd.read_excel(path, sheet_name=SHEET, header=1, dtype={"MuniCode": str}, engine="xlrd")
    missing = [c for c in COLS if c not in raw.columns]
    if missing:
        raise RuntimeError(f"{path.name}: expected columns not found (schema changed?): {missing}")
    df = raw[list(COLS)].rename(columns=COLS)
    df = df[df.mun_code.astype(str).str.fullmatch(r"\d{4}")].copy()
    for c in ("avg_res_assessed_value", "avg_res_tax_bill", "equalization_ratio"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["effective_tax_rate"] = df.avg_res_tax_bill / (df.avg_res_assessed_value / df.equalization_ratio)

    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)[["geoid", "mun_code"]]
    out = munis.merge(df, on="mun_code", how="left", validate="one_to_one")
    unknown = set(df.mun_code) - set(munis.mun_code)
    if unknown:
        raise RuntimeError(f"property tax file has municipal codes not in the backbone: {sorted(unknown)}")
    out = out[out.avg_res_tax_bill.notna()].drop(columns="mun_code")
    out["tax_year"] = year
    return [FetchResult(
        "property_tax_municipal", out, "geoid", vintage=f"NJ DCA {year} Property Tax Tables (tax year {year})",
        source="New Jersey Department of Community Affairs, Division of Local Government Services",
        url=cfg["page"], attribution=f"Source: NJ Department of Community Affairs, {year} Property Tax Tables.",
        notes=["Average bill is before credits/deductions (e.g. ANCHOR, Senior Freeze).",
               "effective_tax_rate is derived: bill / (assessed value / equalization ratio)."],
        extra={"tax_year": year, "file": url})]
