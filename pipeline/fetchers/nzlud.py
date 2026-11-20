"""NZLUD zoning restrictiveness (Mleczko & Desmond, Eviction Lab / Princeton).

A static file (last changed upstream 2023-03-17), stored in data/static and
never re-downloaded. Each run checks that the committed copy still matches
the upstream file's SHA-256 (warning only; the local copy is what we use).
Coverage is partial: 105 of 564 NJ municipalities.

The license on the GitHub repo is MIT for "the software"; it does not say
whether it covers the data. See docs/SOURCES_VERIFICATION.md.
"""
from __future__ import annotations

import hashlib

import pandas as pd
import requests

from ..common import CROSSWALKS, ROOT, load_config, log
from ..crosswalk import build_nzlud
from .base import FetchResult

KEEP = {"zri": "zri", "min_lot_size": "nzlud_min_lot_size", "one_acre_more": "nzlud_one_acre_more",
        "inclusionary": "nzlud_inclusionary", "open_space": "nzlud_open_space",
        # Shown in v1's town panel; context only, never scored (NZLUD data dictionary):
        "adu": "nzlud_adu",                    # 1 = accessory dwelling units allowed somewhere in the town
        "parking_median": "nzlud_parking_median",  # median parking spaces required per residential unit
        "mf_per": "nzlud_mf_per"}              # share of residential districts allowing multifamily by right
CITATION = ("Mleczko, Matthew, and Matthew Desmond. 2023. National Zoning and Land Use Database "
            "(NZLUD). https://github.com/mtmleczko/nzlud")


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["nzlud"]
    local = ROOT / cfg["local"]
    sha = hashlib.sha256(local.read_bytes()).hexdigest()
    try:
        up = hashlib.sha256(requests.get(cfg["upstream"], timeout=60).content).hexdigest()
        if up != sha:
            log.warning("NZLUD upstream file changed (sha %s vs local %s); review before updating", up, sha)
    except requests.RequestException as e:
        up = None
        log.warning("could not check NZLUD upstream: %s", e)

    build_nzlud()
    xw = pd.read_csv(CROSSWALKS / "nzlud_crosswalk.csv", dtype=str)
    n = pd.read_csv(local, encoding="latin1", dtype={"GEOID": str})
    n = n[n.statename.str.upper() == "NJ"]
    df = xw[["nzlud_geoid", "geoid"]].merge(n, left_on="nzlud_geoid", right_on="GEOID")
    out = df[["geoid"] + list(KEEP)].rename(columns=KEEP)
    return [FetchResult(
        "nzlud_municipal", out, "geoid", vintage="NZLUD (municipal surveys 2019-2022; file 2023)",
        source="National Zoning and Land Use Database, Eviction Lab (Princeton University)",
        url="https://github.com/mtmleczko/nzlud", attribution=CITATION,
        notes=["Higher zri = more restrictive zoning.", "Covers 105 of 564 NJ municipalities."],
        extra={"sha256_local": sha, "sha256_upstream": up, "upstream_matches": up == sha})]
