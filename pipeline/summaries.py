"""Phase 6: plain-English summaries for every municipality, from templates.

Not written by a language model. Each summary is a sequence of fixed
sentences (templates/summary_templates.yaml) chosen by simple rules below
and filled with numbers from the dataset. Every sentence records the
dataset columns it used and the sources behind them, so each claim can be
traced to a number and a source.

Output: data/build/summaries.json
  {"generated": ..., "sources": {key: {name, vintage, attribution}},
   "towns": {geoid: {"name", "summary", "sentences": [{"id", "text", "fields", "sources"}]}}}

Rounding (stated in METHODOLOGY.md): home values and yearly costs to the
nearest $1,000 (nearest $100 under $100,000); rents to the nearest $10;
shares to whole percents; per-1,000 rates to one decimal.

Run:  python -m pipeline.summaries
"""
from __future__ import annotations

import json
import math
import re
import string

import numpy as np
import pandas as pd
import yaml

from .common import ROOT, load_config, log, setup_logging, today, write_json
from .fetchers.base import INTERIM
from .index import BUILD

TEMPLATES = ROOT / "templates" / "summary_templates.yaml"
OUT = BUILD / "summaries.json"
BANNED = re.compile(r"\b(met|fail(ed|s|ing)?|complian(t|ce)|non-?compliant)\b", re.I)  # we have no construction data

# sentence id -> sources it draws on (keys of SOURCE_META)
SENTENCE_SOURCES = {
    "home_value": ["home_value"], "home_value_topcoded": ["home_value"], "home_value_missing": ["home_value"],
    "ownership_cost": ["home_value", "fred", "property_tax", "acs"],
    "ownership_rank": ["home_value", "fred", "property_tax", "acs"],
    "ownership_most": ["home_value", "fred", "property_tax", "acs"],
    "ownership_least": ["home_value", "fred", "property_tax", "acs"],
    "rent": ["acs"], "rent_most": ["acs"], "rent_least": ["acs"], "rent_missing": ["acs"],
    "renters_burdened": ["acs"], "renters_burdened_unreliable": ["acs"],
    "ami80": ["hud", "home_value", "fred", "property_tax", "acs"],
    "ami80_own_only": ["hud", "home_value", "fred", "property_tax"],
    "obligation": ["fourth_round", "acs"], "obligation_urban_aid": ["fourth_round"],
    "zoning_restrictive": ["nzlud"],
    "limited_data": ["acs"], "acs_value_note": ["acs"],
}


# --------------------------------------------------------------------------- formatting

def money(v: float) -> str:
    step = 1000 if v >= 100_000 else 100 if v >= 1000 else 10
    return f"${int(round(v / step) * step):,}"


def rent_money(v: float) -> str:
    return f"${int(round(v / 10) * 10):,}"


def pct(v: float) -> str:
    return f"{round(v * 100):.0f}%"


def ordinal(n: int) -> str:
    n = int(n)
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n:,}{suffix}"


def number(v: float) -> str:
    return f"{int(round(v)):,}"


def _has(v) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v)) and v is not pd.NA


def _true(v) -> bool:
    return v is True or str(v) == "True"


# --------------------------------------------------------------------------- rendering

