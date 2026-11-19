"""Phase 5: automation safety: key redaction, failure-issue body, workflow settings, cache pruning."""
import importlib.util
from pathlib import Path

import pytest
import yaml

from pipeline import common
from pipeline.common import ROOT, redact

WORKFLOW = ROOT / ".github" / "workflows" / "refresh.yml"


def _issue_module():
    spec = importlib.util.spec_from_file_location("ci_issue_body", ROOT / "scripts" / "ci_issue_body.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("text", [
    "https://api.stlouisfed.org/fred/series/observations?series_id=X&api_key=abc123def456&file_type=json",
    "Max retries exceeded with url: /data/2024/acs/acs5?get=NAME&key=7bd8abcdef0123",
    "headers={'Authorization': 'Bearer eyJ0eXAiOiJKV1Qi.abc.def'}",
])
def test_redact_hides_keys(text):
    out = redact(text)
    assert "REDACTED" in out
    for secret in ("abc123def456", "7bd8abcdef0123", "eyJ0eXAiOiJKV1Qi"):
        assert secret not in out


def test_issue_body_scrubs_keys_and_names_step(tmp_path):
    log = tmp_path / "refresh.log"
    log.write_text("INFO fine\nERROR fred failed: url?api_key=SUPERSECRET123456\nINFO done\n")
    body = _issue_module().body("Run pipeline", log, "https://example/run/1")
    assert "**Failed step:** Run pipeline" in body
    assert "SUPERSECRET123456" not in body
    assert "Nothing was published" in body


def test_workflow_settings():
    w = yaml.safe_load(WORKFLOW.read_text())
    on = w.get(True, w.get("on"))                    # PyYAML parses `on:` as True
    assert "workflow_dispatch" in on and on["schedule"][0]["cron"]
    job = w["jobs"]["refresh"]
    assert job["defaults"]["run"]["shell"] == "bash"   # gives pipefail, so `| tee` can't hide failures
    assert w["permissions"] == {"contents": "write", "issues": "write"}
    text = WORKFLOW.read_text()
    for s in ("CENSUS_API_KEY", "HUD_API_TOKEN", "FRED_API_KEY"):
        assert f"secrets.{s}" in text
    steps = {s.get("id"): s for s in job["steps"]}
    assert "if" not in steps["commit"]                  # runs only when every earlier step succeeded
    failure = [s for s in job["steps"] if s.get("if") == "failure()"]
    assert failure and "gh issue create" in failure[0]["run"]


def test_no_secret_values_in_repo_files():
    """Real key values must never be committed. Checks tracked text files against the local .env."""
    env = ROOT / ".env"
    if not env.exists():
        pytest.skip("no local .env")
    values = [ln.split("=", 1)[1].strip() for ln in env.read_text().splitlines()
              if "=" in ln and not ln.startswith("#")]
    values = [v for v in values if len(v) >= 16]
    import subprocess
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    for f in tracked:
        p = ROOT / f
        if p.suffix in {".png", ".pdf", ".xlsx", ".xls"} or not p.is_file():
            continue
        text = p.read_text(errors="ignore")
        for v in values:
            assert v not in text, f"secret value found in {f}"


def test_prune_raw_keeps_newest(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "RAW", tmp_path)
    for d in ("2026-09-20", "2026-10-20", "2026-11-20"):
        (tmp_path / "zillow" / d).mkdir(parents=True)
    removed = common.prune_raw(keep=2)
    assert [Path(r).name for r in removed] == ["2026-09-20"]
    assert sorted(p.name for p in (tmp_path / "zillow").iterdir()) == ["2026-10-20", "2026-11-20"]
