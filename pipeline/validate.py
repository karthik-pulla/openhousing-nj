"""Phase 4: validate the staged dataset, then publish it, or refuse to.

    python -m pipeline.validate                 # validate data/build; publish if it passes
    python -m pipeline.validate --no-publish    # validate only
    python -m pipeline.validate --accept-schema # record the current columns as the expected schema

Every check returns a result with level "error" or "warning". Any failed
error blocks publishing: data/published/ is left untouched (the last good
dataset stays live) and the exit code is 1. Warnings are recorded and
reported but don't block.

Checks
  rows             exactly 564 rows
  geoids           10-digit NJ GEOIDs, unique, the same set as the backbone
  schema           columns (names, order, kinds) match data/schema/openhousing_nj.schema.json
  required         required fields have no nulls
  missing          optional fields missing for no more towns than allowed
  ranges           values inside hard plausibility limits
  consistency      ranks follow scores; urban-aid zeros; capped <= uncapped
  zillow_terms     no Zillow values unless config clears Zillow for publication
  sources          every fetcher in the last run succeeded
  coverage         no score covers many fewer towns than the published dataset (error)
  jumps            towns whose score moved more than N points since last publish (warning)
  summaries        every town has a template summary with no unfilled blanks, printed
                   missing values or banned wording, and every sentence lists its sources
  freshness        mortgage rate and tax data not stale (warning)

Outputs
  data/build/validation.json   always
  data/published/*             only when validation passes
  data/manifest.json           only when validation passes: sources, vintages,
                               fetch times, coverage, validation results
"""
from __future__ import annotations

import argparse
import datetime as dt
from contextlib import contextmanager
import json
import shutil
import sys

import numpy as np
import pandas as pd

from .common import DATA, GEO, PUBLISHED, PUBLISHED_CSV, load_config, log, setup_logging, write_json
from .fetchers.base import INTERIM
from .index import BUILD

BUILD_CSV = BUILD / "openhousing_nj.csv"
SCHEMA = DATA / "schema" / "openhousing_nj.schema.json"
MANIFEST = DATA / "manifest.json"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _kind(s: pd.Series) -> str:
    v = s.dropna()
    if v.empty:
        return "empty"
    if v.map(lambda x: isinstance(x, (bool, np.bool_)) or str(x) in ("True", "False")).all():
        return "bool"
    if pd.to_numeric(v, errors="coerce").notna().all():
        return "number"
    return "text"


def schema_of(df: pd.DataFrame) -> list[dict]:
    return [{"name": c, "kind": _kind(df[c])} for c in df.columns]


def _read(path) -> pd.DataFrame:
    return pd.read_csv(path, dtype={"geoid": str, "mun_code": str, "county_fips": str})


@contextmanager
def guard(rep: "Report", check: str):
    """A check that crashes (e.g. on a missing column) is recorded as a failed error."""
    try:
        yield
    except Exception as e:
        rep.add(check, "error", False, f"check could not run: {type(e).__name__}: {e}")


class Report:
    def __init__(self):
        self.results: list[dict] = []

    def add(self, check: str, level: str, passed: bool, detail: str = "", items=None):
        r = {"check": check, "level": level, "passed": bool(passed), "detail": detail}
        if items:
            r["items"] = list(items)[:50]
            r["n_items"] = len(items)
        self.results.append(r)
        (log.info if passed else (log.error if level == "error" else log.warning))(
            "%-12s %-7s %s %s", check, level, "PASS" if passed else "FAIL", detail)

    @property
    def ok(self) -> bool:
        return all(r["passed"] for r in self.results if r["level"] == "error")

    def summary(self) -> dict:
        errs = [r for r in self.results if r["level"] == "error" and not r["passed"]]
        warns = [r for r in self.results if r["level"] == "warning" and not r["passed"]]
        return {"validated_at": _now(), "passed": self.ok, "errors": len(errs), "warnings": len(warns),
                "results": self.results}