class Renderer:
    def __init__(self, df: pd.DataFrame, cfg: dict, templates: dict, acs_vintage: str):
        self.cfg = cfg["summaries"]
        self.t = templates
        self.acs_vintage = acs_vintage
        self.n = {s: int(df[f"{s}_score"].notna().sum()) for s in ("ownership", "rental")}
        zri = df.zri.dropna()
        self.nzlud_n = len(zri)
        self.zri_cut = zri.quantile(self.cfg["restrictive_zoning_quantile"]) if len(zri) else np.inf
        for name in templates:
            if name not in SENTENCE_SOURCES:
                raise ValueError(f"template {name!r} has no entry in SENTENCE_SOURCES")

    def _fill(self, sid: str, values: dict, fields: list[str]) -> dict:
        tmpl = self.t[sid]
        needed = {f for _, f, _, _ in string.Formatter().parse(tmpl) if f}
        missing = needed - set(values)
        if missing:
            raise KeyError(f"template {sid!r} needs {sorted(missing)}")
        text = " ".join(tmpl.format(**values).split())
        return {"id": sid, "text": text, "fields": fields, "sources": SENTENCE_SOURCES[sid]}

    def _band(self, rank, n) -> str | None:
        if not _has(rank):
            return None
        top = math.ceil(self.cfg["most_affordable_share"] * n)
        bottom = math.ceil(self.cfg["least_affordable_share"] * n)
        if rank <= top:
            return "most"
        if rank > n - bottom:
            return "least"
        return None

    def town(self, r: pd.Series) -> list[dict]:
        S = []
        base = {"name": r["name"], "county": r.county}

        # ownership
        if _has(r.home_value):
            sid = "home_value_topcoded" if (r.home_value_source == "ACS median value"
                                            and _true(r.acs_median_home_value_topcoded)) else "home_value"
            S.append(self._fill(sid, {**base, "home_value": money(r.home_value)},
                                ["home_value", "home_value_source", "home_value_vintage"]))
            if _has(r.ownership_score):
                S.append(self._fill("ownership_cost", {
                    "annual_ownership_cost": money(r.annual_ownership_cost),
                    "avg_property_tax_bill": money(r.avg_property_tax_bill),
                    "ownership_burden": pct(r.ownership_burden)},
                    ["annual_ownership_cost", "annual_mortgage_pi", "avg_property_tax_bill",
                     "mortgage_rate_pct", "county_median_hh_income", "ownership_burden"]))
                S.append(self._fill("ownership_rank", {"ownership_rank": ordinal(r.ownership_rank),
                                                       "ownership_n": number(self.n["ownership"])},
                                    ["ownership_rank", "ownership_score"]))
                band = self._band(r.ownership_rank, self.n["ownership"])
                if band:
                    S.append(self._fill(f"ownership_{band}", base, ["ownership_rank"]))
        else:
            S.append(self._fill("home_value_missing", base, ["home_value"]))

        # rental
        if _has(r.rental_score):
            S.append(self._fill("rent", {"median_gross_rent": rent_money(r.median_gross_rent),
                                         "rent_burden": pct(r.rent_burden),
                                         "rental_rank": ordinal(r.rental_rank),
                                         "rental_n": number(self.n["rental"])},
                                ["median_gross_rent", "county_median_hh_income", "rent_burden", "rental_rank"]))
            band = self._band(r.rental_rank, self.n["rental"])
            if band:
                S.append(self._fill(f"rent_{band}", base, ["rental_rank"]))
        else:
            S.append(self._fill("rent_missing", base, ["median_gross_rent"]))

        if _has(r.renters_cost_burdened_share) and r.renter_households > 0:
            sid = ("renters_burdened_unreliable" if r.renters_cost_burdened_confidence == "low"
                   else "renters_burdened")
            S.append(self._fill(sid,
                                {"renters_cost_burdened_share": pct(r.renters_cost_burdened_share)},
                                ["renters_cost_burdened_share", "renters_cost_burdened_share_moe"]))

        # 80% AMI view
        verdict = lambda ok: "could afford" if _true(ok) else "could not afford"  # noqa: E731
        if _has(r.ownership_burden_ami80):
            vals = {"ami80_income_limit": money(r.ami80_income_limit),
                    "own_verdict": verdict(r.ownership_affordable_at_ami80)}
            if _has(r.rent_burden_ami80):
                own, rent = _true(r.ownership_affordable_at_ami80), _true(r.rent_affordable_at_ami80)
                phrase = {(True, True): "could afford both the typical home's ownership costs and the median rent",
                          (False, False): "could afford neither the typical home's ownership costs nor the median rent",
                          (False, True): "could afford the median rent but not the typical home's ownership costs",
                          (True, False): "could afford the typical home's ownership costs but not the median rent",
                          }[(own, rent)]
                S.append(self._fill("ami80", {"ami80_income_limit": vals["ami80_income_limit"],
                                              "ami80_verdict": phrase},
                                    ["ami80_income_limit", "ownership_burden_ami80", "rent_burden_ami80"]))
            else:
                S.append(self._fill("ami80_own_only", vals, ["ami80_income_limit", "ownership_burden_ami80"]))

        # barriers: obligations, zoning
        present = number(r.present_need)
        if _true(r.qualified_urban_aid):
            S.append(self._fill("obligation_urban_aid", {**base, "present_need": present,
                                                         "units_word": "unit" if present == "1" else "units"},
                                ["qualified_urban_aid", "present_need"]))
        else:
            per = r.prospective_need_per_1000_hh
            pn = number(r.prospective_need_capped)
            S.append(self._fill("obligation", {
                **base, "prospective_need_capped": pn, "units_word": "unit" if pn == "1" else "units",
                "prospective_need_per_1000_hh": f"{per:.1f}" if _has(per) else "n/a",
                "present_need": present},
                ["prospective_need_capped", "prospective_need_per_1000_hh", "present_need", "households"]))
        if _has(r.zri) and r.zri >= self.zri_cut:
            S.append(self._fill("zoning_restrictive", {"nzlud_n": number(self.nzlud_n)}, ["zri"]))

        # data quality
        # The ACS-value caveat gets its own sentence below, so it isn't repeated here.
        reasons = []
        for s in ("ownership", "rental"):
            if r[f"{s}_confidence"] == "low":
                parts = [p for p in str(r[f"{s}_confidence_reasons"]).split("; ")
                         if p and not p.startswith("home value is the ACS")]
                if parts:
                    reasons.append(f"{s}: " + ", ".join(parts))
        if reasons:
            S.append(self._fill("limited_data", {"limited_reasons": "; ".join(reasons)},
                                ["ownership_confidence", "rental_confidence"]))
        if r.home_value_source == "ACS median value" and _has(r.ownership_score):
            S.append(self._fill("acs_value_note", {"acs_vintage": self.acs_vintage.replace(" 5-year", "")},
                                ["home_value_source", "home_value_vintage"]))
        return S


