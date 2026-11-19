"""Write the GitHub Issue body for a failed monthly refresh (used by .github/workflows/refresh.yml).

    python scripts/ci_issue_body.py --failed-step "Run pipeline" --log refresh.log --run-url URL > issue.md

Pulls the facts from files the pipeline already writes, so the issue says
which step failed and why without anyone opening the Actions log:
  data/interim/run_summary.json   which fetchers failed, with their errors
  data/build/validation.json      which validation checks failed
  the tail of the pipeline log    for anything else (install errors, crashes)
API keys never appear: the pipeline redacts them from URLs, and GitHub
masks secret values in logs.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRETISH = re.compile(r"((?:api_)?key|token|Bearer)([=: ]+)(?!REDACTED)[A-Za-z0-9._-]{8,}", re.I)
NOTEWORTHY = re.compile(r"ERROR|WARNING|Traceback|FAIL|Error:|error:", re.I)


def _load(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def body(failed_step: str, log_path: Path | None, run_url: str) -> str:
    out = ["## Monthly data refresh failed", "",
           f"**Failed step:** {failed_step or 'unknown'}",
           f"**Run:** {run_url}" if run_url else "",
           "",
           "Nothing was published. The site keeps showing the last dataset that passed validation.",
           ""]

    run = _load(ROOT / "data" / "interim" / "run_summary.json")
    if run:
        bad = {k: v for k, v in run.get("steps", {}).items() if not v.get("ok") and not v.get("skipped")}
        if bad:
            out += ["### Pipeline steps that failed", ""]
            out += [f"- **{k}**: `{v.get('error', 'no error message')}`" for k, v in bad.items()]
            out.append("")

    val = _load(ROOT / "data" / "build" / "validation.json")
    if val and not val.get("passed", True):
        out += ["### Validation checks that failed", ""]
        for r in val["results"]:
            if not r["passed"]:
                out.append(f"- **{r['check']}** ({r['level']}): {r['detail']}")
                out += [f"  - {i}" for i in r.get("items", [])[:10]]
        out.append("")

    if log_path and log_path.exists():
        lines = log_path.read_text(errors="replace").splitlines()
        notable = [ln for ln in lines if NOTEWORTHY.search(ln)][-30:]
        text = "\n".join(notable + ["..."] + lines[-8:])
        out += ["<details><summary>Warnings, errors and the last log lines</summary>", "", "```", text, "```",
                "", "</details>", ""]

    out += ["### What to do", "",
            "1. Read the failed step above. A source that's down or late usually fixes itself next month; "
            "re-run with **Actions → Monthly data refresh → Run workflow**.",
            "2. A `schema` failure means the dataset's columns changed. If the change is intended, run "
            "`python -m pipeline.validate --accept-schema` locally and commit `data/schema/`.",
            "3. A new `UNMATCHED` Zillow region: see `data/crosswalks/README.md`.",
            "4. A 401/403 from Census, HUD or FRED: the API key secret may have expired; see "
            "`docs/AUTOMATION.md`.",
            "",
            "_Opened automatically by `.github/workflows/refresh.yml`._"]
    # Defense in depth: the issue is public, so scrub anything key-shaped.
    return SECRETISH.sub(r"\1\2REDACTED", "\n".join(x for x in out if x is not None))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--failed-step", default="")
    ap.add_argument("--log", type=Path)
    ap.add_argument("--run-url", default="")
    a = ap.parse_args()
    print(body(a.failed_step, a.log, a.run_url))


if __name__ == "__main__":
    main()
