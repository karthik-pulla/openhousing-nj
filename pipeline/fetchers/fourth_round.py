"""Fourth Round (2025-2035) affordable housing obligations, NJ DCA.

Source: "Affordable Housing Obligations for 2025-2035 (Fourth Round)
Methodology and Background", NJ Department of Community Affairs, October
2024 (PDF created 2024-10-21), Appendix A. There is no API, so:

  * `parse_pdf()` extracts Appendix A once into a hand-checkable CSV
    (data/static/fourth_round/obligations_dca_2024.csv). It refuses to
    write unless the parsed totals equal the report's own TOTAL row.
  * `fetch()` reads that CSV. To update obligations later (e.g. with
    court-settled numbers), edit or replace the CSV and its .meta.json;
    see README "Updating the obligations file".

These are DCA's calculated (advisory) obligations under P.L.2024, c.2.
Municipalities could adopt different numbers through the Affordable Housing
Dispute Resolution Program, so they are labelled as DCA's calculation.

Qualified Urban Aid municipalities (47, per report pp. 9-10): the report
states they "received an average allocation factor of 0 since they have no
prospective need obligations under the Affordable Housing Law". They can
still have a present need. The CSV carries the report's own Yes/No column.
"""
from __future__ import annotations

import re

import pandas as pd

from ..common import GEO, ROOT, load_config, log, write_json
from ..crosswalk import base_key, full_key
from .base import FetchResult

COUNTIES = ["Atlantic", "Bergen", "Burlington", "Camden", "Cape May", "Cumberland", "Essex",
            "Gloucester", "Hudson", "Hunterdon", "Mercer", "Middlesex", "Monmouth", "Morris", "Ocean",
            "Passaic", "Salem", "Somerset", "Sussex", "Union", "Warren"]
REPORT_TOTALS = {"present_need": 65410, "prospective_need": 84698, "prospective_need_capped": 80798}
SOURCE = ("New Jersey Department of Community Affairs, Affordable Housing Obligations for 2025-2035 "
          "(Fourth Round) Methodology and Background, October 2024, Appendix A")

_num = r"-?[\d,]+"
_pct = r"-?\d+\.\d+%"
ROW = re.compile(
    rf"^(?P<name_county>.+?) (?P<region>[1-6]) (?P<present_need>{_num}) (?P<urban_aid>Yes|No) "
    rf"(?P<f_nonres>{_pct}) (?P<f_land>{_pct}) (?P<f_income>{_pct}) (?P<f_avg>{_pct}) "
    rf"(?P<prospective_need>{_num}) (?P<cap>{_num}) (?P<prospective_need_capped>{_num})$")


