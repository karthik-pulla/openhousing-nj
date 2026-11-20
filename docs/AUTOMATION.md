# Automation: the monthly data refresh

`.github/workflows/refresh.yml` rebuilds the data every month and publishes it only if it passes validation. You don't have to do anything unless it opens an issue.

## What it does

1. Runs on the **20th of every month at 14:00 UTC**, after Zillow's monthly release on the 16th, so a fresh weekly mortgage rate is available. You can also run it by hand: **Actions → Monthly data refresh → Run workflow**.
2. Checks that the three API key secrets exist.
3. Installs the pinned Python packages from `requirements.txt`.
4. Restores the download cache (`data/raw/`), so reruns don't hit the sources again and the 95 MB Zillow file is reused when it hasn't changed.
5. Runs `python scripts/refresh_data.py`: geography → every source → index → **validation** → publish. Publishing also adds the release to `data/archive/` (dated copy, `index.json`, `CHANGELOG.md`) and rebuilds the per-town change history, so the archive is committed with the data.
6. Runs the test suite (`pytest`).
7. **Commits the updated `data/` only if steps 2–6 all passed.** The commit message lists every source's data period.
8. **On any failure:** nothing is committed, so the site keeps the last good dataset. The workflow opens a GitHub Issue labelled `data-refresh-failure` saying which step failed and why. If such an issue is already open, it adds a comment instead of opening a duplicate. GitHub emails you about new issues on your own repository by default.
9. Uploads the log and reports (`refresh.log`, `run_summary.json`, `validation.json`) as a run artifact, kept 30 days.

## One-time setup: create three secrets

On GitHub go to **your repository → Settings → Secrets and variables → Actions → New repository secret**. Create these three, using the exact names:

| Secret name | What it is | Where to get it |
|---|---|---|
| `CENSUS_API_KEY` | U.S. Census Bureau Data API key | Sign up at https://api.census.gov/data/key_signup.html. The key arrives by email; click the activation link in it. |
| `HUD_API_TOKEN` | HUD USER API access token | Register or log in at https://www.huduser.gov/hudapi/public/register, then choose **Create New Token**. Copy the whole long token. |
| `FRED_API_KEY` | FRED (St. Louis Fed) API key | Create a free FRED account, then request a key at https://fredaccount.stlouisfed.org/apikeys |

Paste only the value: no quotes and no `NAME=` prefix. After saving, GitHub won't show the value again, and it masks it in logs.

The same three values go in `.env` for local runs; copy `.env.example`. `.env` is gitignored and must never be committed. A test (`tests/test_ci.py`) fails if a key value from your `.env` shows up in any tracked file.

> **Tip:** your current keys were pasted into a chat session. If you want to be careful, generate new ones on the three pages above before creating the secrets, and update `.env` to match.

### Also check once

- **Settings → Actions → General → Workflow permissions.** The workflow asks for permission to write repository contents (for the data commit) and issues (for failure alerts). If the commit or issue step fails with a 403, choose **Read and write permissions** there.
- **The monthly schedule only runs from the default branch (`main`).** It starts once this workflow is merged into `main`. Until then you can still start it by hand from the `v2-index` branch: **Run workflow → choose the branch**.

## When an issue is opened

The issue names the failed step, the source or check that failed, and the relevant log lines (with keys redacted). Common cases:

| Failure | What it means | What to do |
|---|---|---|
| `Check that API key secrets exist` | A secret is missing or misnamed | Create it (see above) |
| A source's `HTTP 400/401/403` | Key expired or revoked | Generate a new key and update the secret |
| A source's timeout or `HTTP 5xx` | The source was down | Usually nothing; re-run later or wait for next month |
| `schema` validation | The dataset's columns changed | If intended: `python -m pipeline.validate --accept-schema` locally, then commit `data/schema/` |
| `ranges`, `missing` or `coverage` validation | A source sent odd or incomplete data | Look at the source; don't loosen the limits in `config.yaml` without a reason |
| `UNMATCHED` Zillow region in the log | Zillow added a place name | See `data/crosswalks/README.md` (this is a warning, not a failure) |

Close the issue once a run succeeds.

## Running the same thing locally

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv -r requirements.txt
cp .env.example .env    # then fill in the three keys
.venv/bin/python scripts/refresh_data.py
.venv/bin/python -m pytest -q
```

`refresh_data.py` exits with code 1 and publishes nothing if any source or validation check fails. `data/build/validation.json` says why.
