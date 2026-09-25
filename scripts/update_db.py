"""
Initial ingest: read the ltl_ms_job.txt job file (renamed from cst_runs.txt)
from the "All CST Runs" share, map its (headerless) tab-delimited columns to
run rows, and upsert them into the weekly-bucketed JSON store.

The store buckets rows into weekly files by orig_planned_yard_checkin_time,
so ingest just builds row dicts and calls store.save_runs().
"""

from __future__ import annotations

import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

from app import store
from app.config import Config
from app.sync_status.service import record_sync

# ---------------- CONFIG ----------------
JOB_TXT = Config.JOB_TXT              # \\...\All CST Runs\ltl_ms_job.txt
SHIPPER_FILE = Config.SHIPPER_FILE

# Positional column mapping for the headerless ltl_ms_job.txt (19 columns).
# Index -> field name. idx 15 is intentionally unmapped (blank column).
COLUMN_MAP = {
    0:  "shippername",
    1:  "shipperid",
    2:  "tour_id",
    3:  "orderid",
    4:  "vrid",                              # comma/slash-separated -> split
    5:  "status",
    6:  "vehicle_execution_status",
    7:  "isa",
    8:  "orig_planned_yard_checkin_time",
    9:  "dest_planned_yard_checkin_time",
    10: "shipper_ref",
    11: "vehicle_carrier",
    12: "orig_country",
    13: "dest_country",
    14: "shipper_account",
    # 15: (blank)
    16: "lane",
    17: "orig_node",                         # FC/site code (also used as dest_node fallback)
    18: "rate_type",
}
EXPECTED_COLS = 19

APP_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "LTLViewer"
try:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    APP_DATA_DIR = Path.home()

LOG_FILE = APP_DATA_DIR / "ltl_ms_update.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_FILE)],
)


def _load_shipper_group_map() -> dict:
    try:
        df = pd.read_csv(SHIPPER_FILE, dtype=str).fillna("")
        df["shipperid"] = df["shipperid"].astype(str).str.strip()
        df["shipper_group"] = df["shipper_group"].astype(str).str.strip()
        return dict(zip(df["shipperid"], df["shipper_group"]))
    except Exception as e:
        logging.warning(f"Shipper group map unavailable ({e}); leaving blank.")
        return {}


def _normalize_dt(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    ts = pd.to_datetime(s, errors="coerce")
    if pd.isna(ts):
        return s  # keep raw string if unparseable
    return ts.strftime("%Y-%m-%d %H:%M:%S")


def _split_vrids(raw) -> list[str | None]:
    s = str(raw or "").strip()
    if not s:
        return [None]
    parts = [p.strip() for p in re.split(r"[/,]", s) if p.strip()]
    clean = [p for p in parts if p.lower() not in ("", "nan", "none", "no vrid", "no_vrid")]
    return clean or [None]


def _parse_job_file() -> list[dict]:
    """Read the headerless tab-delimited job file into run-row dicts."""
    df = pd.read_csv(
        JOB_TXT, delimiter="\t", encoding="latin1", header=None, dtype=str
    ).fillna("")

    if df.shape[1] < EXPECTED_COLS:
        logging.warning(
            f"Job file has {df.shape[1]} columns, expected {EXPECTED_COLS}. "
            "Mapping will use whatever indices are present."
        )

    shipper_group_map = _load_shipper_group_map()
    rows: list[dict] = []

    for _, r in df.iterrows():
        base: dict = {}
        for idx, field in COLUMN_MAP.items():
            if idx < len(r):
                val = r.iloc[idx]
                base[field] = val if str(val).strip() != "" else None

        # Normalise dates.
        base["orig_planned_yard_checkin_time"] = _normalize_dt(
            base.get("orig_planned_yard_checkin_time")
        )
        base["dest_planned_yard_checkin_time"] = _normalize_dt(
            base.get("dest_planned_yard_checkin_time")
        )

        # dest_node falls back to the same site code when not distinguished.
        base.setdefault("dest_node", base.get("orig_node"))

        # shipper_group from source-of-truth CSV.
        sid = str(base.get("shipperid") or "").strip()
        base["shipper_group"] = shipper_group_map.get(sid, "")

        # Explode multi-VRID rows into one row per VRID.
        for vrid in _split_vrids(base.get("vrid")):
            row = base.copy()
            row["vrid"] = vrid
            rows.append(row)

    return rows


def update_runs_from_txt() -> int:
    """Read ltl_ms_job.txt and upsert into the weekly JSON store."""
    start = datetime.now()
    logging.info("=== LTL MS ingest started ===")
    try:
        incoming = _parse_job_file()
        if not incoming:
            logging.warning("Job file produced no rows.")
            record_sync("ingest", rows_affected=0)
            return 0

        # MS-owned columns preserved from existing rows on re-ingest.
        ms_owned = {
            "is_manual_source", "sims", "ms_cost", "manual_source_by",
            "manual_source_date", "email_sent", "email_sent_count",
            "email_sent_confirmed_at", "email_sent_by", "email_generated_at",
            "orig_address", "dest_address",
        }

        existing = store.load_runs()
        index = store.index_by_key(existing)

        # Dedupe incoming (orderid, vrid); last wins.
        incoming_index: dict[tuple, dict] = {}
        for new in incoming:
            incoming_index[store.row_key(new)] = new

        for key, new in incoming_index.items():
            cur = index.get(key)
            if cur is None:
                index[key] = new
            else:
                for col, val in new.items():
                    if col in ms_owned:
                        continue
                    cur[col] = val

        merged = list(index.values())
        store.save_runs(merged)   # re-buckets into weekly files by checkin date

        weeks = store.list_week_keys()
        logging.info(
            f"Upserted {len(incoming_index)} unique rows "
            f"({len(incoming)} raw); store now spans {len(weeks)} week file(s): {weeks}"
        )
        record_sync("ingest", rows_affected=len(incoming_index))
        return len(incoming_index)
    except FileNotFoundError:
        logging.error(f"Job file not found: {JOB_TXT}")
        record_sync("ingest", status="error", error=f"Job file not found: {JOB_TXT}")
        return 0
    except Exception as e:
        logging.error(f"Ingest failed: {e}")
        record_sync("ingest", status="error", error=str(e))
        return 0
    finally:
        logging.info(f"Elapsed: {datetime.now() - start}")
        logging.info("=== LTL MS ingest finished ===\n")


if __name__ == "__main__":
    update_runs_from_txt()