def validate(df: pd.DataFrame, previous: pd.DataFrame | None, cfg: dict) -> Report:
    v = cfg["validation"]
    rep = Report()
    scores = list(cfg["index"]["scores"])

    # rows / geoids
    with guard(rep, "rows"):
        rep.add("rows", "error", len(df) == v["expected_rows"], f"{len(df)} rows (expected {v['expected_rows']})")
        munis = set(pd.read_csv(GEO / "municipalities.csv", dtype=str).geoid)
        bad_format = df.loc[~df.geoid.astype(str).str.fullmatch(r"34\d{8}"), "geoid"].tolist()
        dupes = df.loc[df.geoid.duplicated(), "geoid"].tolist()
        extra, absent = set(df.geoid) - munis, munis - set(df.geoid)
        rep.add("geoids", "error", not (bad_format or dupes or extra or absent),
                f"{len(bad_format)} malformed, {len(dupes)} duplicate, {len(extra)} unknown, {len(absent)} missing",
                bad_format + dupes + sorted(extra) + sorted(absent))

    # schema
    with guard(rep, "schema"):
        if SCHEMA.exists():
            expected = json.loads(SCHEMA.read_text())["columns"]
            got = schema_of(df)
            exp_names, got_names = [c["name"] for c in expected], [c["name"] for c in got]
            added = [c for c in got_names if c not in exp_names]
            removed = [c for c in exp_names if c not in got_names]
            exp_kind = {c["name"]: c["kind"] for c in expected}
            changed = [f"{c['name']}: {exp_kind[c['name']]} -> {c['kind']}" for c in got
                       if c["name"] in exp_kind and c["kind"] != exp_kind[c["name"]]
                       and "empty" not in (c["kind"], exp_kind[c["name"]])]
            order_ok = [c for c in got_names if c in exp_names] == [c for c in exp_names if c in got_names]
            rep.add("schema", "error", not (added or removed or changed) and order_ok,
                    f"added {added}, removed {removed}, kind changed {changed}, order ok {order_ok}")
        else:
            rep.add("schema", "error", False, f"no expected schema at {SCHEMA.relative_to(DATA.parent)}; "
                    "run python -m pipeline.validate --accept-schema after reviewing the columns")

    # required / missing
    with guard(rep, "required"):
        nulls = {c: int(df[c].isna().sum()) for c in v["required_non_null"] if c in df}
        missing_cols = [c for c in v["required_non_null"] if c not in df]
        bad = {c: n for c, n in nulls.items() if n}
        rep.add("required", "error", not bad and not missing_cols,
                f"nulls in required fields: {bad or 'none'}; absent columns: {missing_cols or 'none'}")
        over = {c: int(df[c].isna().sum()) for c, lim in v["max_missing"].items()
                if c in df and df[c].isna().sum() > lim}
        rep.add("missing", "error", not over,
                f"fields missing for more towns than allowed: {over or 'none'} (limits {v['max_missing']})")

    # ranges
    with guard(rep, "ranges"):
        viol = []
        for c, (lo, hi) in v["ranges"].items():
            if c not in df:
                viol.append(f"{c}: column absent")
                continue
            x = pd.to_numeric(df[c], errors="coerce")
            out = df.loc[(x < lo) | (x > hi), ["name", c]]
            viol += [f"{r['name']}: {c}={r[c]} outside [{lo}, {hi}]" for _, r in out.iterrows()]
        rep.add("ranges", "error", not viol, f"{len(viol)} value(s) outside hard limits", viol)

    # consistency
    with guard(rep, "consistency"):
        probs = []
        for s in scores:
            sc, rk = df[f"{s}_score"], df[f"{s}_rank"]
            if (sc.isna() != rk.isna()).any():
                probs.append(f"{s}: score and rank missing for different towns")
            ordered = df.dropna(subset=[f"{s}_score"]).sort_values(f"{s}_rank")[f"{s}_score"]
            if not ordered.is_monotonic_decreasing:
                probs.append(f"{s}: ranks don't follow scores")
            if ((df[f"{s}_confidence"] == "insufficient data") != sc.isna()).any():
                probs.append(f"{s}: confidence 'insufficient data' doesn't match missing scores")
        qua = df.qualified_urban_aid.astype(str) == "True"
        if (df.loc[qua, "prospective_need_capped"] != 0).any():
            probs.append("a Qualified Urban Aid town has prospective need > 0")
        if (df.prospective_need_capped > df.prospective_need).any():
            probs.append("capped prospective need exceeds uncapped")
        rep.add("consistency", "error", not probs, "; ".join(probs) or "ok", probs)

    # zillow terms
    with guard(rep, "zillow_terms"):
        cleared = cfg["sources"]["zillow"]["cleared_for_publication"]
        leaked = (not cleared) and (df.zhvi.notna().any() or (df.home_value_source == "Zillow ZHVI").any())
        rep.add("zillow_terms", "error", not leaked,
                "Zillow values present although not cleared for publication" if leaked else
                f"ok (cleared_for_publication={cleared})")

    # last run's fetchers
    with guard(rep, "sources"):
        run = json.loads((INTERIM / "run_summary.json").read_text()) if (INTERIM / "run_summary.json").exists() else {}
        failed = [k for k, s in run.get("steps", {}).items() if not s.get("ok") and k != "index"]
        rep.add("sources", "error", not failed and bool(run), f"failed steps in last run: {failed or 'none'}"
                if run else "no run_summary.json; run scripts/refresh_data.py")

    # vs previously published
    with guard(rep, "coverage"):
        if previous is not None:
            drops = {s: int(previous[f"{s}_score"].notna().sum() - df[f"{s}_score"].notna().sum())
                     for s in scores if f"{s}_score" in previous}
            big = {s: d for s, d in drops.items() if d > v["max_scored_drop"]}
            rep.add("coverage", "error", not big, f"towns scored, change vs published: "
                    f"{ {s: -d for s, d in drops.items()} } (error if a drop exceeds {v['max_scored_drop']})")
            m = df[["geoid", "name"] + [f"{s}_score" for s in scores]].merge(
                previous[["geoid"] + [f"{s}_score" for s in scores if f"{s}_score" in previous]],
                on="geoid", suffixes=("", "_prev"))
            jumps = []
            for s in scores:
                if f"{s}_score_prev" not in m:
                    continue
                d = (m[f"{s}_score"] - m[f"{s}_score_prev"]).abs()
                for _, r in m[d > v["max_score_jump_points"]].iterrows():
                    jumps.append(f"{r['name']}: {s} {r[f'{s}_score_prev']:.1f} -> {r[f'{s}_score']:.1f}")
            rep.add("jumps", "warning", not jumps,
                    f"{len(jumps)} town score(s) moved more than {v['max_score_jump_points']} points", jumps)
        else:
            rep.add("coverage", "error", True, "no published dataset yet; nothing to compare")
            rep.add("jumps", "warning", True, "no published dataset yet; nothing to compare")

    # summaries
    with guard(rep, "summaries"):
        from .summaries import OUT as SUMMARIES, check_text
        if not SUMMARIES.exists():
            rep.add("summaries", "error", False, "data/build/summaries.json missing")
        else:
            towns = json.loads(SUMMARIES.read_text())["towns"]
            missing = sorted(set(df.geoid) - set(towns))
            bad = [f"{t['name']}: {p}" for t in towns.values() for p in check_text(t["summary"])]
            untraced = [t["name"] for t in towns.values() if any(not s["sources"] for s in t["sentences"])]
            rep.add("summaries", "error", not (missing or bad or untraced),
                    f"{len(towns)} summaries; {len(missing)} towns without one; {len(bad)} with problems; "
                    f"{len(untraced)} with a sentence lacking sources", missing + bad + untraced)

    # freshness
    with guard(rep, "freshness"):
        stale = []
        fred = json.loads((INTERIM / "fred_mortgage30.meta.json").read_text())
        age = (dt.date.today() - dt.date.fromisoformat(fred["latest_week"])).days
        if age > v["fred_max_age_days"]:
            stale.append(f"latest mortgage rate is {age} days old")
        tax_year = int(pd.to_numeric(df.tax_year, errors="coerce").max())
        if dt.date.today().year - tax_year > v["property_tax_max_age_years"]:
            stale.append(f"property tax data is for {tax_year}")
        rep.add("freshness", "warning", not stale, "; ".join(stale) or "ok")
    return rep


