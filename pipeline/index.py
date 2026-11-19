"""Phase 3: OpenHousing index v2.

Builds one row per municipality (all 564, none dropped) from data/interim/,
using the assumptions in config.yaml, and writes the staged dataset to
data/build/openhousing_nj.csv plus data/build/index_meta.json. Phase 4
validation decides whether it gets published.

Two separate layers:

A. Affordability (the outcome): two separate scores, because owning and
   renting are largely separate markets.
   ownership score <- ownership_burden = annual ownership cost / county median
                      household income, where annual ownership cost = 12 x monthly
                      mortgage P&I on the typical home (rate from FRED, down payment
                      and term from config) + the town's average residential tax bill
   rental score    <- rent_burden = 12 x median gross rent / county median household income
   Each measure becomes a percentile (higher = more affordable); a score is the
   weighted mean of its measures (config index.scores), rescaled over the
   measures a town has. Context only, not scored: renters_cost_burdened (share
   of renter households paying 30%+ of their own income), town-income burdens,
   and the HUD 80%-AMI view.

B. Barriers (causes; never folded into the score)
   NZLUD zoning restrictiveness, Fourth Round present/prospective need,
   need per 1,000 households, Qualified Urban Aid status.

Missing inputs stay missing. A town with no usable component is kept with
an empty score and confidence "insufficient data".

Run:  python -m pipeline.index [--preview-zillow]
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd

from .common import DATA, GEO, load_config, log, setup_logging, today, write_json
from .fetchers.base import INTERIM

BUILD = DATA / "build"
PREVIEW = DATA / "preview"          # gitignored: builds that include uncleared sources
COMPONENTS = ["ownership_burden", "rent_burden", "renters_cost_burdened"]
LEVELS = {"high": 2, "medium": 1, "low": 0}
NAMES = {v: k for k, v in LEVELS.items()}


# --------------------------------------------------------------------------- formulas

def annual_mortgage_payment(price, rate_pct: float, down_payment_pct: float, term_years: int):
    """Standard fixed-rate amortization: 12 x L x i / (1 - (1 + i)^-n),
    L = price x (1 - down payment), i = annual rate / 12, n = 12 x term."""
    loan = np.asarray(price, dtype=float) * (1 - down_payment_pct / 100)
    i, n = rate_pct / 100 / 12, 12 * term_years
    if i == 0:
        return 12 * loan / n
    return 12 * loan * i / (1 - (1 + i) ** -n)


def percentile_rank(burden: pd.Series) -> pd.Series:
    """Affordability percentile of a burden measure across towns that have it.

    Midpoint (Hazen) percentile of the burden, (rank - 0.5) / N x 100, with
    ties sharing their average rank, then flipped so 100 = least burdened.
    Towns without the measure get NaN, not a rank.
    """
    n = burden.notna().sum()
    pct = (burden.rank(method="average") - 0.5) / n * 100
    return 100 - pct


def weighted_score(pctls: pd.DataFrame, weights: dict, min_components: int) -> tuple[pd.Series, pd.Series]:
    """Weighted mean of available component percentiles; weights rescaled per town."""
    w = pd.Series(weights, dtype=float)
    have = pctls.notna()
    num = (pctls.fillna(0) * w).sum(axis=1)
    den = (have * w).sum(axis=1)
    n_used = (have & (w > 0)).sum(axis=1)
    score = (num / den).where((den > 0) & (n_used >= min_components))
    return score, n_used


def cv_level(est: pd.Series, moe: pd.Series, cfg: dict) -> pd.Series:
    """ACS reliability tier from the coefficient of variation. A zero estimate
    has no defined CV and is treated as low confidence."""
    cv = (moe / 1.645) / est
    lvl = pd.Series("low", index=est.index)
    lvl[cv <= cfg["cv_medium_max"]] = "medium"
    lvl[cv <= cfg["cv_high_max"]] = "high"
    lvl[est.isna()] = None
    lvl[(est == 0)] = "low"
    return lvl


# --------------------------------------------------------------------------- inputs

def _read(name, key="geoid"):
    return pd.read_csv(INTERIM / f"{name}.csv", dtype={key: str})


def _meta(name):
    return json.loads((INTERIM / f"{name}.meta.json").read_text())


def build(include_uncleared: bool = False) -> tuple[pd.DataFrame, dict]:
    cfg = load_config()
    ccfg, own, ami, icfg = cfg["confidence"], cfg["ownership"], cfg["ami_view"], cfg["index"]
    if icfg["denominator"] != "county":
        raise ValueError("index.denominator other than 'county' is not implemented")

    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    df = munis[["geoid", "mun_code", "name", "census_name", "mun_type", "county", "county_fips"]].copy()
    df["population"] = munis.pop_acs.astype(float)

    acs = _read("acs_municipal")
    acs_c = _read("acs_county", "county_fips")
    tax = _read("property_tax_municipal")
    hud = _read("hud_county", "county_fips")
    fred = _meta("fred_mortgage30")
    nz = _read("nzlud_municipal")
    fr = _read("fourth_round_municipal")

    df = df.merge(acs[["geoid", "households", "renter_households",
                       "median_hh_income", "median_hh_income_moe", "median_hh_income_topcoded",
                       "median_home_value", "median_home_value_moe", "median_home_value_topcoded",
                       "median_gross_rent", "median_gross_rent_moe", "median_gross_rent_topcoded",
                       "renters_cost_burdened_share", "renters_cost_burdened_share_moe"]],
                  on="geoid", how="left", validate="one_to_one")
    df = df.rename(columns={"median_hh_income": "town_median_hh_income",
                            "median_hh_income_moe": "town_median_hh_income_moe",
                            "median_hh_income_topcoded": "town_median_hh_income_topcoded",
                            "median_home_value": "acs_median_home_value",
                            "median_home_value_moe": "acs_median_home_value_moe",
                            "median_home_value_topcoded": "acs_median_home_value_topcoded"})
    df = df.merge(acs_c[["county_fips", "median_hh_income", "median_hh_income_moe"]].rename(columns={
        "median_hh_income": "county_median_hh_income", "median_hh_income_moe": "county_median_hh_income_moe"}),
        on="county_fips", how="left", validate="many_to_one")
    df = df.merge(tax[["geoid", "avg_res_tax_bill", "tax_year"]].rename(
        columns={"avg_res_tax_bill": "avg_property_tax_bill"}), on="geoid", how="left", validate="one_to_one")
    lim = f"{ami['income_limit']}_p{ami['household_size']}"
    df = df.merge(hud[["county_fips", "hud_area_name", lim, "fmr_2br"]].rename(columns={lim: "ami80_income_limit"}),
                  on="county_fips", how="left", validate="many_to_one")

    # ---------------------------------------------------------------- home value
    zillow_ok = cfg["sources"]["zillow"]["cleared_for_publication"] or include_uncleared
    priority = [s for s in own["home_value_priority"] if s != "zillow" or zillow_ok]
    zmeta = None
    if "zillow" in priority and (INTERIM / "zillow_municipal.csv").exists():
        z = _read("zillow_municipal")
        zmeta = _meta("zillow_municipal")
        hist = sorted(c for c in z.columns if c.startswith("zhvi_20"))
        z["zhvi_1yr_change"] = z[hist[-1]] / z[hist[-2]] - 1 if len(hist) >= 2 else np.nan
        z["zhvi_5yr_change"] = z[hist[-1]] / z[hist[-6]] - 1 if len(hist) >= 6 else np.nan
        df = df.merge(z[["geoid", "zhvi", "zhvi_month", "zillow_method", "zillow_regions",
                         "zhvi_1yr_change", "zhvi_5yr_change"]], on="geoid", how="left", validate="one_to_one")
    else:
        priority = [s for s in priority if s != "zillow"]
        for c in ("zhvi", "zhvi_month", "zillow_method", "zillow_regions", "zhvi_1yr_change", "zhvi_5yr_change"):
            df[c] = np.nan

    acs_vintage = _meta("acs_municipal")["vintage"]
    df["home_value"] = np.nan
    df["home_value_source"] = None
    df["home_value_vintage"] = None
    for src in reversed(priority):            # later sources first, earlier ones overwrite
        col = "zhvi" if src == "zillow" else "acs_median_home_value"
        has = df[col].notna()
        df.loc[has, "home_value"] = df.loc[has, col]
        df.loc[has, "home_value_source"] = "Zillow ZHVI" if src == "zillow" else "ACS median value"
        df.loc[has, "home_value_vintage"] = (zmeta["vintage"] if src == "zillow" else acs_vintage)

    # Zillow vs ACS disagreement, relative to the statewide typical gap.
    ratio = df.zhvi / df.acs_median_home_value.where(~df.acs_median_home_value_topcoded.fillna(False))
    state_ratio = ratio.median()
    f = ccfg["value_disagreement_factor"]
    rel = ratio / state_ratio
    df["value_sources_disagree"] = ((rel > f) | (rel < 1 / f)).where(ratio.notna())

    # ---------------------------------------------------------------- A. affordability
    rate = float(fred["rate_used_pct"])
    df["mortgage_rate_pct"] = rate
    df["annual_mortgage_pi"] = annual_mortgage_payment(df.home_value, rate, own["down_payment_pct"],
                                                       own["loan_term_years"])
    df["annual_ownership_cost"] = df.annual_mortgage_pi + df.avg_property_tax_bill
    df["annual_rent"] = 12 * df.median_gross_rent

    df["ownership_burden"] = df.annual_ownership_cost / df.county_median_hh_income
    df["rent_burden"] = df.annual_rent / df.county_median_hh_income
    df["renters_cost_burdened"] = df.renters_cost_burdened_share
    # Display-only alternatives (not in the score).
    df["ownership_burden_town_income"] = df.annual_ownership_cost / df.town_median_hh_income
    df["rent_burden_town_income"] = df.annual_rent / df.town_median_hh_income
    df["ownership_burden_ami80"] = df.annual_ownership_cost / df.ami80_income_limit
    df["rent_burden_ami80"] = df.annual_rent / df.ami80_income_limit
    share = ami["affordable_share"]
    df["ownership_affordable_at_ami80"] = (df.ownership_burden_ami80 <= share).where(df.ownership_burden_ami80.notna())
    df["rent_affordable_at_ami80"] = (df.rent_burden_ami80 <= share).where(df.rent_burden_ami80.notna())

    pctls = pd.DataFrame({c: percentile_rank(df[c]) for c in COMPONENTS})
    for c in COMPONENTS:
        df[f"{c}_pctl"] = pctls[c]

    # ---------------------------------------------------------------- confidence
    val_conf = pd.Series(None, index=df.index, dtype=object)
    is_z = df.home_value_source == "Zillow ZHVI"
    val_conf[is_z & (df.zillow_method == "town region")] = "high"
    val_conf[is_z & (df.zillow_method != "town region")] = "medium"
    acs_used = df.home_value_source == "ACS median value"
    val_conf[acs_used] = cv_level(df.acs_median_home_value, df.acs_median_home_value_moe, ccfg)[acs_used]
    cap = LEVELS[ccfg["acs_home_value_max_confidence"]]
    val_conf[acs_used] = val_conf[acs_used].map(lambda v: NAMES[min(LEVELS[v], cap)] if isinstance(v, str) else v)
    val_conf[acs_used & df.acs_median_home_value_topcoded.fillna(False)] = "low"
    comp_conf = pd.DataFrame({
        "ownership_burden": val_conf.where(df.ownership_burden.notna()),
        "rent_burden": cv_level(df.median_gross_rent, df.median_gross_rent_moe, ccfg).where(df.rent_burden.notna()),
        "renters_cost_burdened": cv_level(df.renters_cost_burdened_share, df.renters_cost_burdened_share_moe,
                                          ccfg).where(df.renters_cost_burdened.notna()),
    })
    comp_conf.loc[df.median_gross_rent_topcoded.fillna(False) & df.rent_burden.notna(), "rent_burden"] = "low"
    for c in COMPONENTS:
        df[f"{c}_confidence"] = comp_conf[c]

    # ---------------------------------------------------------------- scores
    def topcoded_low(r, c) -> bool:
        """Low because the ACS value is top-coded, not because of its margin of error."""
        if c == "ownership_burden":
            return r.home_value_source == "ACS median value" and r.acs_median_home_value_topcoded in (True, "True")
        if c == "rent_burden":
            return r.median_gross_rent_topcoded in (True, "True")
        return False

    def reasons_for(r, used, score) -> str:
        why = []
        if pd.isna(score):
            why.append("no usable measure in any source")
        for c in used:
            lvl = comp_conf.at[r.Index, c]
            if not isinstance(lvl, str):
                why.append(f"{c.replace('_', ' ')} unavailable")
            elif lvl == "low" and not topcoded_low(r, c):
                why.append(f"{c.replace('_', ' ')} has a large ACS margin of error")
        if "ownership_burden" in used:
            if r.home_value_source == "ACS median value":
                why.append("home value is the ACS 5-year owner-reported median, not a current market price")
            if r.home_value_source == "ACS median value" and r.acs_median_home_value_topcoded in (True, "True"):
                why.append("the Census reports only that the home value is at least $2,000,000")
            if isinstance(r.zillow_method, str) and r.zillow_method != "town region":
                why.append("Zillow value is from community regions inside the town")
            if r.value_sources_disagree in (True, "True"):
                why.append("Zillow and ACS home values disagree more than usual")
        if "rent_burden" in used and r.median_gross_rent_topcoded in (True, "True"):
            why.append("the Census reports only that the median rent is at least $3,500")
        return "; ".join(why)

    score_meta = {}
    for sname, scfg in icfg["scores"].items():
        w = scfg["weights"]
        unknown = set(w) - set(COMPONENTS)
        if unknown:
            raise ValueError(f"score {sname!r} uses unknown measures {sorted(unknown)}")
        score, n_used = weighted_score(pctls[list(w)], w, icfg["min_components"])
        used = [c for c, v in w.items() if v > 0]
        pts = comp_conf[used].apply(lambda col: col.map(LEVELS))
        weakest = pts.min(axis=1)
        missing = pts.isna().sum(axis=1)
        lvl = weakest.where(missing == 0, np.minimum(weakest, LEVELS["medium"]))
        lvl = lvl.where(missing < 2, LEVELS["low"])
        conf = lvl.map(NAMES).astype(object)
        conf[score.isna()] = "insufficient data"
        df[f"{sname}_score"] = score
        df[f"{sname}_rank"] = score.rank(ascending=False, method="min").astype("Int64")
        df[f"{sname}_confidence"] = conf
        df[f"{sname}_confidence_reasons"] = [reasons_for(r, used, sc) for r, sc in
                                             zip(df.itertuples(), score)]
        score_meta[sname] = {
            "measures": w, "scored": int(score.notna().sum()),
            "unscored": df.loc[score.isna(), "name"].tolist(),
            "confidence_counts": conf.value_counts().to_dict()}

    # ---------------------------------------------------------------- B. barriers
    df = df.merge(nz, on="geoid", how="left", validate="one_to_one")
    df["zoning_data_available"] = df.zri.notna()
    df = df.merge(fr[["geoid", "housing_region", "present_need", "prospective_need",
                      "prospective_need_capped", "qualified_urban_aid"]],
                  on="geoid", how="left", validate="one_to_one")
    hh = df.households.where(df.households > 0)
    df["prospective_need_per_1000_hh"] = df.prospective_need_capped / hh * 1000
    df["total_need_per_1000_hh"] = (df.present_need + df.prospective_need_capped) / hh * 1000

    df["data_built"] = today()
    df = df.drop(columns=["census_name"])

    if len(df) != 564 or df.geoid.duplicated().any():
        raise RuntimeError(f"index has {len(df)} rows / duplicate GEOIDs; expected 564 unique")

    meta = {
        "built": today(),
        "rows": len(df),
        "scores": score_meta,
        "context_measures": icfg["context_measures"],
        "home_value_source_counts": df.home_value_source.value_counts(dropna=False).to_dict(),
        "home_value_priority_used": priority,
        "zillow_included": "zillow" in priority,
        "zillow_cleared_for_publication": cfg["sources"]["zillow"]["cleared_for_publication"],
        "statewide_zillow_to_acs_ratio": None if np.isnan(state_ratio) else round(float(state_ratio), 3),
        "denominator": icfg["denominator"],
        "assumptions": {"down_payment_pct": own["down_payment_pct"], "loan_term_years": own["loan_term_years"],
                        "mortgage_rate_pct": rate, "mortgage_rate_vintage": fred["vintage"],
                        "excluded_costs": own["excluded_costs"],
                        "ami_view": ami},
        "confidence_rules": ccfg,
        "vintages": {m.stem.replace(".meta", ""): json.loads(m.read_text())["vintage"]
                     for m in sorted(INTERIM.glob("*.meta.json"))
                     if "zillow" not in m.name or "zillow" in priority},
    }
    return df, meta


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Build the OpenHousing index")
    ap.add_argument("--preview-zillow", action="store_true",
                    help="include Zillow even though it isn't cleared; writes to data/preview/ (gitignored)")
    args = ap.parse_args(argv)
    setup_logging()
    df, meta = build(include_uncleared=args.preview_zillow)
    out = PREVIEW if args.preview_zillow else BUILD
    out.mkdir(parents=True, exist_ok=True)
    df.to_csv(out / "openhousing_nj.csv", index=False)
    write_json(out / "index_meta.json", meta)
    for name, sm in meta["scores"].items():
        log.info("%s score: %d of %d scored; confidence %s", name, sm["scored"], meta["rows"],
                 sm["confidence_counts"])
    log.info("home values %s -> %s", meta["home_value_source_counts"], out)


if __name__ == "__main__":
    main()
