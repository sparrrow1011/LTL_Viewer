# All Runs (Firefox WebExtension)

A live, read-only dashboard of **every run in SMC** for yesterday, today and
tomorrow, validated on FMC and tagged **CST / ELEX / FTL** from the CST
shipper source of truth. It replaces the QuickSight "All CST Runs → Summary"
sheet, with the data pulled from the systems directly instead of the
`af_cst_runs_merge` dataset.

Click the toolbar button; it opens `ui/runs.html` in a tab (or focuses it).

It is **its own extension** — add-on id `all-runs@internal`, slug `all-runs`,
its own release feed and remote-control file. The plumbing modules are copies of
the HC Calculator's (`control.js` / `usage.js` are shared **verbatim** across all
four extensions — keep them identical; only their `init()` arguments differ).

## What it shows

Filters (all applied client-side, over the fetched window):
Pick up date (default today) · Group (CST / ELEX / FTL) · Origin country ·
Shipper · Status (default: everything except CANCELLED) · Destination type
(INBOUND / OFF-AMAZON) · Cancellation reason · Delivery date for the D-1 panel
(default yesterday). Multi-selects remember what you **excluded**, so a value
that first appears after a refresh is included automatically.

**Summary tab**

| Visual | Source |
| ------ | ------ |
| KPI cards: Total, CST, ELEX, FTL, Same day, Different day, D-1 delivery | runs picking up on the Pick up date |
| To be delivered today (bar + table) | Same Day vs Different Day Delivery |
| Runs by origin country (pie + legend) | FMC first-stop country, else SMC origin address |
| Top ranked | top 3 shippers by runs |
| Eventually delivered / pending to complete | D-1 runs: COMPLETED vs PENDING, with the pending list |
| Destination node (pivot) | shipper × destination node × group |
| Origin node (pivot) | shipper × origin node × planned yard check-in hour |

**To be delivered tab**: per shipper (collapsible) → origin node → destination
node, how many VRIDs are still to be delivered. It has its **own** filter bar —
Group, Shipper, Origin node, Destination node, Status — with Status defaulting to
`IN_TRANSIT` + `PLANNED`; switching tabs resets each tab to its own defaults.
Exports the pivot and the VRID list.

The **pick-up date range** (from → to, default today → today, "Today" / "All"
shortcuts, bounded by the fetched window) is shared by every tab.

**RLB tab**: runs still on a placeholder carrier (FMC SCAC `RLB1` / `DUMMY` /
`AZNG`, `Config…runs.placeholderCarriers`), i.e. what still needs sourcing. Own
filters: SCAC (default = the placeholders), group, execution status, shipper, origin
country, destination country, plus the shared pick-up range. Count per SCAC on
the left; on the right the runs sorted by planned pick-up with shipper id/name,
group, VRID, pick-up time, SCAC, lane (origin → destination), `orig_load_type`
(LIVE / PRELOADED, read from FMC best-effort — the field name is unconfirmed
and shows — when absent), status and order. CSV export.

**All data tab**: one row per VRID with links to SMC (order) and FMC (VRID),
sortable, for the pick-up date or the whole window. Every table has a **⬇ CSV**.

## Field definitions

| Field | Definition |
| ----- | ---------- |
| Pick up date | Local day of the planned yard check-in at the **first** stop: FMC `firstYardArrival`, else SMC `stops[0].startTime` |
| Delivery date | Local day of the planned yard check-in at the **last** stop: FMC `lastYardArrival`, else SMC last-stop `startTime` |
| Same / Different Day | pickup date == delivery date |
| Status | FMC `executionStatus` per VRID; SMC's order-level status when the VRID isn't in FMC |
| Destination type | **INBOUND** when the destination node looks like an Amazon node code (`Config…runs.amazonNodePattern`, e.g. `DTM2`, `RSWR`); otherwise **OFF-AMAZON** (customer codes such as `PROCTER__53881_118`). A heuristic — adjust the pattern if a node is misclassified. |
| Group | shipper id in `source_of_truth_crawler.csv` → **CST**, or **ELEX** when its `shipper_group` is `CST - ELEX`; not in the file → **FTL** |
| D-1 COMPLETED | status in `completedStatuses` (`ARRIVED_AT_FINAL_DESTINATION`, `COMPLETED`); anything else is PENDING |
| Cancellation reason | **best effort** — the FMC field name is unconfirmed; `content/fmc-bridge.js` tries several spellings and falls back to a cancel-type disruption. Shows `(not given)` on a cancelled run when none matched. |

"Today" is the browser's local day. The SMC pull is `today − daysBack` →
`today + daysForward` (1 / 1 in `config.js`).

## How a load works

The page orchestrates it, one short message per step, so the background event
page never awaits a single message for ~30 s (Firefox kills an idle event page
mid-await):