def build_manifest(df: pd.DataFrame, report: dict, published_at: str) -> dict:
    meta = json.loads((BUILD / "index_meta.json").read_text())
    cfg = load_config()
    include_zillow = meta["zillow_included"]
    sources = []
    for p in sorted(INTERIM.glob("*.meta.json")):
        m = json.loads(p.read_text())
        if "zillow" in m["name"] and not include_zillow:
            continue
        sources.append({k: m.get(k) for k in ("name", "source", "vintage", "url", "attribution",
                                              "fetched", "fetched_at", "coverage")})
    return {
        "dataset": "OpenHousing NJ v2",
        "published_at": published_at,
        "rows": len(df),
        "files": {"csv": str(PUBLISHED_CSV.relative_to(DATA.parent)),
                  "index_meta": "data/published/index_meta.json",
                  "summaries": "data/published/summaries.json"},
        "scores": meta["scores"],
        "context_measures": meta["context_measures"],
        "assumptions": meta["assumptions"],
        "home_value_source_counts": meta["home_value_source_counts"],
        "zillow_included": include_zillow,
        "redfin_included": bool(cfg["sources"]["redfin"]["enabled"]),
        "sources": sources,
        "validation": {k: report[k] for k in ("validated_at", "passed", "errors", "warnings")} |
                      {"results": [{k: r[k] for k in ("check", "level", "passed", "detail")}
                                   for r in report["results"]]},
    }


