# Extension Control (Firefox WebExtension)

The admin console for the team's add-ons (Lobby Sweeper, MS Viewer, HC
Calculator, All Runs, P&G TMS Viewer). It does everything the GitHub Pages admin page and
`.github/scripts/control.ps1` do, from a toolbar button instead of a web page
or a shell — and it shows the **live** install roster from SharePoint, so the
"Publish roster" step in Lobby Sweeper is no longer needed.

Add-on id `ext-control@internal`, slug `ext-control`. It is an admin tool: it
has no `control.js` / `usage.js` of its own and is not remotely controlled.

## What it controls

Per add-on, exactly the fields the add-ons' `background/control.js` evaluates:

| Control | Effect on installs |
| ------- | ------------------ |
| Enabled for everyone | global kill switch (`enabled`) with the `message` users see |
| Notice | text shown while the add-on is enabled (toast / banner) |
| Minimum version | installs below it refuse to run until updated |
| Admins | aliases who see the Installs tab in Lobby Sweeper |
| Per-user overrides | `users{alias:{enabled,message}}` — disable one person, or allow one person while everyone else is off |
| Per-install overrides | same, keyed by install id (for a machine with no SMC alias) |
| Raw JSON | edit the whole document when you need something the form doesn't expose |

## Layout of the page

A dashboard with a sidebar; the content area shows one view at a time
(`#overview`, `#ext/<slug>`, `#installs`, `#settings` in the URL hash):

- **Overview** — KPIs across all add-ons (installs, known aliases, active in
  the last 24 h, blocked by the saved config) and one tile per add-on with its
  saved state, install count, active count, latest published version, how many
  installs are below it, and the current minimum version. Click a tile to open
  the add-on.
- **Extensions** (one sidebar entry each, with a status dot and the install
  count; an orange "draft" badge while there are unsaved edits) — the add-on's
  KPIs, the Availability form, the per-user / per-install overrides, a sticky
  Save bar, the installs of that add-on, and the raw JSON.
- **Installs** — every row from the `Extension_Installs` SharePoint list:
  alias, add-on, version, last seen / last run, runs, install id, with a
  **State** column that previews what that install will see with the current
  draft (rows whose state would change are highlighted). Disable / Re-enable
  edit the matching add-on's draft and jump to it; **Remove row** deletes a
  stale roster entry (the add-on re-creates it on its next report).
- **Settings** — the GitHub token and a short explanation of the mechanism.

The sidebar footer shows who the token belongs to, Reload all, and (when
Firefox has not granted site access yet) Grant site access.

## How a change is applied

1. Edit a card. The card shows an "Unsaved: …" bar with a summary; nothing has
   changed yet.
2. Click **Save to GitHub**. The background re-reads the file's sha and PUTs
   `<slug>/control.json` to the `updates` branch through the GitHub contents
   API, with the summary as the commit message. A concurrent edit shows up as a
   conflict ("changed on GitHub since you loaded it") instead of being
   overwritten.
3. Installs re-read the file within 15 minutes, or on their next Run /
   Re-check.

Guards: disabling everyone asks for confirmation; a minimum version above the
latest published build is refused (it would lock everyone out).

## Setup

- Install the signed `.xpi` (published to the `updates` branch by CI like the
  other add-ons; it auto-updates).
- Firefox grants an installed add-on site access only when asked: if the
  roster or a save fails with a permission error, click **Grant site access**
  in the sidebar.
- Open **Settings** and paste a fine-grained GitHub personal access token for
  `sparrrow1011/LTL_Viewer` with **Contents: Read and write**. It is kept in
  the add-on's private storage (`browser.storage.local`), not in a page's
  localStorage. Reading works without a token; saving needs one.
- The roster needs a signed-in SharePoint session (the add-on opens the site in
  a background tab when none is open).

## Layout

```
manifest.json                 MV3, id ext-control@internal
config.js                     repo / branch / controlled add-ons / SharePoint site
background/background.js      message router (page ↔ GitHub ↔ SharePoint bridge)
background/github.js          token store, whoami, read/write files on the updates branch
background/controlFiles.js    load / save control.json with the lock-out guard
background/roster.js          Extension_Installs reader (+ row delete)
background/spClient.js        SharePoint REST via the bridge (same pattern as runs/)
background/bridgeClient.js    find/open a SharePoint tab, inject, retry (shared helper)
content/sp-bridge.js          same-origin fetch on the SharePoint tab
shared/controlDoc.js          normalise / serialise / evaluate / summarise a control doc
ui/control.html|css|js        the dashboard page (sidebar + views)
```

Messages: `getConfig`, `checkSessions`, `gh:whoami`, `gh:setToken`,
`gh:hasToken`, `ctl:loadAll`, `ctl:load`, `ctl:save {slug, doc, summary}`,
`roster:list`, `roster:remove {id}`, `setDebug`. Replies are
`{ ok, data }` or `{ ok:false, error, status, expired, permission }`.

## Still true

- The **channel is unchanged**: the controlled add-ons keep polling
  `raw.githubusercontent.com/…/updates/<slug>/control.json`. This add-on is a
  different editor for the same files, so the admin page and `control.ps1`
  still work and stay compatible (same key order in the JSON).
- Adding a controlled add-on: one entry in `config.js` `EXTS` (its slug must
  match the release matrix in `.github/workflows/sign-and-publish.yml`).
- No dependencies, no bundler, plain ES2020.
