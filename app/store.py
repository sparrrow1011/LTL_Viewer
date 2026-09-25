"""
JSON file storage layer — replaces the Neon/Postgres database.

Runs are split into WEEKLY JSON files bucketed by orig_planned_yard_checkin_time
(week = Sunday–Saturday, matching the app's manual-source week convention):

    <LTL_MS_DIR>/runs/runs_<ISO-year>-W<week>.json

Each weekly file is a JSON array of row dicts. ms_runs.json and sync_status.json
remain single files.

Reads tolerate a missing/empty/corrupt file (return []). Writes are atomic
(write to a temp file, then os.replace). A process-wide lock serialises writers
within this process; cross-process safety relies on the atomic replace.

Row identity is (orderid, vrid or '') — matching the unique key the original
Postgres schema used (orderid, COALESCE(vrid, '')).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from app.config import Config

_LOCK = threading.RLock()

# Rows whose checkin date can't be parsed land in this bucket so they're never
# silently dropped.
_UNDATED_WEEK = "undated"


def _base_dir() -> Path:
    d = Config.LTL_MS_DIR
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[store] could not ensure base dir {d}: {e}")
    return d


def _runs_dir() -> Path:
    d = _base_dir() / Config.RUNS_DIR
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[store] could not ensure runs dir {d}: {e}")
    return d


def _path(filename: str) -> Path:
    return _base_dir() / filename


# ── low-level JSON IO ─────────────────────────────────────────────────────────
def _load_file(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        print(f"[store] {path.name} is not a JSON array — ignoring")
        return []
    except (json.JSONDecodeError, OSError) as e:
        print(f"[store] failed to read {path.name}: {e}")
        return []


def _save_file(path: Path, rows: list[dict]) -> None:
    with _LOCK:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, default=str)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


# ── weekly bucketing ──────────────────────────────────────────────────────────
def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
                "%d/%m/%Y %H:%M", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def week_key_for_date(dt: datetime) -> str:
    """
    Return the Sunday–Saturday week label for a datetime as '<year>-W<week>'.
    We anchor the week on its Sunday and derive an ISO-style year/week from the
    following Monday so labels stay stable and sortable.
    """
    # Sunday that starts this row's week.
    sunday = dt.date() - timedelta(days=(dt.weekday() + 1) % 7)
    monday = sunday + timedelta(days=1)
    iso_year, iso_week, _ = monday.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def week_key_for_row(row: dict) -> str:
    dt = _parse_dt(row.get("orig_planned_yard_checkin_time"))
    return week_key_for_date(dt) if dt else _UNDATED_WEEK


def _week_path(week: str) -> Path:
    return _runs_dir() / f"{Config.RUNS_FILE_PREFIX}{week}.json"


def list_week_keys() -> list[str]:
    d = _runs_dir()
    keys = []
    pat = re.compile(re.escape(Config.RUNS_FILE_PREFIX) + r"(.+)\.json$")
    try:
        for p in d.glob(f"{Config.RUNS_FILE_PREFIX}*.json"):
            m = pat.match(p.name)
            if m:
                keys.append(m.group(1))
    except OSError as e:
        print(f"[store] could not list week files: {e}")
    return sorted(keys)


def load_week(week: str) -> list[dict]:
    return _load_file(_week_path(week))


def save_week(week: str, rows: list[dict]) -> None:
    _save_file(_week_path(week), rows)


# ── Runs (weekly-bucketed) ────────────────────────────────────────────────────
def load_runs(weeks: Optional[list[str]] = None) -> list[dict]:
    """Load all runs, or only the given week labels, concatenated."""
    keys = weeks if weeks is not None else list_week_keys()
    out: list[dict] = []
    for wk in keys:
        out.extend(load_week(wk))
    return out


def save_runs(rows: list[dict]) -> None:
    """Re-bucket every row by week and rewrite each weekly file (removing any
    week file that no longer has rows)."""
    buckets: dict[str, list[dict]] = {}
    for r in rows:
        buckets.setdefault(week_key_for_row(r), []).append(r)

    with _LOCK:
        existing = set(list_week_keys())
        for wk, wk_rows in buckets.items():
            save_week(wk, wk_rows)
        # Empty out weeks that no longer have any rows.
        for wk in existing - set(buckets.keys()):
            save_week(wk, [])


# ── Manual-sourced snapshot ───────────────────────────────────────────────────
def load_ms() -> list[dict]:
    return _load_file(_path(Config.MS_FILE))


def save_ms(rows: list[dict]) -> None:
    _save_file(_path(Config.MS_FILE), rows)


# ── Sync status ───────────────────────────────────────────────────────────────
def load_sync() -> list[dict]:
    return _load_file(_path(Config.SYNC_STATUS_FILE))


def save_sync(rows: list[dict]) -> None:
    _save_file(_path(Config.SYNC_STATUS_FILE), rows)


# ── Helpers ───────────────────────────────────────────────────────────────────
def row_key(row: dict) -> tuple[str, str]:
    """Unique identity for a run row: (orderid, vrid or '')."""
    return (str(row.get("orderid") or ""), str(row.get("vrid") or ""))


def index_by_key(rows: list[dict]) -> dict[tuple[str, str], dict]:
    return {row_key(r): r for r in rows}


def find_by_vrid(rows: list[dict], vrid: str) -> list[dict]:
    vrid = str(vrid).strip()
    return [r for r in rows if str(r.get("vrid") or "").strip() == vrid]


def get(row: dict, key: str, default: Any = None) -> Any:
    return row.get(key, default)
