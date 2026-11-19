"""Rebuild OpenHousing data from the original sources.

    python scripts/refresh_data.py                 # everything
    python scripts/refresh_data.py --only acs hud  # just some sources

Steps
  1. Geography backbone: 564 municipalities keyed on GEOID (pipeline/geography.py)
  2. One fetcher per source (pipeline/fetchers/), each writing a tidy table
     keyed on GEOID or county FIPS to data/interim/<name>.csv, plus
     <name>.meta.json with its vintage, source, attribution and coverage.
  3. Index v2 (pipeline/index.py) -> data/build/openhousing_nj.csv, only if
     every fetcher succeeded.
  4. data/interim/run_summary.json: what ran, what failed, coverage.

Raw downloads are cached in data/raw/<source>/<date>/ (gitignored), so
rerunning on the same day doesn't hit the sources again.

API keys come from the environment (GitHub Secrets in the Action) or from
.env for local runs: CENSUS_API_KEY, HUD_API_TOKEN, FRED_API_KEY.
"""
from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import geography, index  # noqa: E402
from pipeline.common import log, setup_logging, today, write_json  # noqa: E402
from pipeline.fetchers import FETCHERS  # noqa: E402
from pipeline.fetchers.base import INTERIM  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Rebuild OpenHousing data")
    ap.add_argument("--only", nargs="+", choices=sorted(FETCHERS), help="run only these fetchers")
    ap.add_argument("--skip-geography", action="store_true", help="reuse data/geo/municipalities.csv")
    args = ap.parse_args(argv)
    setup_logging()

    summary = {"run_date": today(), "steps": {}}
    failed = []

    if not args.skip_geography:
        t0 = time.time()
        try:
            geography.main([])
            summary["steps"]["geography"] = {"ok": True, "seconds": round(time.time() - t0, 1)}
        except Exception as e:  # without the backbone nothing else is meaningful
            log.error("geography failed: %s", e)
            summary["steps"]["geography"] = {"ok": False, "error": str(e)}
            write_json(INTERIM / "run_summary.json", summary)
            return 1

    for name in args.only or FETCHERS:
        t0 = time.time()
        log.info("=== %s", name)
        try:
            metas = [r.save() for r in FETCHERS[name]()]
            summary["steps"][name] = {
                "ok": True, "seconds": round(time.time() - t0, 1),
                "outputs": {m["name"]: {"vintage": m["vintage"], **m["coverage"]} for m in metas}}
        except Exception as e:
            # Keep going so one broken source doesn't hide problems in the others;
            # the run still exits non-zero and Phase 4 validation won't publish.
            log.error("%s failed: %s", name, e)
            summary["steps"][name] = {"ok": False, "error": f"{type(e).__name__}: {e}",
                                      "traceback": traceback.format_exc(limit=5)}
            failed.append(name)

    # Index (Phase 3): only from a complete set of fresh inputs.
    if failed or args.only:
        reason = "a fetcher failed" if failed else "--only run"
        log.warning("index not rebuilt (%s)", reason)
        summary["steps"]["index"] = {"ok": False, "skipped": reason}
    else:
        t0 = time.time()
        try:
            df, meta = index.build()
            index.BUILD.mkdir(parents=True, exist_ok=True)
            df.to_csv(index.BUILD / "openhousing_nj.csv", index=False)
            write_json(index.BUILD / "index_meta.json", meta)
            summary["steps"]["index"] = {"ok": True, "seconds": round(time.time() - t0, 1),
                                         "scored": meta["scored"], "unscored": meta["unscored"],
                                         "confidence": meta["confidence_counts"]}
            log.info("index: %d of %d scored; confidence %s", meta["scored"], meta["rows"],
                     meta["confidence_counts"])
        except Exception as e:
            log.error("index failed: %s", e)
            summary["steps"]["index"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            failed.append("index")

    write_json(INTERIM / "run_summary.json", summary)
    log.info("done. %d step(s) failed: %s", len(failed), failed or "none")
    for step, info in summary["steps"].items():
        for out, cov in info.get("outputs", {}).items():
            log.info("  %-24s %-60s %s", out, cov.get("vintage", ""),
                     f"{cov.get('municipalities_covered', cov.get('rows'))} covered")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
