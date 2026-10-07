/**
 * Extension configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTH MODEL: Cookie-based. The user is already signed in to SharePoint in the
 * browser (via Midway), so the extension calls the SharePoint REST API with the
 * existing session cookies (fetch credentials:"include") — same trick the SMC
 * scraper uses. No Azure app registration, no OAuth, no login page.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const Config = {
  // ── Debug ─────────────────────────────────────────────────────────────────
  // When true, the logger (background/debug.js) prints detailed request/response
  // traces. Off by default; enable at runtime in the background console:
  // __ltlDebug.enable() / .disable().
  DEBUG: false,

  // ── Remote control ────────────────────────────────────────────────────────
  // control.json on the repo's `updates` branch: global/per-user enable flag,
  // minimum version, message. See background/control.js (shared with the
  // Lobby Sweeper). Re-read every CONTROL_REFRESH_MINUTES and before each load.
  CONTROL_URL: "https://raw.githubusercontent.com/sparrrow1011/LTL_Viewer/updates/ms-viewer/control.json",
  CONTROL_REFRESH_MINUTES: 15,

  // ── SharePoint target (cookie-authenticated REST) ─────────────────────────
  // Origin of the SharePoint tenant.
  SP_ORIGIN: "https://amazongbr.sharepoint.com",
  // Server-relative site path.
  SP_SITE_PATH: "/sites/AmazonFreightOperations",
  // Convenience: full REST base -> `${SP_ORIGIN}${SP_SITE_PATH}/_api`.
  get SP_API_BASE() {
    return `${this.SP_ORIGIN}${this.SP_SITE_PATH}/_api`;
  },

  // ── Teams ─────────────────────────────────────────────────────────────────
  // The overlay opens on a team picker; everything team-specific hangs off this
  // map (the content side fetches it via the `getTeams` message since content
  // scripts can't import ES modules). Adding a team = adding an entry here.
  //
  //  spList           SharePoint list holding that team's (orderid, vrid)
  //                   manual-sourcing/email records. Auto-created on first write.
  //  shipperList      Optional SharePoint list that is the team's shipper
  //                   source of truth (Title=shipperid, shippername,
  //                   shipper_group). When set, the SMC query is restricted to
  //                   those shipper IDs and rows get a `shipper_group` column.
  //  smcQuery         andCriteria overrides for /shipper/order/search.
  //  sourcing         post-fetch predicate knobs: requireVrid, requireNoCarrier,
  //                   excludeFreightTypes.
  //  carrierDefaults  carriers pre-selected in the toolbar (FMC placeholder
  //                   carriers meaning "not yet sourced"). Also what the outcome
  //                   sweep treats as "not covered yet".
  //  outcomeSweepDays how far back (by latest activity) the sweep re-checks
  //                   open tracked records against FMC.
  //  retentionDays    seen-only records (auto-tracked, never worked) are deleted
  //                   this long after they were last seen. Worked records are
  //                   kept forever.
  //  statusDefault    vehicle_execution_status pre-selected in the toolbar.
  //  eml              To/Cc/subject tag for the bulk EML.
  DEFAULT_TEAM: "LTL",
  TEAMS: {
    LTL: {
      key: "LTL",
      label: "LTL",
      description: "Less-than-truckload manual sourcing (DE/GB).",
      spList: "LTL_Records",
      // No shipper source of truth for LTL: scope is defined by freight type +
      // business channel, not a shipper allow-list (unlike CST).
      shipperList: null,
      // ── FMC is the SOURCE of the LTL load list ──────────────────────────
      // Middle-mile runs (Amazon-internal shipper accounts) never pass through
      // SMC, so the list comes from an FMC criteria search: these shipper
      // accounts × the placeholder carriers, within the planned-dock window.
      // Every run FMC returns is "needs sourcing" by construction (it's on a
      // placeholder carrier). SMC is then used only to ENRICH: runs whose VRID
      // exists in SMC are first mile (FM); the rest are middle mile (MM).
      fmcSearch: {
        shipperAccounts: ["ATSLTLAFInbound", "ATSLTLInboundVendor", "SwaFbaSPTransfer"],
        carriers: ["NCSL", "AZNG", "DUMMY", "RLB1"],
        tenderStatuses: ["PLANNED", "APPROVED"],
      },
      // SMC enrichment lookup (NOT the source). All freight types so any
      // first-mile order — LTL or TL — is recognised; DE/GB channel kept.
      smcQuery: {
        orderSources: ["SMC", "EDI", "R4S", "AFAPI", "AFDIG"],
        freightTypes: ["LESS_THAN_TRUCKLOAD", "TRUCKLOAD", "INTERMODAL"],
        orderExecutionStatuses: [
          "IN_DRAFT", "NOT_PLANNED", "PENDING_CARRIER_ACCEPTANCE",
          "CARRIER_TENDER_ACCEPTED", "DRIVER_DISPATCHED", "LATE_TO_ARRIVE",
          "ARRIVED", "LATE_TO_DEPART", "DEPARTED",
          "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED",
          "PENDING_PAYMENT", "PAID", "CANCELLED", "REJECTED",
        ],
        shipperBusinessChannels: ["DE", "GB"],
        // Same as CST: don't restrict to the "ready for scheduling" bucket —
        // VRID-assigned orders graduate out of it and would be missed.
        readyForScheduling: null,
      },
      // With FMC as the source the SMC gate is irrelevant (SMC only enriches),
      // but the placeholder list still drives the carrier gate + toolbar chips.
      // NCSL added: it's a placeholder carrier on LTL middle-mile runs.
      sourcing: {
        requireVrid: true,
        requireNoCarrier: false,
        excludeFreightTypes: [],
        placeholderCarriers: ["NCSL", "AZNG", "DUMMY", "RLB1"],
      },
      // No carrier chips pre-selected: the FMC search already restricts to the
      // placeholder carriers, so a default chip filter would only hide rows.
      carrierDefaults: [],
      outcomeSweepDays: 30,
      retentionDays: 180,
      statusDefault: "PLANNED",
      eml: {
        to: "amazonfreight-eu-sourcing@amazon.com",
        cc: "amazonfreight-eu-sourcing@amazon.com",
        // Kept as the historical literal so LTL emails are unchanged.
        subjectTag: "[CST][Available Loads]",
      },
    },
    CST: {
      key: "CST",
      label: "CST",
      description: "Customer shipper team — TL/Intermodal for the CST shipper list.",
      spList: "CST_Records",
      // PREFERRED shipper source: the hand-maintained workbook itself, read
      // from SharePoint and parsed in-browser (background/xlsx.js).
      //
      // This is the same file CST_viewer's scripts/update_shippers.py reads, so
      // going direct drops the dependency on someone running that script to
      // publish the CSV — until now a missed run meant the extension quietly
      // served a stale shipper list. Columns are POSITIONAL, matching
      // update_shippers.py's usecols="B, C, L" + rename-by-position, so a
      // reordered sheet breaks both the same way rather than diverging.
      //
      // Verified against the live workbook: 127 shippers, an identical id set
      // to the published CSV (CST 77 / Mega Shipper 10 / ELEX 40).
      shipperWorkbook: {
        paths: [
          // From the share link; the second covers the capitalised variant.
          "/sites/AmazonFreightOperations/Shared Documents/CST/CST Operations/Source of Truth 2026.xlsx",
          "/sites/AmazonFreightOperations/Shared Documents/CST/CST Operations/Source Of Truth 2026.xlsx",
        ],
        // If the exact paths miss, list these folders and match on name. Far
        // more robust in a hand-managed library, where capitalisation, double
        // spaces and "(1)" copies all break an exact path — and when nothing
        // matches, the log/dialog reports what IS in the folder.
        folders: [
          "/sites/AmazonFreightOperations/Shared Documents/CST/CST Operations",
          "/sites/AmazonFreightOperations/Shared Documents/CST",
        ],
        match: "source\\s*of\\s*truth.*\\.xlsx$",
        file: "Source of Truth 2026.xlsx", // Search fallback if it's moved
        sheet: "Shippers",
        columns: { shipperid: "B", shippername: "C", shipper_group: "L" },
        ttlMinutes: 30,
      },

      // FALLBACK: the CSV that update_shippers.py publishes.
      // CST_viewer's scripts/update_shippers.py exports the "Shippers" sheet of
      // "Source Of Truth 2026.xlsx" to source_of_truth_crawler.csv inside the
      // SharePoint-synced library "Amazon Freight Operations - CST"
      // (OneDrive name = "<site> - <library>").
      // We read that CSV straight from SharePoint via the bridge:
      //   1. each `paths` entry (server-relative), in order
      //   2. the last path that worked (cached in browser.storage)
      //   3. SharePoint Search by `file` name (path then cached)
      // If none works, we fall back to the `shipperList` SharePoint list, which
      // can be filled by the toolbar's CSV import.
      shipperSource: {
        file: "source_of_truth_crawler.csv",
        paths: [
          // Confirmed live path (the library root is "Shared Documents" and the
          // folder chain starts with CST/). The two below are the historical
          // guesses, kept as fallbacks.
          "/sites/AmazonFreightOperations/Shared Documents/CST/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
          "/sites/AmazonFreightOperations/CST/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
          "/sites/AmazonFreightOperations/Shared Documents/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
        ],
        // Re-read at most this often (shippers change rarely).
        ttlMinutes: 30,
      },
      shipperList: "CST_Shippers",
      smcQuery: {
        orderSources: ["SMC", "R4S", "EDI", "AFAPI"],
        freightTypes: ["LESS_THAN_TRUCKLOAD", "TRUCKLOAD", "INTERMODAL"],
        orderExecutionStatuses: [
          "IN_DRAFT", "NOT_PLANNED", "PENDING_CARRIER_ACCEPTANCE",
          "CARRIER_TENDER_ACCEPTED", "DRIVER_DISPATCHED", "LATE_TO_ARRIVE",
          "ARRIVED", "LATE_TO_DEPART", "DEPARTED",
          "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED",
          "PENDING_PAYMENT", "PAID", "CANCELLED", "REJECTED",
        ],
        // Empty = all countries.
        shipperBusinessChannels: [],
        // Don't restrict to the "ready for scheduling" bucket: VRID-assigned
        // orders graduate out of it and would be missed (cst_runs lesson).
        readyForScheduling: null,
      },
      // CST = CST shippers minus LTL (LTL team owns those).
      // As for LTL: don't gate on SMC's carrier — SMC reports the placeholder
      // (e.g. DUMMY) as carrierDetails, which made requireNoCarrier drop runs
      // that still need sourcing. "Needs sourcing" is decided after FMC
      // validation: carrier empty or a placeholder below.
      sourcing: {
        requireVrid: true,
        requireNoCarrier: false,
        excludeFreightTypes: ["LESS_THAN_TRUCKLOAD"],
        placeholderCarriers: ["RLB1", "AZNG", "DUMMY"],
        placeholderCarrierPrefixes: [],
      },
      carrierDefaults: ["RLB1", "AZNG", "DUMMY"],
      outcomeSweepDays: 30,
      retentionDays: 180,
      statusDefault: "PLANNED",
      // Programme shipper accounts whose rows all carry the same placeholder
      // name. For these, resolve the real vendor from the order's VENDOR_CODE
      // via the Procurement Portal and show that instead, tagged `tag`.
      // Orders with no VENDOR_CODE were created in SMC itself — nothing to
      // resolve, so they keep the placeholder.
      vendorLookup: {
        shipperIds: ["6771301528"], // WePay_Program
        tag: "WP",
        tagTitle: "WePay — name resolved from the order's vendor code",
      },
      eml: {
        to: "amazonfreight-eu-sourcing@amazon.com",
        cc: "amazonfreight-eu-sourcing@amazon.com",
        subjectTag: "[CST][Available Loads]",
      },
    },
  },

  // ── Procurement Portal (vendor code → vendor name) ────────────────────────
  // Some shipper accounts are programmes rather than real shippers, so every
  // run shows the same placeholder name (e.g. "WePay_Program") and the actual
  // vendor is invisible. SMC carries a VENDOR_CODE on the order; the Portal
  // translates that code into the vendor's name.
  //
  // Read-only, through a bridge on the Portal's own origin (its API needs that
  // site's SSO session, same as SMC/FMC/SharePoint).
  VENDOR_ORIGIN: "https://procurementportal-eu.corp.amazon.com",
  VENDOR_API: "https://procurementportal-eu.corp.amazon.com/bp-api/vendor",
  VENDOR_TAB_URL: "https://procurementportal-eu.corp.amazon.com/",
  VENDOR_TAB_MATCH: "https://procurementportal-eu.corp.amazon.com/*",
  // Vendor names effectively never change, so cache hard: one lookup per code
  // per month rather than per order.
  VENDOR_CACHE_DAYS: 30,

  // ── SMC (read source of the load list, via the SMC bridge) ────────────────
  // The UI is a standalone page; content/smc.js runs on an SMC tab and does
  // the same-origin fetch. A tab is opened in the background if none exists.
  SMC_ORIGIN: "https://smc-eu-dub.dub.proxy.amazon.com",
  SMC_TAB_URL: "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1",
  SMC_TAB_MATCH: "https://smc-eu-dub.dub.proxy.amazon.com/*",

  // ── FMC (execution status enrichment, read-only via the FMC bridge) ───────
  FMC_ORIGIN: "https://trans-logistics-eu.amazon.com",
  // A page that actually loads the FMC app (the bare /fmc/execution/search 404s).
  // /fmc/execution/search/<VRID> is the UI's own seed URL and renders the app.
  FMC_TAB_URL: "https://trans-logistics-eu.amazon.com/fmc/execution",
  FMC_TAB_MATCH: "https://trans-logistics-eu.amazon.com/fmc/*",
};