def publish(df: pd.DataFrame, report: dict) -> None:
    PUBLISHED.mkdir(parents=True, exist_ok=True)
    published_at = _now()
    tmp = PUBLISHED_CSV.with_suffix(".csv.tmp")
    shutil.copy2(BUILD_CSV, tmp)
    tmp.replace(PUBLISHED_CSV)                       # atomic swap of the live file
    shutil.copy2(BUILD / "index_meta.json", PUBLISHED / "index_meta.json")
    shutil.copy2(BUILD / "summaries.json", PUBLISHED / "summaries.json")
    write_json(PUBLISHED / "validation.json", report)
    write_json(MANIFEST, build_manifest(df, report, published_at))
    log.info("published %s (%d rows) and %s", PUBLISHED_CSV.name, len(df), MANIFEST.name)


def run(publish_if_ok: bool = True) -> bool:
    cfg = load_config()
    if not BUILD_CSV.exists():
        raise SystemExit("nothing to validate: data/build/openhousing_nj.csv is missing")
    df = _read(BUILD_CSV)
    previous = _read(PUBLISHED_CSV) if PUBLISHED_CSV.exists() else None
    rep = validate(df, previous, cfg)
    report = rep.summary()
    write_json(BUILD / "validation.json", report)
    if not rep.ok:
        log.error("validation FAILED (%d error(s), %d warning(s)); NOT publishing, last good dataset kept",
                  report["errors"], report["warnings"])
        return False
    log.info("validation passed (%d warning(s))", report["warnings"])
    if publish_if_ok:
        publish(df, report)
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Validate and publish the OpenHousing dataset")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--accept-schema", action="store_true",
                    help="record the build's current columns as the expected schema, then exit")
    args = ap.parse_args(argv)
    setup_logging()
    if args.accept_schema:
        df = _read(BUILD_CSV)
        write_json(SCHEMA, {"recorded": dt.date.today().isoformat(), "columns": schema_of(df)})
        log.info("recorded schema with %d columns at %s", len(df.columns), SCHEMA)
        return 0
    return 0 if run(publish_if_ok=not args.no_publish) else 1


if __name__ == "__main__":
    sys.exit(main())