def source_meta() -> dict:
    """Short source records keyed as in SENTENCE_SOURCES, from the fetchers' metadata."""
    def m(name):
        return json.loads((INTERIM / f"{name}.meta.json").read_text())
    acs, tax, hud, fred, nz, fr = (m(n) for n in ("acs_municipal", "property_tax_municipal", "hud_county",
                                                   "fred_mortgage30", "nzlud_municipal", "fourth_round_municipal"))
    cfg = load_config()
    zillow_ok = cfg["sources"]["zillow"]["cleared_for_publication"]
    hv = ("Zillow Home Value Index where available, otherwise U.S. Census Bureau ACS median value"
          if zillow_ok else "U.S. Census Bureau ACS median value")
    return {
        "acs": {"name": "U.S. Census Bureau, American Community Survey", "vintage": acs["vintage"],
                "attribution": acs["attribution"]},
        "home_value": {"name": hv, "vintage": acs["vintage"] if not zillow_ok else "see home_value_vintage",
                       "attribution": acs["attribution"]},
        "property_tax": {"name": tax["source"], "vintage": tax["vintage"], "attribution": tax["attribution"]},
        "hud": {"name": hud["source"], "vintage": hud["vintage"], "attribution": hud["attribution"]},
        "fred": {"name": fred["source"], "vintage": fred["vintage"], "attribution": fred["attribution"]},
        "nzlud": {"name": nz["source"], "vintage": nz["vintage"], "attribution": nz["attribution"]},
        "fourth_round": {"name": fr["source"], "vintage": fr["vintage"], "attribution": fr["attribution"]},
    }


def check_text(text: str) -> list[str]:
    """Problems that must never reach the site."""
    probs = []
    if re.search(r"[{}]", text):
        probs.append("unfilled template blank")
    if re.search(r"\b(nan|None|NaT|<NA>)\b", text):
        probs.append("missing value printed as text")
    if BANNED.search(text):
        probs.append(f"banned wording: {BANNED.search(text).group(0)!r}")
    return probs


def build(df: pd.DataFrame | None = None) -> dict:
    cfg = load_config()
    if df is None:
        df = pd.read_csv(BUILD / "openhousing_nj.csv", dtype={"geoid": str, "mun_code": str, "county_fips": str})
    templates = yaml.safe_load(TEMPLATES.read_text())
    acs_vintage = json.loads((INTERIM / "acs_municipal.meta.json").read_text())["vintage"]
    R = Renderer(df, cfg, templates, acs_vintage)
    towns, problems = {}, []
    for _, r in df.iterrows():
        sents = R.town(r)
        text = " ".join(s["text"] for s in sents)
        for p in check_text(text):
            problems.append(f"{r['name']}: {p}")
        towns[r.geoid] = {"name": r["name"], "summary": text, "sentences": sents}
    if problems:
        raise RuntimeError("summary problems: " + "; ".join(problems[:20]))
    return {"generated": today(), "generator": "pipeline/summaries.py + templates/summary_templates.yaml "
            "(rule-based templates; no language model)", "rules": cfg["summaries"],
            "sources": source_meta(), "towns": towns}


def main() -> None:
    setup_logging()
    out = build()
    write_json(OUT, out)
    log.info("summaries: %d towns -> %s", len(out["towns"]), OUT)


if __name__ == "__main__":
    main()
