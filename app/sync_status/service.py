"""
Per-source sync status tracking, backed by a JSON file (was a Postgres table).

Each long-running sync (SMC, FMC) calls record_sync(...) on completion. The
header polls /api/sync-status to render "last updated X ago" pills.

Never raises into the caller — storage problems are logged and swallowed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app import store


def record_sync(
    source: str,
    rows_affected: Optional[int] = None,
    status: str = "ok",
    error: Optional[str] = None,
) -> None:
    """Upsert the current run for `source`."""
    try:
        rows = store.load_sync()
        by_source = {r.get("source"): r for r in rows if isinstance(r, dict)}
        by_source[source] = {
            "source": source,
            "last_run_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "rows_affected": rows_affected,
            "error_message": (error[:500] if error else None),
        }
        store.save_sync(list(by_source.values()))
    except Exception as e:
        print(f"[sync_status] record_sync({source!r}) failed: {e}")


def get_all_statuses() -> dict:
    """Return {source: {last_run_at, status, rows_affected, error_message}}."""
    try:
        rows = store.load_sync()
    except Exception as e:
        print(f"[sync_status] get_all_statuses failed: {e}")
        return {}

    out = {}
    for r in rows:
        if not isinstance(r, dict) or not r.get("source"):
            continue
        out[r["source"]] = {
            "last_run_at": r.get("last_run_at"),
            "status": r.get("status", "ok"),
            "rows_affected": r.get("rows_affected"),
            "error_message": r.get("error_message"),
        }
    return out
