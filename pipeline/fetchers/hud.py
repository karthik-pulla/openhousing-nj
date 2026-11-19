"""HUD Income Limits and Fair Market Rents for each NJ county (HUD USER API).

Income limits (30% / 50% / 80% of area median income, by household size)
and FMRs are set for HUD areas (metros/HMFAs). Querying by county returns
the limits of the area that county belongs to; `area_name` records which.
HUD's rate limit is 60 calls/minute, so calls are spaced out.
"""
from __future__ import annotations

import json
import time

import pandas as pd

from ..common import STATE_FIPS, download, load_config, log, raw_dir, require_env
from .base import FetchResult

ATTRIBUTION = "This product uses the HUD User Data API but is not endorsed or certified by HUD User."


def _get(base: str, path: str, filename: str, year, pause: float) -> dict:
    headers = {"Authorization": f"Bearer {require_env('HUD_API_TOKEN')}"}
    params = {"year": year} if year else None
    cached = (raw_dir("hud") / filename).exists()
    out = download("hud", filename, f"{base}/{path}", params=params, headers=headers)
    if not cached:
        time.sleep(pause)                    # stay under HUD's 60 calls/minute
    return json.loads(out.read_text())


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["hud"]
    base, year, pause = cfg["base"], cfg["year"], float(cfg["seconds_between_calls"])
    counties = _get(base, "fmr/listCounties/NJ", "listCounties_NJ.json", None, pause)
    rows = []
    for c in counties:
        entity = c["fips_code"]                              # e.g. 3400199999
        if not entity.startswith(STATE_FIPS) or not entity.endswith("99999"):
            log.warning("HUD: skipping non-county entity %s %s", entity, c.get("county_name"))
            continue
        il = _get(base, f"il/data/{entity}", f"il_{entity}.json", year, pause)["data"]
        fmr = _get(base, f"fmr/data/{entity}", f"fmr_{entity}.json", year, pause)["data"]
        basic = fmr["basicdata"]
        small_area = isinstance(basic, list)
        if small_area:
            # Small Area FMR areas (e.g. Bergen-Passaic) list ZIP-level FMRs plus one
            # "MSA level" row; we use the area-wide row and flag it.
            msa = [b for b in basic if b.get("zip_code") == "MSA level"]
            if len(msa) != 1:
                raise RuntimeError(f"HUD FMR for {entity}: no single 'MSA level' row")
            basic = {**msa[0], "year": fmr.get("year") or msa[0].get("year")}
        row = {"county_fips": entity[:5], "hud_county_name": il["county_name"],
               "hud_area_name": il["area_name"], "il_year": int(il["year"]),
               "hud_median_family_income": il["median_income"]}
        for tier, key in (("il30", "extremely_low"), ("il50", "very_low"), ("il80", "low")):
            for p in range(1, 9):
                row[f"{tier}_p{p}"] = il[key][f"{tier}_p{p}"]
        row["fmr_year"] = int(basic["year"])
        row["fmr_small_area"] = small_area
        for k, col in (("Efficiency", "fmr_0br"), ("One-Bedroom", "fmr_1br"), ("Two-Bedroom", "fmr_2br"),
                       ("Three-Bedroom", "fmr_3br"), ("Four-Bedroom", "fmr_4br")):
            row[col] = basic[k]
        rows.append(row)

    df = pd.DataFrame(rows).sort_values("county_fips").reset_index(drop=True)
    if len(df) != 21:
        raise RuntimeError(f"HUD returned {len(df)} NJ counties, expected 21")
    il_years, fmr_years = sorted(df.il_year.unique()), sorted(df.fmr_year.unique())
    return [FetchResult(
        "hud_county", df, "county_fips",
        vintage=f"HUD FY{il_years[-1]} Income Limits; FY{fmr_years[-1]} Fair Market Rents",
        source="U.S. Department of Housing and Urban Development, HUD USER API",
        url="https://www.huduser.gov/portal/dataset/fmr-api.html", attribution=ATTRIBUTION,
        notes=["Limits apply to HUD areas; a county inherits its area's limits (see hud_area_name).",
               "hud_median_family_income is HUD's area median family income (AMI), not ACS median "
               "household income.",
               "fmr_small_area = True: HUD sets ZIP-level Small Area FMRs there; the area-wide "
               "('MSA level') FMR is used."],
        extra={"il_years": il_years, "fmr_years": fmr_years})]
