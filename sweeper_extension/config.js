/**
 * Lobby Sweeper — configuration.
 *
 * Port of CST_viewer's scrapers/paragon.py + scrapers/lobby_monitor.py +
 * app/tasks/paragon_scheduler.py into a standalone Firefox extension.
 *
 * AUTH MODEL: cookie-based. The user is already signed in to Paragon and SMC
 * (Midway) in Firefox. Content-script "bridges" run ON those origins and fetch
 * same-origin with the page's own session — no Playwright, no stored creds.
 *
 * Both the background (ES module) and the UI page import this file. Content
 * scripts can't import modules, so they receive what they need via messages.
 */

export const Config = {
  // ── Debug ─────────────────────────────────────────────────────────────────
  // Verbose logging. Off: the Log tab shows only the numbered pipeline steps
  // (scope "pipeline") plus warnings/errors. On: every bridge call and HTTP
  // round-trip too (toggle in Settings).
  DEBUG: false,

  // ── Paragon ───────────────────────────────────────────────────────────────
  PARAGON_ORIGIN: "https://paragon-eu.amazon.com",
  // Search API the old Paragon UI export used (paragon.py API_SEARCH_URL).
  PARAGON_SEARCH_URL: "https://paragon-eu.amazon.com/hz/api/search",
  // Page that seeds an authenticated session + the pgn_csrf_token cookie.
  PARAGON_TAB_URL: "https://paragon-eu.amazon.com/hz/dox-search",
  PARAGON_TAB_MATCH: "https://paragon-eu.amazon.com/*",
  // The CSRF cookie name paragon.py reads from the Playwright context.
  PARAGON_CSRF_COOKIE: "pgn_csrf_token",
  // Deep link to a case (same URL lobby_monitor.py puts in Slack messages).
  caseUrl(caseId) {
    return `${this.PARAGON_ORIGIN}/hz/search?searchQuery=${encodeURIComponent(
      caseId
    )}&sortField=creationDate&sortOrder=desc`;
  },
  // IDs (order IDs + VRIDs, quoted) per Paragon search request. paragon.py
  // found the API rejects (HTTP 400) around 90-100 terms; 35 agreed 2026-09-21.
  // Failing batches are split in half and retried.
  PARAGON_BATCH_SIZE: 35,
  PARAGON_CASE_PAGE_SIZE: 100,

  // ── SMC (source of the orderid/vrid pairs — replaces cst_runs) ────────────
  SMC_ORIGIN: "https://smc-eu-dub.dub.proxy.amazon.com",
  SMC_SEARCH_URL: "https://smc-eu-dub.dub.proxy.amazon.com/shipper/order/search",
  SMC_TAB_URL: "https://smc-eu-dub.dub.proxy.amazon.com/shipper/order",
  SMC_TAB_MATCH: "https://smc-eu-dub.dub.proxy.amazon.com/*",

  // SMC page size. CST_viewer scrapers/smc.py uses 200 (the UI's 25 makes a
  // 3,000-order pull take 100+ requests).
  SMC_PAGE_SIZE: 200,

  // ── Shipper source of truth (restricts the SMC pull to CST shippers) ──────
  // CST_viewer scripts/update_shippers.py exports the "Shippers" sheet of
  // "Source Of Truth 2026.xlsx" to source_of_truth_crawler.csv in the
  // SharePoint-synced CST library. Read same-origin via content/sp-bridge.js.
  SP_ORIGIN: "https://amazongbr.sharepoint.com",
  SP_TAB_URL: "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations",
  // Only tabs ON the site (a tenant-root AccessDenied page must not qualify).
  SP_TAB_MATCH: "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations/*",

  // ── Site access ───────────────────────────────────────────────────────────
  // Firefox grants MV3 host_permissions automatically only for temporary
  // add-ons. An installed .xpi starts with them OFF; the page requests them
  // via browser.permissions.request() (needs a user click).
  HOST_ORIGINS: [
    "https://paragon-eu.amazon.com/*",
    "https://smc-eu-dub.dub.proxy.amazon.com/*",
    "https://trans-logistics-eu.amazon.com/*",
    "https://amazongbr.sharepoint.com/*",
    "https://hooks.slack.com/*",
  ],
  SHIPPER_SOURCE: {
    file: "source_of_truth_crawler.csv",
    // The OneDrive-synced library "Amazon Freight Operations - CST" is the
    // site's default library, URL segment "Shared Documents" (confirmed from
    // the OneDrive sync DB, 2026-09-21).
    paths: [
      "/sites/AmazonFreightOperations/Shared Documents/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
      "/sites/AmazonFreightOperations/CST/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
    ],
    ttlMinutes: 30,
  },

  // ── FMC (VRID confirmation via /fmc/search/execution/by-id) ───────────────
  FMC_ORIGIN: "https://trans-logistics-eu.amazon.com",
  FMC_TAB_URL: "https://trans-logistics-eu.amazon.com/fmc/execution",
  FMC_TAB_MATCH: "https://trans-logistics-eu.amazon.com/fmc/*",

  // ── Sweep window ──────────────────────────────────────────────────────────
  // Orders whose ORIGIN date falls in [today - daysBack, today + daysForward]
  // (whole UTC days). Agreed 2026-09-21: 5 days back, 1 day forward.
  SWEEP_WINDOW: { daysBack: 5, daysForward: 1 },

  // ── Lobby (SLA monitor) ───────────────────────────────────────────────────
  // Open statuses from lobby_monitor.py LOBBY_QUERY.
  LOBBY_STATUSES: [
    "Assigned",
    "Carrier Action Completed",
    "FC Action Completed",
    "Merchant Action Completed",
    "No Action Possible",
    "Pending Amazon Action",
    "Pending Deployment",
    "Pending FC Action",
    "Pending Merchant Action",
    "Reopened",
    "Unassigned",
    "Work-in-Progress",
  ],

  // SLA thresholds (lobby_monitor.py detect_case_signals).
  SLA: {
    // "Needs Response": last inbound is newer than last outbound by >= N minutes,
    // keyed by severity. Severity 2 had NO threshold in the Python original
    // (those cases were silently skipped); 90 min was agreed 2026-09-21.
    needsResponseMinutesBySeverity: { 1: 60, 2: 90, 3: 120, 4: 300, 5: 1200 },
    // "Needs Response" when there is an inbound but no outbound at all.
    noOutboundMinutes: 30,
    // "PAA Overdue": Pending Amazon Action older than N hours since creation.
    paaOverdueHours: 24,
    // "WIP Stagnant" was commented out in the original; kept off by default.
    wipStagnantHours: null,
  },

  // ── Slack ─────────────────────────────────────────────────────────────────
  // No webhook ships in source (the repo is on GitHub; a webhook URL lets
  // anyone holding it post to the channel — GitHub secret scanning blocks it).
  // Each install pastes the #cst-sla-notifier webhook into Settings once; it
  // lives only in that Firefox profile's extension storage.
  SLACK_WEBHOOK_DEFAULT: "",

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // paragon_scheduler.py ran every 30 minutes.
  SCHEDULE_MINUTES: 30,
  // Don't re-notify the same (case, alert type) within this window. The
  // Python monitor was stateless and re-posted every alert every cycle.
  ALERT_DEDUPE_MINUTES: 240,

  // ── Teams ─────────────────────────────────────────────────────────────────
  //  validQueues  a case found via an orderid/vrid sweep is "good" if its queue
  //               is one of these (paragon.py VALID_QUEUES); otherwise "check".
  //  lobbyQueues  queues the SLA monitor watches (lobby_monitor.py LOBBY_QUERY).
  //  smcQuery     /shipper/order/search andCriteria used to pull the team's runs.
  DEFAULT_TEAM: "CST",
  TEAMS: {
    CST: {
      key: "CST",
      label: "CST",
      description: "Customer shipper team — Paragon lobby (queues from CST_viewer).",
      // paragon.py VALID_QUEUES
      validQueues: [
        "customer-success-af@amazon.com",
        "cst-order-scheduling@amazon.com",
        "af-redirection-ftl@amazon.com",
        "freight-roc-pods-uk@amazon.com",
        "amazonfreight-eu-pods@amazon.com",
        "eu-rsp-performance@amazon.com",
        "roc-tio-missing-trailers@amazon.com",
      ],
      // lobby_monitor.py LOBBY_QUERY
      lobbyQueues: ["cst-order-scheduling@amazon.com", "customer-success-af@amazon.com"],
      // Sweep noise: cases whose Subject CONTAINS one of these (case-insensitive)
      // are dropped before the queue check. Editable per install in Settings.
      excludeSubjects: ["[IM RAIL 1P][EDI] Terminal check in confirmation"],
      // Mirrors CST_viewer scrapers/smc.py (the query that fills cst_runs).
      // NOTE: smc.py also restricts to the CST shipper list (shipperIds from the
      // Source Of Truth sheet); this extension does not yet, so the sweep
      // covers every shipper's orders in the window.
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
        shipperBusinessChannels: [],
        readyForScheduling: null,
      },
    },
  },
};
