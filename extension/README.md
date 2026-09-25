# MS Viewer — Manual Sourcing Viewer (Firefox WebExtension)

Formerly "LTL Viewer Overlay"; renamed when the CST team was added. The add-on
ID (`ltl-viewer-overlay@internal`) and the internal `ltl-` prefixes are kept so
existing installs upgrade in place.

A Firefox (Manifest V3) extension with its own **full-page UI** (click the
toolbar button; it opens `ui/app.html` in a tab, or focuses it if already open).
It reproduces what the LTL_Viewer Flask app did: a manual-sourcing table,
manual-source + email state tracking, `.eml` generation and a dashboard — backed
by **SharePoint** instead of a network-share JSON store, so it ships to many
users without a central server.

Until 0.2.x it was an overlay injected onto the SMC page. It's now a standalone
page; SMC is reached through a bridge like SharePoint and FMC.

## Architecture

There is no backend server. The page talks only to the background worker, which
reaches each Amazon system through a **content-script bridge on a tab of that
origin** (the worker's own fetch doesn't carry the Midway session). Tabs are
opened in the background automatically when missing.

- **SMC = the load list (read source of truth).** `content/smc.js` on an SMC
  tab replays SMC's own search API same-origin; the list is then validated on
  FMC and reduced to loads whose carrier is empty or a placeholder.
- **SharePoint = the work saved on top.** Manual-source + email state, the
  auto-tracked runs and their outcomes, one record per `(orderid, vrid)`.
- **FMC = live truth per VRID.** Status/carrier/tour enrichment and the
  outcome sweep.

```
ui/app.html ──msg──▶ background ──▶ SMC tab bridge        (content/smc.js)
                                ──▶ SharePoint tab bridge (content/sp-bridge.js)
                                ──▶ FMC tab bridge        (content/fmc-bridge.js)
```

| Concern                     | File                              |
| --------------------------- | --------------------------------- |
| Page shell                          | `ui/app.html` + `ui/app.css` |
| Generic tab-bridge client           | `background/bridgeClient.js` |
| SMC client (via bridge)             | `background/smcClient.js` |
| SMC fetch + "needs sourcing" filter (bridge) | `content/smc.js` |
| UI (table/filters/badges/team picker) | `content/overlay.js` + `.css` |
| EML builder (verbatim template)     | `content/eml.js`          |
| SharePoint REST (via bridge)        | `background/spClient.js`  |
| SharePoint-origin fetch bridge      | `content/sp-bridge.js`    |
| Records store (per orderid|vrid)    | `background/sharepointStore.js` |
| Records service (MS + email logic)  | `background/runsService.js` |
| Message router                      | `background/background.js` |

### Auth: cookie-based, no OAuth — via a SharePoint-origin bridge

The user is already signed in to SharePoint in the browser (Midway). SharePoint
REST calls (`_api/...`) must run **on the SharePoint origin** to carry that
session — a `fetch` from the background worker does NOT (write-authorization via
`_api/contextinfo` returns 403). So SharePoint I/O is routed through a **bridge
content script** (`content/sp-bridge.js`) injected into the SharePoint site:

```
overlay (SMC page) → background worker → SharePoint tab's sp-bridge.js → _api
```

`spClient.js` (background) finds an open SharePoint tab — or opens one in the
background — and forwards each REST op to the bridge via `tabs.sendMessage`. The
bridge fetches same-origin (cookies + form digest work) and returns the result.

**Requirement:** you must be signed in to SharePoint. If no SharePoint tab is
open when a save happens, the extension opens one automatically (inactive). The
first write may take a moment while that tab loads.

No Azure AD app registration, no login page, no bearer tokens.

### Storage shape: one SharePoint List of records

SharePoint holds **only the annotations** — one item per `(orderid, vrid)` in
the `LTL_Records` list, carrying the manual-source + email fields
(`is_manual_source`, `sims`, `ms_cost`, `manual_source_*`, `email_*`). The load
data itself is never stored — it comes fresh from SMC each time.

A List (vs. a single JSON file) is deliberate: many browsers writing at once to a
shared file would clobber each other. Per-item upserts are safe. Row identity is
`orderid|vrid`, stored in the item's `Title`, with `orderid`/`vrid` promoted to
their own columns and the full record JSON in a `Payload` column.

`LTL_Records` is **auto-created on first write** (list + columns) — nobody
hand-builds it. See `sharepointStore.js` `ensureList()`.

### Teams: LTL and CST

The panel opens on a **team picker** (LTL | CST). Everything team-specific is
one entry in `Config.TEAMS` (`config.js`); the header badge switches team at
any time and the last choice is remembered for the next page load.

