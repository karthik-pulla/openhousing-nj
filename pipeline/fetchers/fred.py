"""30-year fixed mortgage rate (Freddie Mac PMMS) via the FRED API.

FRED series MORTGAGE30US is weekly and copyrighted by Freddie Mac
("Copyrighted: Citation Required"). Freddie Mac allows use with proper
attribution; the FRED API terms require the notice in ATTRIBUTION.
"""
from __future__ import annotations

import json

import pandas as pd

from ..common import download, load_config, require_env
from .base import FetchResult

URL = "https://api.stlouisfed.org/fred/series/observations"
ATTRIBUTION = ("Freddie Mac, 30-Year Fixed Rate Mortgage Average in the United States [MORTGAGE30US], "
               "retrieved from FRED, Federal Reserve Bank of St. Louis. "
               "This product uses the FRED® API but is not endorsed or certified by the "
               "Federal Reserve Bank of St. Louis.")


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["fred"]
    series, n = cfg["series"], int(cfg["trailing_weeks"])
    params = {"series_id": series, "api_key": require_env("FRED_API_KEY"), "file_type": "json",
              "sort_order": "desc", "limit": 260}            # ~5 years of weekly values
    path = download("fred", f"{series}.json", URL, params=params)
    obs = pd.DataFrame(json.loads(path.read_text())["observations"])
    obs["value"] = pd.to_numeric(obs["value"], errors="coerce")   # "." = missing week
    obs = obs.dropna(subset=["value"])[["date", "value"]].sort_values("date").reset_index(drop=True)
    if obs.empty:
        raise RuntimeError("FRED returned no observations")

    recent = obs.tail(n)
    rate = round(recent.value.mean(), 3)
    first, last = recent.date.iloc[0], recent.date.iloc[-1]
    return [FetchResult(
        "fred_mortgage30", obs.rename(columns={"value": "rate_pct"}), "date",
        vintage=f"Freddie Mac PMMS, mean of {n} weeks {first} to {last}",
        source="Freddie Mac Primary Mortgage Market Survey via FRED (series MORTGAGE30US)",
        url=f"https://fred.stlouisfed.org/series/{series}", attribution=ATTRIBUTION,
        notes=[f"Rate used for ownership cost = mean of the last {n} weekly observations."],
        extra={"rate_used_pct": rate, "latest_week": last, "latest_rate_pct": float(obs.value.iloc[-1]),
               "weeks_averaged": n})]
