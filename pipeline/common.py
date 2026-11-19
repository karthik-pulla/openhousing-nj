"""Shared helpers: paths, secrets, logging, and cached HTTP downloads.

Every network fetch goes through `download()`, which
  * saves the raw response under data/raw/<source>/<YYYY-MM-DD>/<filename>
  * reuses a file already downloaded today instead of re-fetching it, so
    reruns don't hammer the source
  * never writes API keys into file names or logs.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"          # gitignored; re-fetchable
STATIC = DATA / "static"    # committed; files with no API (NZLUD, Fourth Round, 2020 Census parts)
GEO = DATA / "geo"
CROSSWALKS = DATA / "crosswalks"
PUBLISHED = DATA / "published"                     # what the v2 site reads
PUBLISHED_CSV = PUBLISHED / "openhousing_nj.csv"   # one row per municipality

STATE_FIPS = "34"  # New Jersey
EXPECTED_MUNICIPALITIES = 564

log = logging.getLogger("openhousing")


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")


def load_env() -> None:
    """Load .env for local runs. In GitHub Actions the variables come from Secrets."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover
        return
    load_dotenv(ROOT / ".env", override=False)


def require_env(name: str) -> str:
    load_env()
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"Missing {name}. Put it in .env for local runs (see .env.example) "
            f"or in GitHub repo Secrets for the Action."
        )
    return value


def today() -> str:
    return dt.date.today().isoformat()


def latest_acs5_year(first_candidate: int | None = None, floor: int = 2024) -> int:
    """Newest ACS 5-year release the Census API serves (e.g. 2024 = ACS 2020-2024).

    Probes the dataset discovery URL from the current year downward, so the
    monthly refresh picks up a new release (usually published in December)
    without a code change.
    """
    start = first_candidate or dt.date.today().year
    for year in range(start, floor - 1, -1):
        try:
            r = requests.get(f"https://api.census.gov/data/{year}/acs/acs5", timeout=30)
            if r.status_code == 200:
                return year
        except requests.RequestException as e:
            log.warning("could not probe ACS %s: %s", year, e)
    return floor


def redact(url: str) -> str:
    return re.sub(r"((?:api_)?key|token|access_token)=[^&]+", r"\1=REDACTED", url)


def raw_dir(source: str, date: str | None = None) -> Path:
    d = RAW / source / (date or today())
    d.mkdir(parents=True, exist_ok=True)
    return d


def _previous_copy(source: str, filename: str) -> Path | None:
    """Newest earlier-dated copy of this file in data/raw/<source>/."""
    base = RAW / source
    if not base.exists():
        return None
    for d in sorted((p for p in base.iterdir() if p.is_dir() and p.name < today()), reverse=True):
        f = d / filename
        if f.exists() and f.stat().st_size > 0:
            return f
    return None


def download(source: str, filename: str, url: str, *, params: dict | None = None,
             headers: dict | None = None, retries: int = 3, timeout: int = 120,
             force: bool = False, reuse_if_unchanged: bool = False) -> Path:
    """Download `url` to data/raw/<source>/<today>/<filename>, reusing today's copy if present.

    reuse_if_unchanged: for large files, send a HEAD request first; if the
    server's ETag/Last-Modified match the newest earlier copy, copy that file
    instead of downloading it again.
    """
    out = raw_dir(source) / filename
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_size > 0 and not force:
        log.info("cache hit %s/%s", source, out.relative_to(RAW / source))
        return out
    if reuse_if_unchanged and not force:
        prev = _previous_copy(source, filename)
        sidecar = prev.with_name(prev.name + ".headers.json") if prev else None
        if prev and sidecar.exists():
            try:
                h = requests.head(url, params=params, headers=headers, timeout=30, allow_redirects=True)
                old = json.loads(sidecar.read_text())
                now = {k: h.headers.get(k) for k in ("ETag", "Last-Modified")}
                if h.ok and any(now.values()) and now == old:
                    import shutil
                    shutil.copy2(prev, out)
                    shutil.copy2(sidecar, out.with_name(out.name + ".headers.json"))
                    log.info("unchanged since %s; reused %s", prev.parent.name, filename)
                    return out
            except requests.RequestException as e:
                log.warning("HEAD check failed for %s: %s", redact(url), e)
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with requests.get(url, params=params, headers=headers, timeout=timeout, stream=True) as r:
                if r.status_code >= 400:
                    # Body often explains the error (Census returns plain text); keep it short.
                    raise requests.HTTPError(
                        f"HTTP {r.status_code} for {redact(r.url)}: {r.text[:300]!r}")
                tmp = out.with_suffix(out.suffix + ".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                tmp.replace(out)
                out.with_name(out.name + ".headers.json").write_text(json.dumps(
                    {k: r.headers.get(k) for k in ("ETag", "Last-Modified")}))
                log.info("downloaded %s (%s bytes) from %s", out.name, out.stat().st_size, redact(r.url))
                return out
        except (requests.RequestException, OSError) as e:
            last_err = e
            log.warning("attempt %d/%d failed for %s: %s", attempt, retries, redact(url), e)
            time.sleep(2 * attempt)
    raise RuntimeError(f"Download failed after {retries} attempts: {redact(url)}") from last_err


def census_get(dataset: str, variables: list[str], for_: str, in_: str | None,
               filename: str) -> list[dict]:
    """Query the Census Data API and return rows as dicts (header row -> keys)."""
    params = {"get": ",".join(variables), "for": for_, "key": require_env("CENSUS_API_KEY")}
    if in_:
        params["in"] = in_
    path = download("census", filename, f"https://api.census.gov/data/{dataset}", params=params)
    rows = json.loads(path.read_text())
    header, body = rows[0], rows[1:]
    return [dict(zip(header, r)) for r in body]


def load_config() -> dict:
    import yaml
    return yaml.safe_load((ROOT / "config.yaml").read_text())


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # numpy/pandas scalars -> plain Python; anything else -> str
    path.write_text(json.dumps(obj, indent=2, sort_keys=False,
                               default=lambda o: o.item() if hasattr(o, "item") else str(o)) + "\n")