| | LTL | CST |
|---|---|---|
| Load-list source | **FMC** criteria search (`fmcSearch`) | **SMC** order search (`smcQuery`) |
| Scope | shipper accounts `ATSLTLAFInbound` / `ATSLTLInboundVendor` / `SwaFbaSPTransfer` × placeholder carriers `NCSL` / `AZNG` / `DUMMY` / `RLB1` | `shipperIds` from the shipper list, all freight types, all channels |
| SMC's role | **enrichment only** — tags FM / MM | the source; FMC validates afterwards |
| Toolbar defaults | status `PLANNED` (no carrier chips — the search already restricts carriers) | carrier RLB1/AZNG/DUMMY + status `PLANNED` |

The two teams find their loads in opposite directions. **CST** starts from SMC
(its shippers' orders) and asks FMC whether each is covered. **LTL** starts
from **FMC**, because its middle-mile runs (Amazon-internal shipper accounts)
never pass through SMC and so have no order to find there.

**Load sequence — both teams.** Loading is shown as a **pipeline**: every step
is listed up front in a centered card and marked pending → active → done as it
runs, with live counts ("43 runs on placeholder carriers", "20 FM · 11 MM",
"12 records merged"), a progress bar, and an elapsed timer so a stall is
obvious. The first step checks that the **SMC, SharePoint and FMC sessions are
live**. If any step fails, it turns red **in place** with the exact error
underneath and Open / Retry / Dismiss buttons — completed steps stay green, so
you can see precisely how far the load got and why it stopped. Nothing is
rendered until every step has completed.

**LTL (FMC-sourced).** FMC is searched by criteria — the configured shipper
accounts × placeholder carriers, over the planned-dock window — so every run
returned is on a placeholder carrier, i.e. needs sourcing by construction.
Runs FMC reports as `CANCELLED`, or whose `UNCOVERED_LOAD_VEHICLE_RUN`
disruption is `RESOLVED`, are dropped. The remaining VRIDs are then looked up
in SMC purely to **enrich and tag**: a VRID that exists in SMC is a shipper
order → **FM** (first mile); one SMC has never seen → **MM** (middle mile).
SMC adds shipper/order context to FM rows but never gates the list, and an SMC
failure at this stage degrades to a toast rather than blocking the FMC list.
The table leads with the FM/MM badge and the shipper account; both are stored
on the SharePoint record so the Dashboard can split by them.

**CST (SMC-sourced).** SMC is fetched, then **while still loading** every VRID
is validated on FMC (execution status / carrier / tour / yard times overwrite
SMC's). "Needs sourcing" is decided by **FMC's `vehicle_carrier`**: kept only
if empty or a placeholder (`sourcing.placeholderCarriers`); a real carrier
means covered → dropped. All CST rows are FM.

Both paths log to the console (`[LTL overlay] FMC search: …`, `tagged N FM /
M MM`, `Carrier breakdown: …`) so an unexpected count can be traced to what
FMC/SMC actually returned.
| Records list | `LTL_Records` | `CST_Records` |
| Shipper source of truth | – | `source_of_truth_crawler.csv` in the SharePoint "CST" library (fallback: `CST_Shippers` list) |
| Extra column | – | `shipper_group` (CST / CST - ELEX / CST - Mega Shipper) |

CST's scope is defined by its shipper source of truth, read **automatically from
SharePoint** the same way CST_viewer does. CST_viewer's
`scripts/update_shippers.py` exports the "Shippers" sheet of
`Source Of Truth 2026.xlsx` to `source_of_truth_crawler.csv` inside the
SharePoint-synced library "Amazon Freight Operations - CST"
(`CST L4+/PROCESS IMPROVEMENT/`). The extension reads that CSV through the
SharePoint bridge (`Config.TEAMS.CST.shipperSource`): configured paths first,
then the last path that worked, then SharePoint Search by file name. Header
aliases like `Shipper ID` / `DEPT` are accepted and junk rows without a numeric
shipperid are dropped. Cached for 30 minutes; the toolbar's **Shippers (N) ↻**
button re-reads it.

Fallback: if the CSV can't be found, the extension uses the `CST_Shippers`
SharePoint list instead, which you can fill from the toolbar's
**Shippers · Import** (pick the CSV; the import replaces the list).

Every background message carries `team`, so records, shippers and the dashboard
are scoped to the selected team. FMC enrichment is team-agnostic (per VRID).

The Dashboard shows two sections per team: a **Live window** breakdown of the
rows currently loaded in Manual Sourcing (status / origin country / carrier /
shipper group / top shippers — not stored anywhere) and the **Work history**
metrics from that team's SharePoint records.

**Dashboard filters.** By default the dashboard counts only runs that were
**worked or covered** — manual-sourced, emailed, or reported covered by FMC.
Runs that merely appeared on the sourcing list (auto-tracked "seen-only"
records, used so RLB pickups still show as outcomes) are hidden; tick
**Include seen-only** to add them. Two independent date ranges narrow the set:

- **Activity date** — when something happened to the run: manual source,
  email generated / sent, or covered. Appearing on the list is *not* activity.
- **Planned checkin** — the run's departure (`orig_planned_yard_checkin_time`),
  with forward-looking presets (Today / Next 7d / 14d / 30d / Any).

Set one, the other, or both; the MS / Generated / Sent flags apply on top, and
Download CSV exports exactly what the filters show.

### Auto-refresh

The footer has an auto-refresh interval (off / 5 / 10 / 15 / 20 / 30 / 60 min,
default **20**), saved in `browser.storage.local` (`ltl.autoRefreshMin`), with a
`next in Xm` countdown beside it. It re-runs the normal SMC → FMC →
SharePoint load, so the clock restarts after any load (manual Refresh included).

It only fires on the Manual Sourcing tab in the normal sourcing view, and never
mid-action. Each of these defers it to the next tick (checked every 5s) rather
than cancelling it: a load already running, a session blocker on screen, any
selected rows (pending EML), the Recently-covered or SMC-lookup views, the
Dashboard tab, or a hidden/background tab. Returning to a hidden tab runs a
refresh that fell due while it was away.

### Theme

The header has a Light / Dark / System switch. System follows the OS
`prefers-color-scheme` and tracks changes live. The choice is saved in
`browser.storage.local` (`ltl.theme`). Dark styles live at the bottom of
`content/overlay.css` under `html[data-theme="dark"]`.

### Searching for a run that isn't on the list

The sourcing list only holds runs with no real carrier. Searching for an order
ID or VRID that already has one (or a comma-separated list of them) finds
nothing, so a bar appears under the toolbar: *N ID(s) not on the sourcing list —
Look up in SMC*. Pressing Enter in the search box does the same. The lookup
re-queries SMC with the team's query over a ±14-day window (checking the last
fetch first), validates the hits on FMC and merges any existing SharePoint
record, then shows them in the table **read-only** with an `SMC` tag: no
select/EML, no Manual Source or email controls, nothing tracked or saved. IDs
SMC doesn't return in that window are listed as not found. Clearing the search
(or the *Back to sourcing list* button) returns to the normal view.

### Exporting past data (history)

Manual Sourcing's *Download CSV* only covers loads currently in the sourcing
list. For history, use the Dashboard: pick the activity date range, set the
MS / Generated / Sent filters (Any / Yes / No), and click **Download CSV**. It
exports the matching SharePoint records as `<TEAM>_History_<from>_<to>.csv`.

Records capture a load-context snapshot at save time (shipper, shipper group,
lane, countries, planned check-in times, carrier, tour, freight type) so the
export is self-contained after a load has left SMC. Records written before this
snapshot existed only carry identity + annotation fields.

### Outcomes: was the run covered by us, or by RLB on its own?

Every run that appears on the sourcing list is **auto-tracked**: after each
Manual Sourcing load the overlay sends the rows to `trackSeen`, which creates a
record (`first_seen_at` + load snapshot) for any run that doesn't have one yet
and bumps `last_seen_at` at most daily. Ticking Manual Source means "we
intervened"; a record with no work flags is *seen-only*.

The real workflow ticks **after** the carrier is assigned (we find a carrier,
FMC gets the assignment, then we record it). By then the run has left the
sourcing list, so the Manual Sourcing toolbar has a **Recently covered (N)**
toggle: it swaps the table to the tracked runs that got a carrier in the last 7
days (status/carrier filters are bypassed there) with the Manual Source checkbox
live. The Dashboard's Runs tab has the same checkbox. Ticking before the carrier
is assigned still works too.

Once a run gets a real carrier it drops out of the list, so the extension checks
back on it. The **outcome sweep** (`sweepOutcomes`) takes every tracked record
that isn't covered yet (activity within `outcomeSweepDays`), looks the VRIDs up
in FMC, and when FMC shows a carrier that isn't a placeholder
(`sourcing.placeholderCarriers` / `placeholderCarrierPrefixes`) writes
`final_carrier`, `final_carrier_name`, `final_status`, `covered_at`. Each run
ends up as **Open**, **Covered (MS)** (manual sourced by us) or **Covered (RLB)**
(picked up with no intervention). The sweep also applies retention: seen-only
records are deleted `retentionDays` (180) after they were last seen; worked
records are kept forever.

The sweep runs in the background after each load (throttled to every 15 minutes
per team) and always before the Dashboard renders.

The Dashboard has sub-tabs under a shared control bar (date range, MS /
Generated / Sent filters, Download CSV, Refresh):

- **Overview** — tracked / manual sourced / covered by MS / covered by RLB /
  open cards, intervention rate, time-to-cover, outcome funnel, weekly trends.
- **Runs** — every tracked run in range with its outcome and current carrier,
  filterable by outcome and worked vs seen-only.
- **Emails** — funnel + sent per day. **Users** — by-user table.
- **Live board** — breakdown of what's loaded in Manual Sourcing right now.

The history CSV includes `first_seen_at`, `last_seen_at`, `outcome`, `covered`,
`final_carrier`, `final_carrier_name`, `final_status`, `covered_at`.

## Setup

Minimal, because there's no OAuth. The site is already configured in
`config.js` (`amazongbr.sharepoint.com` / `/sites/AmazonFreightOperations`).

1. **Be signed in to SharePoint** in the browser (Midway). The extension reuses
   that session — if you can open the site in a tab, the extension can reach it.
2. **Have write access** to the `AmazonFreightOperations` site (needed so the
   extension can auto-create the list on first write).
3. That's it. On the first save the extension creates the team's records list
   (`LTL_Records` / `CST_Records`) with its columns if it doesn't exist. For
   CST, also import the shipper CSV once (see *Teams* above).

To point at a different site, list name, SMC query or EML recipients, edit the
team entry in `config.js` (`Config.TEAMS`).

## Load it (temporary, for development)

1. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
2. Select `extension/manifest.json`.
3. Click **Inspect** on the extension to open the **background console** (this is
   where SharePoint request/response traces appear).
4. Click the **MS Viewer** toolbar button; pick a team — the page
   fetches from SMC and shows the loads that need sourcing.
5. On the first save (manual-source toggle / EML), the extension routes through a
   SharePoint tab (opening one if needed). Watch the background console for the
   list auto-create + `HTTP 201` write.

## File map

```
extension/
  manifest.json            MV3 manifest (SMC + SharePoint content scripts, tabs perm)
  config.js                Site URL, list name, EML constants, DEBUG flag
  icons/                   icon-48.png, icon-96.png
  background/
    debug.js               Toggleable logger (SpError-aware); __ltlDebug on background/page
    spClient.js            SharePoint REST — delegates to the bridge via a SharePoint tab
    sharepointStore.js     Records store: load/save + list auto-create + rowKey
    runsService.js         Records service: getRecords, MS toggle, email generate/sent
    background.js          Message router (getRecords/toggle*/mark*/setDebug)
  content/
    smc.js                 SMC fetch + "needs sourcing" filter (VRID present, no carrier)
    eml.js                 EML builder (verbatim template) -> window.__ltlEml
    sp-bridge.js           Runs on the SharePoint origin; does the actual _api fetches
    overlay.js             Injected UI: table, filters, sort/search, links, badges, MS toggle, EML
    overlay.css            Panel styles (scoped under #ltl-overlay)
```

## Debugging

`Config.DEBUG` (default on) enables verbose `[LTL ...]` traces. Toggle live from
the overlay's **Debug** button, or in either console: `__ltlDebug.enable()` /
`.disable()`. Errors always print, including `SpError` HTTP status + response
body, so failed SharePoint calls show exactly what was rejected. The overlay's
page console shows `[LTL smc]` (fetch) and `[LTL overlay]` (message) traces; the
**background** console shows the SharePoint request/response traces.

## What's verified vs. what needs a live environment

Verified locally:
- All JS parses (`node --check`) and `manifest.json` is valid.
- SMC order→row mapping and the "needs sourcing" filter (VRID present + no
  carrier) behave correctly on sample orders.
- The records service (MS toggle, email generate/sent, validation) round-trips
  correctly against an in-memory store.
- Message actions line up across overlay ↔ background ↔ bridge.

Confirmed live in-browser:
- SMC fetch + filter (≈3.8k orders → those needing sourcing) and the table.
- SharePoint **read** (`getRecords`) succeeds; empty until records are saved.

Still to confirm live:
- SharePoint **write** end-to-end via the bridge (the earlier background-fetch
  403 on `_api/contextinfo` is what the bridge fixes). Toggle manual-source or
  generate an EML and watch the background console for the `HTTP 201` write.

## Status

Records + EML flow built: SMC feeds the load list, SharePoint stores the
annotations (via the SharePoint-origin bridge), writes are keyed `orderid|vrid`.
The remaining step is confirming the bridged SharePoint write in your session.

Releases are signed and published automatically by GitHub Actions; installed copies auto-update.

