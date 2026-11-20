"""Dated release archive, changelog and per-town change history.

Every time a dataset passes validation and is published, a copy is kept:

  data/archive/releases/<YYYY-MM-DD>/openhousing_nj.csv.gz   the full dataset as published (date in NJ time)
  data/archive/releases/<YYYY-MM-DD>/manifest.json           its sources, periods and checks
  data/archive/index.json                                    every release, newest first
  data/archive/CHANGELOG.md                                  what changed in each release
  data/published/town_changes.web.json                       tracked fields for every town in
                                                             every release (the town "History" button)

A rerun on the same day replaces that day's release. Older releases are never
changed, so anyone can cite a release by its date and download it later.
"""
from __future__ import annotations

import gzip
import json

import pandas as pd

from .common import DATA, PUBLISHED, write_json

ARCHIVE = DATA / "archive"
RELEASES = ARCHIVE / "releases"
INDEX = ARCHIVE / "index.json"
CHANGELOG = ARCHIVE / "CHANGELOG.md"
TOWN_CHANGES = PUBLISHED / "town_changes.web.json"

# Fields kept per town per release for the History panel.
TRACKED = ["ownership_score", "ownership_rank", "rental_score", "rental_rank",
           "home_value", "home_value_source", "home_value_vintage", "median_gross_rent",
           "avg_property_tax_bill", "tax_year", "mortgage_rate_pct", "county_median_hh_income",
           "ownership_burden", "rent_burden", "ownership_confidence", "rental_confidence",
           "present_need", "prospective_need_capped"]


def _load(release: str) -> pd.DataFrame:
    with gzip.open(RELEASES / release / "openhousing_nj.csv.gz", "rt") as f:
        return pd.read_csv(f, dtype={"geoid": str})


def _vintages(manifest: dict) -> dict:
    return {s["name"]: s.get("vintage") for s in manifest.get("sources", [])}


def _compare(new: pd.DataFrame, old: pd.DataFrame) -> dict:
    m = new.merge(old, on="geoid", suffixes=("", "_old"))
    out = {}
    for s in ("ownership", "rental"):
        d = (m[f"{s}_rank"] - m[f"{s}_rank_old"]).abs()
        out[f"{s}_rank_changed"] = int((d > 0).sum())
        out[f"{s}_rank_moved_10plus"] = int((d >= 10).sum())
        out[f"{s}_newly_scored"] = int((m[f"{s}_score"].notna() & m[f"{s}_score_old"].isna()).sum())
        out[f"{s}_no_longer_scored"] = int((m[f"{s}_score"].isna() & m[f"{s}_score_old"].notna()).sum())
    out["new_columns"] = sorted(set(new.columns) - set(old.columns))
    out["removed_columns"] = sorted(set(old.columns) - set(new.columns))
    return out


def release_id(published_at: str) -> str:
    """Release date in New Jersey time, so a release published late in the evening keeps its local date."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.fromisoformat(published_at).astimezone(ZoneInfo("America/New_York")).date().isoformat()


def archive_release(df: pd.DataFrame, manifest: dict) -> str:
    release = release_id(manifest["published_at"])
    folder = RELEASES / release
    folder.mkdir(parents=True, exist_ok=True)
    with gzip.open(folder / "openhousing_nj.csv.gz", "wt", compresslevel=9) as f:
        df.to_csv(f, index=False)
    write_json(folder / "manifest.json", manifest)

    releases = sorted((p.name for p in RELEASES.iterdir() if (p / "manifest.json").exists()), reverse=True)
    entries = []
    for i, r in enumerate(releases):
        man = json.loads((RELEASES / r / "manifest.json").read_text())
        e = {"release": r, "published_at": man["published_at"], "rows": man["rows"],
             "csv": f"data/archive/releases/{r}/openhousing_nj.csv.gz",
             "manifest": f"data/archive/releases/{r}/manifest.json",
             "vintages": _vintages(man), "changes": None}
        if i + 1 < len(releases):
            prev = releases[i + 1]
            pman = json.loads((RELEASES / prev / "manifest.json").read_text())
            pv = _vintages(pman)
            e["changes"] = {"previous": prev,
                            "sources_updated": {k: {"from": pv.get(k), "to": v} for k, v in e["vintages"].items()
                                                if pv.get(k) != v},
                            **_compare(_load(r), _load(prev))}
        entries.append(e)
    write_json(INDEX, {"dataset": manifest["dataset"], "releases": entries})
    CHANGELOG.write_text(changelog(entries))
    build_town_changes(releases)
    return release


def changelog(entries: list[dict]) -> str:
    out = ["# OpenHousing NJ data releases", "",
           "Generated automatically when a dataset passes validation and is published. "
           "Each release is kept in `data/archive/releases/<date>/`.", ""]
    for e in entries:
        out.append(f"## {e['release']}")
        out.append("")
        c = e["changes"]
        if c is None:
            out.append("First archived release.")
        else:
            if c["sources_updated"]:
                out.append("Sources updated:")
                out += [f"- {k}: {v['from'] or 'none'} -> {v['to'] or 'none'}" for k, v in c["sources_updated"].items()]
            else:
                out.append("No source changed its data period.")
            out.append(f"- Ownership ranks changed for {c['ownership_rank_changed']} towns "
                       f"({c['ownership_rank_moved_10plus']} moved 10+ places); rental ranks for "
                       f"{c['rental_rank_changed']} ({c['rental_rank_moved_10plus']} moved 10+).")
            for s in ("ownership", "rental"):
                if c[f"{s}_newly_scored"] or c[f"{s}_no_longer_scored"]:
                    out.append(f"- {s.title()} score: {c[f'{s}_newly_scored']} newly scored, "
                               f"{c[f'{s}_no_longer_scored']} no longer scored.")
            if c["new_columns"]:
                out.append(f"- New columns: {', '.join(c['new_columns'])}.")
            if c["removed_columns"]:
                out.append(f"- Removed columns: {', '.join(c['removed_columns'])}.")
        out.append("")
    return "\n".join(out)


def build_town_changes(releases: list[str]) -> None:
    """Tracked fields for every town in every release, oldest first (compact, for the website)."""
    rel = sorted(releases)
    frames = {r: _load(r).set_index("geoid") for r in rel}
    towns = {}
    for g in frames[rel[-1]].index:
        series = []
        for r in rel:
            f = frames[r]
            if g not in f.index:
                series.append(None)
                continue
            row = f.loc[g]
            series.append([None if (c not in f.columns or pd.isna(row[c])) else
                           (row[c].item() if hasattr(row[c], "item") else row[c]) for c in TRACKED])
        towns[g] = series
    TOWN_CHANGES.write_text(json.dumps({"releases": rel, "fields": TRACKED, "towns": towns},
                                       separators=(",", ":")) + "\n")