1. **Remote control** — `controlStatus`; a disabled install stops here.
2. **Sessions** — SMC, FMC and SharePoint are pinged; expired ones get an
   "Open …" button.
3. **CST shipper source of truth** — `source_of_truth_crawler.csv` from
   SharePoint (path that worked last → configured paths → SharePoint Search).
   If it can't be found the load **continues** and everything is FTL.
4. **SMC** — `/shipper/order/search` with the "everything" query (all freight
   types, every execution status, no country / readyForScheduling filter, **no
   shipperIds**), 200 orders per page. One row per VRID; rows without a VRID are
   dropped. If SMC has more than 100 pages the result is flagged **truncated**
   and a warning banner stays on the page.
5. **FMC** — by-id lookups in chunks of 300 VRIDs (50 per HTTP batch inside the
   bridge). FMC's status, planned times, nodes, countries and carrier overwrite
   SMC's order-level copies.
6. **Build** — normalise, cache to `browser.storage.local`, render.

On open the page paints the cached result immediately, then refreshes.

**Auto-refresh**: header select, off or 5–60 minutes in steps of 5 (default 15,
remembered). Runs only while the tab is open and visible, never while a load is
in progress or a step has failed. A background refresh shows the pipeline card
docked bottom-right without dimming the page.

```
ui/runs.html ──msg──▶ background ──▶ SMC tab bridge        (content/smc.js)
                                 ──▶ SharePoint tab bridge (content/sp-bridge.js)
                                 ──▶ FMC tab bridge        (content/fmc-bridge.js)
```

| Concern | File |
| ------- | ---- |
| Page (shell, filters, charts, pivots, pipeline card) | `ui/runs.js` + `ui/runs.css` |
| Message router | `background/background.js` |
| Window, SMC options, UI config, result cache | `background/runsService.js` |
| Shipper source of truth (CSV only, tags runs) | `background/shippers.js` |
| SharePoint REST via the bridge | `background/spClient.js` |
| SMC / FMC clients via their bridges | `background/smcClient.js`, `background/fmcClient.js` |
| Remote control + usage roster | `background/control.js`, `background/usage.js` |

No dependencies, no bundler, plain ES2020; charts are inline SVG.

## Storage

Read-only against SMC / FMC / SharePoint. The only SharePoint write is the
shared `Extension_Installs` usage roster (`Title = all-runs|<installId>`).
Local: the last result (`runs.last.ALL`), the auto-refresh interval, the shipper
CSV path that worked, and the control/usage records.

## Setup

1. Be signed in (Midway) to SMC, FMC and SharePoint in the same browser. Tabs
   are opened in the background when missing.
2. Firefox grants MV3 host permissions automatically only for *temporary*
   add-ons. An installed `.xpi` starts with site access **off**; the page shows
   a banner with a **Grant site access** button (or `about:addons` → All Runs →
   Permissions).

## Load it (temporary, for development)

`about:debugging` → This Firefox → Load Temporary Add-on → `runs/manifest.json`.

## Release

Pushing to `main` with changes under `runs/` runs
`.github/workflows/sign-and-publish.yml`: lint → AMO sign → publish the `.xpi`
and `updates.json` to the `updates` branch under the `all-runs` slug. Installed
copies auto-update from the manifest's `update_url`. **Bump `manifest.json`
version first** or the job fails on purpose.

Remote control: `.github/control/all-runs.json` seeds `all-runs/control.json` on
the `updates` branch the first time; after that edit it with the Extension Control
add-on (`control_extension/`), on the admin page, or with
`.github/scripts/control.ps1 all-runs disable-user <alias> "<message>"`. Installs
re-read it every 15 minutes and before a load unless it was read within the last
minute; the cached verdict is re-applied to the current alias/version on every check.

## Debugging

`Config.DEBUG` enables verbose `[RUNS …]` traces; toggle live in the background
console with `__runsDebug.enable()` / `.disable()`. The page logs `[RUNS page]`
after `__runsPageDebug.enable()`.

## What's verified vs. what needs a live environment

Verified locally (no SMC / FMC / SharePoint involved): every JS file parses,
`web-ext lint --self-hosted` reports 0 errors, the background module graph loads
in Node against a stubbed `browser` and answers `getConfig` / `runsWindow` /
`loadCache` / `saveCache` / `controlStatus`, and the page's normalisation (group
tagging, same/different day, destination type, local pickup day from both the
FMC epoch and the SMC ISO string, cancel-reason placeholders) passes a sample-row
check.

Still to confirm in a real session: the unfiltered SMC volume for three days
stays inside the 100-page cap; the FMC cancellation-reason field name; and that
the destination-type heuristic matches how the QuickSight dataset classified
INBOUND / OFF-AMAZON.
