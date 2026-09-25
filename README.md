# LTL Manual Sourcing Viewer

A trimmed copy of the CST Viewer's **manual sourcing** feature. No users, no
login — free for all. Storage is plain JSON files on a network share instead
of Neon/Postgres. SMC and FMC updates still run through Playwright + Chromium,
and the app is packaged with PyInstaller.

## Data storage (no database)

All state lives as JSON on the share:

```
\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS\
├── cst_runs.json         # main runs table
├── ms_runs.json          # manual-sourced snapshot
├── sync_status.json      # SMC/FMC "last updated" pills
├── ltl_ms_job.txt        # tab-delimited ingest job file (was cst_runs.txt)
├── source_of_truth_crawler.csv   # shipperid -> shipper_group map (optional)
└── JSON_Output\          # scratch output from the FMC scraper
```

Override the share location for local development with the `LTL_MS_DIR`
environment variable, e.g. `set LTL_MS_DIR=C:\temp\ltl_ms`.

## Run (development)

```
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
python main.py          # desktop window (pywebview), Flask on :9000
# or, browser-only:
python app.py           # Flask dev server on :5000
```

## Pages / API

- `/manual-sourcing` — build and send manual-sourcing emails (EML)
- `/manual-sourced-runs` — review runs already marked manual-sourced
- `GET  /api/data` — all runs (or ms rows when `is_manual_source=1`), filtered
- `POST /api/toggle-manual-source` — mark/unmark a VRID (snapshots into ms_runs)
- `POST /api/toggle-email-sent`, `/api/email/mark-sent`, `/api/email/mark-generated`
- `GET  /api/filters/*`, `/api/distinct/*` — dropdown values
- `POST /api/run-smc`, `/api/update-db` — background refreshes
- `GET  /api/sync-status` — header pills

## Updates (Playwright + Chromium)

- **SMC**: `scrapers/smc.py` scrapes the SMC order-search API through a
  persistent Chromium session; `scripts/smc_update.py` maps the orders into
  `cst_runs.json`, drops `LESS_THAN_TRUCKLOAD` rows, and clears stale VRIDs.
- **FMC**: `scrapers/fmc_api.py` / `scrapers/fmc.py` fetch execution status and
  addresses; `scripts/fmc_update.py` merges them into `cst_runs.json` by VRID.

## Build (PyInstaller)

```
set PLAYWRIGHT_BROWSERS_PATH=0
python -m playwright install chromium
pyinstaller LTL_Viewer.spec
```

`PLAYWRIGHT_BROWSERS_PATH=0` installs Chromium inside the `playwright` package
so the spec bundles it into `dist\LTL_Viewer\`.
```
