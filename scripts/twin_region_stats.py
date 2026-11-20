"""Can statistics place the Zillow regions the crosswalk left unassigned?

    python scripts/twin_region_stats.py      # writes data/crosswalks/zillow_unmatched_stats.csv

Eight Zillow "city" regions are excluded in data/crosswalks/overrides.csv: six
borough/township twins sharing one name (Chatham, Chester, Freehold, Hopewell,
Mendham, Rockaway) and two communities on a county line (Asbury, Newfoundland).
This script tests each candidate town, and both twins together, against two
numbers Zillow publishes for every region:

  size   Zillow's SizeRank orders regions by size. On the 394 regions that are
         exactly one whole town, log(housing units) is close to linear in
         log(SizeRank); that fit predicts the region's housing units.
  price  The region's 2024 average ZHVI against each candidate's ACS 2020-2024
         median home value, compared with the typical ZHVI/ACS ratio of the same
         394 towns.

Each gives a z-score; the two are combined as a normal log-likelihood. A region
is only assigned when one single town beats every alternative (including "both
towns together") by a likelihood ratio of at least 10. The decision is written
to the CSV; overrides.csv is edited by hand.

Community regions (Asbury, Newfoundland) cover part of a town, so the size test
does not apply to them: their rows are reported but never decisive.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.common import CROSSWALKS, DATA, GEO  # noqa: E402

CASES = {  # region id -> candidate municipal codes
    41940: ("1404", "1405"), 833172: ("1406", "1407"), 395552: ("1316", "1317"),
    836126: ("1105", "1106"), 833168: ("1418", "1419"), 833175: ("1434", "1435"),
    399495: ("2105", "1002", "1025"), 53566: ("1414", "1615"),
}
COMMUNITIES = {399495, 53566}
DECISIVE = 10.0


def main() -> None:
    raw = sorted((DATA / "raw" / "zillow").glob("*/*.csv"))
    if not raw:
        raise SystemExit("no Zillow download in data/raw/zillow/; run scripts/refresh_data.py --only zillow")
    z = pd.read_csv(raw[-1])
    z = z[z.State == "NJ"].set_index("RegionID")
    y24 = [c for c in z.columns if c.startswith("2024-")]
    zh = z[y24].mean(axis=1)
    cw = pd.read_csv(CROSSWALKS / "zillow_crosswalk.csv", dtype={"mun_code": str, "geoid": str})
    acs = pd.read_csv(DATA / "interim" / "acs_municipal.csv", dtype={"geoid": str}).set_index("geoid")
    geo = pd.read_csv(GEO / "municipalities.csv", dtype=str).set_index("mun_code")

    cal = cw[(cw.method == "muni_full") & cw.region_id.isin(z.index) & cw.geoid.isin(acs.index)]
    cal = cal[cal.geoid.map(cw.groupby("geoid").size()) == 1]
    cal = cal[zh.loc[cal.region_id].notna().values]
    cal = cal[acs.loc[cal.geoid, "median_home_value"].notna().values &
              ~acs.loc[cal.geoid, "median_home_value_topcoded"].astype(bool).values]
    lsr, lhu = np.log(z.loc[cal.region_id, "SizeRank"].values), np.log(acs.loc[cal.geoid, "housing_units"].values)
    b, a = np.polyfit(lsr, lhu, 1)
    s_size = float(np.std(lhu - (a + b * lsr)))
    lr = np.log(zh.loc[cal.region_id].values) - np.log(acs.loc[cal.geoid, "median_home_value"].values)
    m_lr, s_lr = float(np.mean(lr)), float(np.std(lr))
    print(f"calibration: {len(cal)} whole-town regions; size fit slope {b:.2f}, residual sd {s_size:.2f}; "
          f"ZHVI/ACS log ratio {m_lr:.3f} +/- {s_lr:.3f}")

    out = []
    for rid, codes in CASES.items():
        hu_hat = float(np.exp(a + b * np.log(z.loc[rid, "SizeRank"])))
        cands = [(geo.loc[c, "name"], [geo.loc[c, "geoid"]]) for c in codes]
        if len(codes) == 2 and rid not in COMMUNITIES:
            cands.append(("both towns", [geo.loc[c, "geoid"] for c in codes]))
        rows = []
        for name, gs in cands:
            hu = float(sum(acs.loc[g, "housing_units"] for g in gs))
            v = float(np.average([acs.loc[g, "median_home_value"] for g in gs],
                                 weights=[acs.loc[g, "housing_units"] for g in gs]))
            zs = (np.log(hu) - np.log(hu_hat)) / s_size
            zl = (np.log(zh.loc[rid]) - np.log(v) - m_lr) / s_lr
            ll = -0.5 * (zl ** 2 + (0 if rid in COMMUNITIES else zs ** 2))
            rows.append({"region_id": rid, "region_name": z.loc[rid, "RegionName"], "candidate": name,
                         "housing_units": round(hu), "region_units_estimated": round(hu_hat),
                         "size_z": round(float(zs), 2), "acs_median_value": round(v),
                         "zhvi_2024": round(float(zh.loc[rid])), "price_z": round(float(zl), 2),
                         "loglik": round(float(ll), 3)})
        rows.sort(key=lambda r: -r["loglik"])
        ratio = float(np.exp(rows[0]["loglik"] - rows[1]["loglik"]))
        ok = ratio >= DECISIVE and rows[0]["candidate"] != "both towns" and rid not in COMMUNITIES
        for r in rows:
            r["best"] = r is rows[0]
            r["likelihood_ratio_vs_next"] = round(ratio, 1) if r is rows[0] else None
            r["decision"] = (f"assign to {rows[0]['candidate']}" if ok else "keep unassigned")
        print(f"{rows[0]['region_name']:13s} best: {rows[0]['candidate']:22s} ratio {ratio:6.1f}  -> {rows[0]['decision']}")
        out += rows
    pd.DataFrame(out).to_csv(CROSSWALKS / "zillow_unmatched_stats.csv", index=False)


if __name__ == "__main__":
    main()
