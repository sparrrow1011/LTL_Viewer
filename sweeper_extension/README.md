# Lobby Sweeper (Firefox extension)

Standalone port of CST_viewer's **Lobby Sweeper** page (`scrapers/paragon.py`,
`scrapers/lobby_monitor.py`, `app/tasks/paragon_scheduler.py`) into a Firefox
MV3 extension. No Python, no Playwright, no network-share CSVs — it uses the
Paragon and SMC sessions you already have open in Firefox.

## What it does

| Job | Source | Logic | Output |
| --- | --- | --- | --- |
| **Wrong-queue sweep** | SMC `/shipper/order/search` → (orderid, vrid) pairs for today + tomorrow | Batched Paragon `/hz/api/search` (30 pairs/batch, split on 400) → `check` when queue ∉ team `validQueues` and status ≠ Resolved | Table + CSV, desktop notification, optional Slack digest |
| **SLA monitor** | Paragon lobby query (team `lobbyQueues` × open statuses) | Needs Response (severity thresholds), New Case (unassigned + no owner), PAA Overdue (>24h) | Alert table, toolbar badge, desktop notification, optional Slack per alert |

Both can run on a schedule (default 30 min, `browser.alarms`). Alerts are
de-duplicated for 4h per (case, type) so the same case doesn't re-notify every
cycle (the Python monitor re-posted everything each run).

## Layout

```
manifest.json
config.js                 endpoints, SLA thresholds, TEAMS (validQueues / lobbyQueues / smcQuery)
shared/signals.js         pure detection logic (ported from Python) — used by background + UI
content/paragon-bridge.js runs ON paragon-eu.amazon.com; same-origin API calls
content/smc-bridge.js     runs ON SMC; pulls orderid/vrid pairs
background/
  background.js           message router, alarm, toolbar button
  sweeper.js              runSweep / runLobby / runCycle, notifications, badge
  paragonClient.js        finds/opens a Paragon tab, reads pgn_csrf_token via cookies API
  smcClient.js            finds/opens an SMC tab
  bridgeClient.js         generic tab-bridge helper (inject on demand)
  store.js                settings + last results + alert log (browser.storage.local)
ui/sweeper.html|css|js    the page behind the toolbar button
```

## Install for development

1. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`.
2. Sign in to Paragon and SMC (Midway) in that profile.
3. Click the toolbar icon → **Check sessions** → **Run both**.

Missing Paragon/SMC tabs are opened in the background automatically. An expired
Midway session is detected (redirect-to-login / HTML 200) and shown in the banner
rather than producing empty results.

## Configuration

* **Team, schedule, notifications, Slack webhook** → Settings tab (stored in
  `browser.storage.local`, per profile).
* **Queues and thresholds** → `config.js`. `Config.TEAMS.CST` carries the
  queues from CST_viewer (`paragon.py VALID_QUEUES`, `lobby_monitor.py
  LOBBY_QUERY`) and the SMC query from `scrapers/smc.py`. Adding a team = adding
  an entry.
* **Known gap**: CST_viewer's SMC pull is restricted to the CST shipper list
  (Source Of Truth sheet). This extension sweeps every shipper's orders in the
  window, so cases for non-CST shippers can show up as `check`.
* **Slack**: uses an *incoming webhook URL* you paste in Settings. Do not embed a
  bot token in the source.

## Differences from the CST_viewer original

* Severity 2 cases now get a Needs Response threshold (90 min); the Python
  version silently skipped them. Tune in `Config.SLA`.
* One source of truth for "valid queues" (the CST page's JS used 3 queues while
  the Python check used 7).
* Alert de-duplication (see above). "Reset notification memory" in Settings
  clears it.
* No CSV/xlsx written to the share; download from the Sweeper tab instead.

## Build / sign

```
npx web-ext lint  --source-dir .
npx web-ext build --source-dir . --overwrite-dest
```

Signing follows the same `web-ext sign --channel=unlisted` flow as the MS Viewer
extension (AMO credentials via `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`).

Releases are signed and published automatically by GitHub Actions; installed copies auto-update.


## Remote control

The administrator can pause the sweeper on any install without a new release:
`lobby-sweeper/control.json` on the repo's `updates` branch is re-read every
15 minutes and before each run. It supports a global switch, a minimum version,
a notice banner, and per-user (SMC alias) or per-install-ID overrides. Your
alias and install ID are shown in Settings → "This install". Admin helper:
`.github/scripts/control.ps1 lobby-sweeper disable-user <alias> "<message>"`.
