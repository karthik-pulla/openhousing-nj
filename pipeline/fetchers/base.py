"""The common output shape every fetcher returns."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import pandas as pd

from ..common import DATA, GEO, log, today, write_json

INTERIM = DATA / "interim"   # tidy per-source tables; pipeline/index.py combines them


@dataclass
class FetchResult:
    name: str                 # file stem, e.g. "acs_municipal"
    table: pd.DataFrame
    key: str                  # "geoid" (municipality), "county_fips", or "date"
    vintage: str              # the period the data describes, e.g. "ACS 2020-2024 5-year"
    source: str               # human-readable source + publisher
    url: str
    attribution: str = ""     # exact wording the source requires, if any
    notes: list[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

    def coverage(self) -> dict:
        if self.key == "geoid_year":
            return {"rows": len(self.table), "municipalities_covered": int(self.table.geoid.nunique()),
                    "years": sorted(int(y) for y in self.table.year.unique())}
        if self.key != "geoid":
            return {"rows": len(self.table)}
        munis = pd.read_csv(GEO / "municipalities.csv", dtype=str)
        have = set(self.table.geoid)
        missing = munis[~munis.geoid.isin(have)]
        return {"rows": len(self.table), "municipalities_covered": len(have & set(munis.geoid)),
                "municipalities_missing": len(missing),
                "missing_sample": missing.name.head(15).tolist()}

    def save(self) -> dict:
        INTERIM.mkdir(parents=True, exist_ok=True)
        keys = ["geoid", "year"] if self.key == "geoid_year" else [self.key]
        if all(k in self.table for k in keys) and self.table.duplicated(keys).any():
            raise RuntimeError(f"{self.name}: duplicate {self.key} values")
        self.table.to_csv(INTERIM / f"{self.name}.csv", index=False)
        fetched_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
        meta = {"name": self.name, "fetched": today(), "fetched_at": fetched_at,
                "key": self.key, "vintage": self.vintage,
                "source": self.source, "url": self.url, "attribution": self.attribution,
                "columns": list(self.table.columns), "coverage": self.coverage(),
                "notes": self.notes, **self.extra}
        write_json(INTERIM / f"{self.name}.meta.json", meta)
        log.info("%s: %s rows, vintage %s", self.name, len(self.table), self.vintage)
        return meta
