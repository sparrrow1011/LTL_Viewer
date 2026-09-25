# MS Viewer extension — how to work on it

The live product is the Firefox MV3 extension in `extension/`. The Flask app
(`app/`, `scrapers/`, `scripts/`) is the superseded predecessor; don't touch it
for extension work.

## Verify before claiming done

```powershell
# 1. syntax, every file
Get-ChildItem -Recurse extension -Filter *.js | % { node --check $_.FullName }
# 2. lint (0 errors required; 3 known warnings: 2× manifest min-version, 1× innerHTML in overlay.js)
#    --self-hosted is REQUIRED: the manifest carries update_url (self-distributed add-on)
npx --yes web-ext lint --self-hosted --source-dir=extension --ignore-files "web-ext-artifacts/**" "README.md" ".amo-upload-uuid"
```

## Remote control

`background/control.js` (identical copy in both extensions — keep in sync)
reads `<slug>/control.json` from the `updates` branch every 15 min and before
each load/run: global `enabled`, `minVersion`, `notice`, per-alias `users{}`
and per-`installs{}` overrides. Identity = SMC `requester` alias + a random
install id (both shown in the UI). Admin edits: `.github/scripts/control.ps1
<slug> disable-user <alias> "<message>"` etc. The seed files live in
`.github/control/`; the workflow copies them only when none exists yet.

## Releasing (automatic)

Pushing to `main` with changes under `extension/` or `sweeper_extension/` runs
`.github/workflows/sign-and-publish.yml`: lint → AMO sign → publish the `.xpi`
and `updates.json` to the `updates` branch. Installed copies auto-update from
`browser_specific_settings.gecko.update_url` (raw.githubusercontent.com).
Bump `manifest.json` version first or the job fails. AMO creds are repo
secrets `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`. Manual `web-ext sign` still
works for a one-off local build.

There is no automated test suite; SMC / SharePoint / FMC can't be exercised
locally. Say so explicitly instead of implying live verification.

## Build a signed .xpi

1. Bump `extension/manifest.json` `version` — AMO rejects a reused version
   even if the earlier upload was interrupted.
2. `npx --yes web-ext sign --source-dir=extension --artifacts-dir=extension/web-ext-artifacts --channel=unlisted --ignore-files "web-ext-artifacts/**" "README.md" ".amo-upload-uuid"`
   Credentials come from `$env:WEB_EXT_API_KEY` / `$env:WEB_EXT_API_SECRET`
   (already set in the shell); do not pass them on the command line.
3. Output: `extension/web-ext-artifacts/93b1652f59e842029ce6-<version>.xpi`.
   Confirm name/version by reading `manifest.json` inside the zip.
4. Keep add-on id `ltl-viewer-overlay@internal` and the internal `ltl-` CSS
   ids / log prefixes: changing them breaks in-place upgrades.

## Architecture in one breath

- `config.js` `Config.TEAMS[LTL|CST]` owns everything team-specific (lists,
  SMC query, sourcing gate, EML, retention). New team = new entry, not code.
- Content scripts can't import `config.js`; the overlay fetches it via the
  `getTeams` message. Every message carries `team`.
- UI is a standalone page `ui/app.html` (toolbar button opens it). It talks
  only to the background; SMC/SharePoint/FMC are reached via content-script
  bridges on tabs of those origins (`background/bridgeClient.js`).
- SMC = read source of the load list (`content/smc.js`, same-origin fetch on
  an SMC tab, answering `smc:*` messages via `background/smcClient.js`).
  "Needs sourcing" is decided AFTER FMC validation by `vehicle_carrier` being
  empty or a placeholder (`sourcing.placeholderCarriers`).
- SharePoint = write store, via `content/sp-bridge.js` on a SharePoint tab
  (background fetch has no session). One item per `orderid|vrid`, JSON in
  `Payload`, key fields promoted. Lists auto-provision.
- FMC = per-VRID enrichment + outcome sweep via `content/fmc-bridge.js`.
- After a save refresh ONLY SharePoint records (`refreshRecords`), never
  re-fetch SMC.
- CST shippers come from `source_of_truth_crawler.csv` on SharePoint
  (`shipperSource`), fallback `CST_Shippers` list + manual import.

## Conventions

- No dependencies, no bundler, plain ES2020; charts are inline SVG.
- Dashboard tabs: Overview / Runs / Emails / Users / Live board; shared
  control bar; state kept in module-level `_range`, `_flags`, `_tab`.
- Update `extension/README.md` when behaviour changes (it's the user-facing doc).
