import os
from pathlib import Path


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "supersecret")

    # ── JSON storage (replaces Neon/Postgres) ───────────────────────────────
    # All manual-sourcing data lives as JSON files on this network share.
    # Override with the LTL_MS_DIR env var (handy for local dev).
    LTL_MS_DIR = Path(
        os.getenv("LTL_MS_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS")
    )

    # Runs are bucketed into weekly JSON files under this subfolder, named
    # runs_<ISO-year>-W<week>.json (week = Sunday–Saturday), keyed off each
    # row's orig_planned_yard_checkin_time.
    RUNS_DIR = "runs"
    RUNS_FILE_PREFIX = "runs_"            # runs_2026-W35.json

    MS_FILE = "ms_runs.json"             # manual-sourced snapshot (was ms_runs)
    SYNC_STATUS_FILE = "sync_status.json"

    # Initial ingest job file lives on the "All CST Runs" share (renamed from
    # cst_runs.txt → ltl_ms_job.txt). Override the folder with JOB_DIR.
    JOB_DIR = Path(
        os.getenv("JOB_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\All CST Runs")
    )
    JOB_TXT = JOB_DIR / "ltl_ms_job.txt"
    SHIPPER_FILE = JOB_DIR / "source_of_truth_crawler.csv"

    # Kept for parity with the source app's logical names.
    TABLE = "cst_runs"
    MS_TABLE = "ms_runs"