def parse_pdf(pdf_path, csv_path) -> pd.DataFrame:
    from pypdf import PdfReader
    reader = PdfReader(str(pdf_path))
    rows = []
    for page in reader.pages[19:41]:                     # Appendix A, report pp. 20-41
        prev = ""
        for line in page.extract_text().splitlines():
            line = re.sub(r"\s+", " ", line).strip()
            m = ROW.match(line)
            if not m:
                prev = line
                continue
            nc = m["name_county"]
            # Long names wrap: "Parsippany-Troy Hills" / "township Morris 2 138 ..."
            if re.match(r"^(township|borough|city|town|village) ", nc):
                nc = f"{prev} {nc}"
            prev = ""
            county = next((c for c in sorted(COUNTIES, key=len, reverse=True) if nc.endswith(" " + c)), None)
            if county is None:
                raise RuntimeError(f"Appendix A row with unknown county: {line!r}")
            rec = {"dca_name": nc[: -len(county) - 1].strip(), "county": county, "housing_region": int(m["region"]),
                   "present_need": int(m["present_need"].replace(",", "")),
                   "qualified_urban_aid": m["urban_aid"] == "Yes"}
            for k in ("f_nonres", "f_land", "f_income", "f_avg"):
                rec[k] = float(m[k].rstrip("%")) / 100
            for k in ("prospective_need", "cap", "prospective_need_capped"):
                rec[k] = int(m[k].replace(",", ""))
            rows.append(rec)
    df = pd.DataFrame(rows).rename(columns={
        "f_nonres": "factor_nonresidential_valuation", "f_land": "factor_land_capacity",
        "f_income": "factor_income_capacity", "f_avg": "factor_average_allocation",
        "cap": "cap_1000_or_20pct"})
    if len(df) != 564:
        raise RuntimeError(f"Parsed {len(df)} Appendix A rows, expected 564")
    for col, total in REPORT_TOTALS.items():
        if int(df[col].sum()) != total:
            raise RuntimeError(f"Appendix A {col} sums to {df[col].sum()}, report TOTAL says {total}")
    df.to_csv(csv_path, index=False)
    write_json(csv_path.with_suffix(".meta.json"), {
        "source": SOURCE, "publisher": "NJ Department of Community Affairs",
        "published": "2024-10 (PDF creation date 2024-10-21)",
        "extracted_from": str(pdf_path.relative_to(ROOT)), "rows": len(df),
        "totals_match_report": REPORT_TOTALS,
        "status": "DCA calculation (advisory under P.L.2024, c.2); municipalities may have adopted "
                  "different numbers. Not a record of units built.",
        "last_hand_update": None,
    })
    log.info("parsed Appendix A: %d rows, totals match the report", len(df))
    return df


def fetch() -> list[FetchResult]:
    cfg = load_config()["sources"]["fourth_round"]
    csv_path, pdf_path = ROOT / cfg["csv"], ROOT / cfg["pdf"]
    if not csv_path.exists():
        parse_pdf(pdf_path, csv_path)
    df = pd.read_csv(csv_path)

    # Join by DCA's Census-style name + county; both come from Census naming
    # ("Absecon city", "Atlantic"), and (name, county) is unique in NJ.
    # DCA writes "Atlantic City" where Census writes "Atlantic City city", so a
    # DCA name may equal a Census name without its type word (used only when
    # that is unique in the county).
    munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
    by_full = {(r.county, full_key(r.census_name)): r.geoid for r in munis.itertuples()}
    base = pd.Series([(r.county, base_key(r.census_name)) for r in munis.itertuples()])
    by_base = {k: g for k, g in zip(base, munis.geoid) if (base == k).sum() == 1}
    df["geoid"] = [by_full.get((c, full_key(n))) or by_base.get((c, full_key(n)))
                   for n, c in zip(df.dca_name, df.county)]
    out = munis[["geoid"]].merge(df, on="geoid", how="outer", indicator=True)
    if df.geoid.duplicated().any() or df.geoid.isna().any():
        bad = df[df.geoid.isna() | df.geoid.duplicated(keep=False)]
        raise RuntimeError(f"Fourth Round rows not joined 1:1: {bad[['dca_name', 'county']].to_dict('records')}")
    bad = out[out._merge != "both"]
    if len(bad):
        raise RuntimeError(f"Municipalities with no Fourth Round row: {bad.geoid.tolist()}")
    out = out.drop(columns=["_merge", "county"])
    meta_path = csv_path.with_suffix(".meta.json")
    meta = pd.read_json(meta_path, typ="series") if meta_path.exists() else {}
    return [FetchResult(
        "fourth_round_municipal", out, "geoid",
        vintage="DCA Fourth Round calculation, October 2024 (obligations for 2025-2035)",
        source=SOURCE, url=str(cfg["pdf"]), attribution="Source: " + SOURCE + ".",
        notes=["prospective_need_capped is the obligation after the 1,000-unit / 20% cap.",
               "Qualified Urban Aid municipalities have no prospective need obligation under the "
               "Affordable Housing Law (report p. 18); their prospective-need zeros are not missing "
               "data. They may still have a present need.",
               "Obligations are calculated need, not units built. Never describe a town as having "
               "met or failed its obligation."],
        extra={"status": meta.get("status") if len(meta) else None})]
