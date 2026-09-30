# P&G TMS Viewer

A Firefox (Manifest V3) extension that overlays the JDA / BlueYonder **TMS**
("Transportation Manager") *Shipment Leg list* on
`https://pgem-aztms-sso-pr1.jdadelivers.com` and presents the fields a CST agent
needs — with quick validation checks against the P&G SOP rules.

It reads TMS and SMC; it does not change anything in either. The next
milestone is auto-filling SMC from the new rows.

## Using it

1. Log in to TMS and open the **List of Shipment Legs** (Forecast search).
2. A **P&G Viewer** button appears bottom-right of the list frame. Click it
   (or the toolbar icon) to open the panel; **Esc** or ✕ closes it.
3. The panel reads the table on open. **Refresh** re-reads it after a new
   search.
4. **Check SMC** asks SMC which Load IDs already have an order (Load ID ==
   SMC *shipper reference*). Rows without one are marked **NEW** and
   highlighted; matched rows link to the SMC order and show its status.
   Tick **New only** to hide the rest. Two more columns appear:
   - **SMC order**: pickup stop and time (in the stop's time zone), delivery
     stop, ISA, BOL, carrier, VRID, pallets as SMC has them.
   - **SMC checks**: SOP alignment — `BOL ≠ PO` (error), SMC PO differs from
     the TMS PO (warn), SMC pickup stop is not the TMS origin site (error,
     matched on `Config.SITES[x].smcMatch` keywords), no ISA yet (warn).
     When the search payload has no BOL field, the order detail is fetched
     for those orders; if that is not possible either, the row says
     "BOL not readable from SMC" instead of guessing.
   After a check with new loads the table switches to **New only** and the
   status line shows the new loads per site (e.g. "7 new (4 Euskirchen,
   2 Amiens, 1 Altfeld)").
5. **Copy new loads** puts Load ID, PO, site, CRDD, PO window and pallets of
   the NEW rows on the clipboard (tab-separated) for the daily task sheet.
   **Copy table** / **Export CSV** export whatever is shown, SMC columns
   included.
6. Click a **site** name for that site's docks, equipment, contacts and SOP
   notes (Euskirchen, Amiens, Altfeld, Jijona, Cabanillas, Agnadello, London,
   Manchester). Only DE08 and FR57 are mapped to a site so far; the others
   need their Origin Location ID added to `config.js` `SITE_CODES`.

First-time setup: open **⚙ Settings** and enter the P&G **shipper ID(s)** as
they appear in SMC. The SMC check is scoped to those shippers and to the CRDD
range of the list (± the padding, default 2 days). **Test SMC session** tells
you whether you need to sign in to SMC first.

The check replaces the SOP's export-CSV → unified portal → SMC search → export
→ paste → conditional-formatting steps.

The button only shows in the frame that has the results table, so it will not
appear on the login page or other TMS screens. SMC is read through a content
script on an SMC tab (opened in the background if none is open), because a
cookie session can't be used from the extension itself.

## Why a DOM scrape (not an API)

TMS renders the Shipment Leg list as a **server-side HTML table** — there is no
JSON endpoint to call (unlike SMC). So the content script scrapes the rendered
table (`#ShipmentLegListSEARCH_RESULTSTableID`) using the page's own logged-in
session. No credentials are stored; nothing is sent anywhere.

## What it extracts (per load)

| Field | TMS column | SOP use |
|-------|-----------|---------|
| PO / BOL | Customer Purchase Order | BOL must equal the PO |
| Site | Origin Location ID | e.g. `DE08` → Euskirchen, `FR57` → Amiens |
| Status | Load Operational Status | must reach *Tender Accepted* before SMC |
| Load ID | Load ID | shipper reference |
| CRDD | Shipment Pickup From | must fall inside the PO delivery window |
| PO Delivery Window | Shipment Delivery From → To | chargeback boundary |
| Appointment (ISA) | Pick Stop Appointment From | booked slot |
| Pallets | Theoretical Pallets | load size |
| Origin City | Origin City | |

### Validation checks (hints only)
- Status is not yet *Tender Accepted*.
- Pickup is **after** the PO delivery window closes (by calendar day) — book
  inside the window, then push the order per RDD.
- Appointment pushed past the PO window (neutral note: normal practice per
  the SOP, only the original CRDD is measured).
- **In SMC / NEW** and the SMC alignment checks after *Check SMC*.

## Architecture (mirrors the LTL_Viewer extension)

```
pg_tms_extension/
├── manifest.json          MV3, Firefox, hosts *.jdadelivers.com + SMC
├── config.js              Config: columns, SITE_CODES/SITES (SOP), SMC query, settings defaults
├── background/
│   ├── background.js       message router, settings (storage.local), toolbar → overlay
│   ├── tmsClient.js        finds/opens the TMS tab, messages all frames
│   ├── smcClient.js        SMC bridge client + Load ID ↔ shipper-reference matching
│   ├── draft.js            builds the createV3 payload from a TMS row + lanes
│   ├── lanesStore.js       built-in lanes.js merged with user-added lanes (Settings)
│   ├── spClient.js         SharePoint bridge client (usage roster only)
│   ├── usage.js            Extension_Installs roster reporter (shared verbatim)
│   ├── control.js          remote kill switch / minVersion (shared verbatim)
│   ├── recorder.js         one-off SMC request capture (Settings)
│   ├── bridgeClient.js     generic find/open-tab + inject/reload bridge helper
│   └── debug.js            __pgDebug logger
├── content/
│   ├── tms.js              scrapes the table; answers tms:* messages (all frames)
│   ├── overlay.js          toggle button + panel (SMC check, site panel, settings)
│   ├── overlay.css         `pg-` prefixed styles
│   ├── smc.js              SMC bridge: same-origin /shipper/order/search + create
│   └── sp-bridge.js        SharePoint bridge (usage roster; shared verbatim)
├── lanes.js               built-in P&G contracted lanes
└── icons/
```

The TMS page is a **frameset** whose top document has no `<body>`, so both
content scripts run in every frame (`all_frames: true`). `overlay.js` mounts
only in the frame that contains the results table and reads it in place via
`window.__pgTms.extract()` — no background round-trip. The toolbar button goes
through the background (`tms:toggle` to every frame; only the list frame
answers).

## Install (temporary, for testing)

1. Firefox → `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `pg_tms_extension/manifest.json`
3. Log in to TMS and open the **List of Shipment Legs**.
4. Click **P&G Viewer** (bottom-right) or the toolbar icon.

A temporary add-on is removed when Firefox closes; reload it each session (or
package a signed `.xpi` later, like the other extensions).

## Adapting

- **New sites:** add the Origin Location ID → name in `config.js` `SITE_NAMES`
  (and mirror it in `content/tms.js` `SITE_NAMES`), map it in `SITE_CODES`,
  and give the `SITES` entry its `smcMatch` keywords and `smcPickup` name.
- **Columns:** the scraper maps columns by their **header label** (see
  `HEADERS` in `content/tms.js`), so reordering the list in TMS is fine.
  Adding a column the extension should read = add its label to `HEADERS`.
  Only if no header row is recognised does it fall back to the positional
  `COL` indexes (mirrored in `config.js` `COLUMNS`).

## Creating an SMC draft (NEW rows)

**Prepare SMC order** under a NEW row opens the draft panel. It resolves the
stops through SMC's own location search, shows pickup/delivery times (site
local, editable, defaults: pickup on the CRDD date 07:00–13:00, delivery on the
PO-window start at 12:00) and the shipper price (remembered per site), then
**Preview** builds the exact request the SMC create form sends
(`POST /shipper/order/createV3/`, captured from a manual draft) and lists
anything worth a look. **Create draft in SMC** posts it with `status: "DRAFT"`;
the panel links to the new draft, which you review and submit inside SMC. The
SMC check re-runs so the row flips from NEW to matched.

Only DRAFT payloads are ever sent. Address IDs: PICKUP → GENERAL → DELIVERY
for the pickup stop, DELIVERY → GENERAL → PICKUP for the drop; the chosen one
is shown in the preview.

What the panel resolves:

- shipper reference = Load ID, BOL = PO, PO as commodity reference;
- pickup stop = the site's SMC location name (`SITES[…].smcPickup`, only
  "Big Box" for Amiens is confirmed so far) and delivery stop = the Amazon node
  code found in *Destination Address* (`AMAZON XLY2 TROYES` → `XLY2`), both
  looked up via `/shipper/location/search/` to show the SMC address IDs;
- weight = *Shipment Weight* rounded to 1 dp, pallets = *Shipment Laden
  Length (M)* (Theoretical Pallets is shown for reference);
- defaults seen on real P&G orders: `DETACHED_TRAILER`, `TRUCKLOAD`,
  `EU_PALLET`, `LIVE_LOAD`.

"Copy payload" copies the JSON that would be (or was) sent.

The one-off **Record SMC requests** switch in Settings (webRequest) is how the
create call was captured; it stays available for the next unknown endpoint.

## Remote control & auto-update

Like the other four extensions, this one is signed and published by
`.github/workflows/sign-and-publish.yml` on every push to `main` that touches
`pg_tms_extension/`. Installed copies auto-update from the manifest's
`update_url` (slug `pg-tms-viewer` on the `updates` branch). Bump
`manifest.json` `version` before pushing or the job fails on a reused version.

`background/control.js` (identical to the other extensions) reads
`pg-tms-viewer/control.json` from the `updates` branch every 15 min and before
each run: global `enabled`, `minVersion`, `notice`, and per-alias / per-install
overrides. Identity is the SMC `requester` alias plus a random install id, both
shown in Settings. When disabled, the overlay shows the message and won't read
the list; a `notice` shows as a banner while enabled. Admin edits:
`.github/scripts/control.ps1 pg-tms-viewer disable-user <alias> "<message>"`
(or the admin page). The seed lives at `.github/control/pg-tms-viewer.json`.

Usage reporting: `background/usage.js` (shared with the other extensions)
upserts one row per install into the SharePoint `Extension_Installs` list, so
the install shows up in the admin roster with its alias, version, and run count
(a run = creating an SMC draft). SharePoint REST needs the user's session, so
it goes through `content/sp-bridge.js` on a SharePoint tab (opened in the
background if none is open), same as SMC. Reports on startup, hourly, and after
a draft; failures are swallowed so the roster never blocks the real work.

## Roadmap

- [x] SMC check: which forecast loads already have an order (Load ID match).
- [x] Site-rule panel (docks, equipment, contacts, SOP notes).
- [x] SMC alignment: BOL = PO, PO, origin site, ISA present, SMC details column.
- [ ] Confirm the Origin Location IDs of the remaining five sites (DE08, DE87, FR57 known).
- [x] Order-detail fallback for the BOL when the search payload omits it
      (endpoint auto-detected from a short candidate list; see `content/smc.js`).
- [ ] Confirm which detail endpoint answers on the live SMC (`__pgSmc.fetchDetail("<orderid>")` in the SMC tab console).
- [x] Create the SMC DRAFT from a NEW row (createV3; payload byte-matched against a manual draft).
- [x] Contracted lanes (`lanes.js`): default the draft price/equipment, flag off-contract loads, and map each site to its SMC pickup code.
- [ ] SMC pickup codes for Cabanillas variants and Manchester (Grays is shared with London); confirm from live orders.
- [ ] Driver-detail email templating per site.
