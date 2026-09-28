/**
 * All Runs — configuration.
 *
 * A standalone Firefox extension (its own add-on id, its own release feed),
 * separate from MS Viewer, the Lobby Sweeper and the HC Calculator. It shares
 * their plumbing: cookie-authenticated access to SMC / FMC / SharePoint through
 * a content-script bridge on a tab of each origin, because the background's own
 * fetch does not carry the Midway session.
 *
 * Read-only: the only SharePoint write is the shared usage roster.
 */

export const Config = {
  // ── Debug ─────────────────────────────────────────────────────────────────
  // Verbose [RUNS …] traces. Off by default; toggle at runtime in the
  // background console: __runsDebug.enable() / .disable().
  DEBUG: false,

  // ── Remote control ────────────────────────────────────────────────────────
  // control.json on the repo's `updates` branch. background/control.js is
  // shared verbatim with the other extensions — keep it in sync.
  CONTROL_URL:
    "https://raw.githubusercontent.com/sparrrow1011/LTL_Viewer/updates/all-runs/control.json",
  CONTROL_REFRESH_MINUTES: 15,

  // Origins the bridges need. An installed .xpi starts with site access OFF;
  // the page offers a one-click permissions.request for these.
  HOST_ORIGINS: [
    "https://smc-eu-dub.dub.proxy.amazon.com/*",
    "https://amazongbr.sharepoint.com/*",
    "https://trans-logistics-eu.amazon.com/*",
  ],

  // ── SharePoint (shipper CSV + usage roster, via the bridge) ───────────────
  SP_ORIGIN: "https://amazongbr.sharepoint.com",
  SP_SITE_PATH: "/sites/AmazonFreightOperations",
  get SP_API_BASE() {
    return `${this.SP_ORIGIN}${this.SP_SITE_PATH}/_api`;
  },

  // ── SMC (the run list) ────────────────────────────────────────────────────
  SMC_ORIGIN: "https://smc-eu-dub.dub.proxy.amazon.com",
  SMC_TAB_URL: "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1",
  SMC_TAB_MATCH: "https://smc-eu-dub.dub.proxy.amazon.com/*",

  // ── FMC (per-VRID status, planned times, stops) ───────────────────────────
  FMC_ORIGIN: "https://trans-logistics-eu.amazon.com",
  FMC_TAB_URL: "https://trans-logistics-eu.amazon.com/fmc/execution",
  FMC_TAB_MATCH: "https://trans-logistics-eu.amazon.com/fmc/*",

  // ── Teams ─────────────────────────────────────────────────────────────────
  // One team ("ALL"): the SMC query is NOT restricted to any shipper list —
  // every run comes back, and the CST source of truth only TAGS each run.
  DEFAULT_TEAM: "ALL",
  TEAMS: {
    ALL: {
      key: "ALL",
      label: "All runs",
      description: "Every run in SMC, tagged CST / ELEX / FTL.",

      // CST shipper source of truth: tags runs, does not scope the query.
      // shipper_group "CST - ELEX" marks the ELEX subset; any other row is CST;
      // a shipper not in the file is "FTL".
      shipperSource: {
        file: "source_of_truth_crawler.csv",
        paths: [
          "/sites/AmazonFreightOperations/Shared Documents/CST/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
          "/sites/AmazonFreightOperations/CST/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
          "/sites/AmazonFreightOperations/Shared Documents/CST L4+/PROCESS IMPROVEMENT/source_of_truth_crawler.csv",
        ],
        ttlMinutes: 30,
      },
      elexGroup: "CST - ELEX",

      // The "everything" SMC query (same as the HC Calculator): all freight
      // types, every execution status, no country restriction and NO
      // readyForScheduling filter.
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
      // Orders per SMC page: unfiltered volume for three days is a lot of
      // orders; 25/page would hit SMC's 100-page cap.
      smcPageSize: 200,
      // Only rows with a VRID are runs.
      requireVrid: true,

      // ── dashboard ──────────────────────────────────────────────────────────
      runs: {
        // Pickup window pulled from SMC, relative to today (browser local).
        daysBack: 1,
        daysForward: 1,
        // VRIDs per fmcStatuses message (page loops; keeps each message < 30s).
        fmcChunk: 300,
        // Delivered when the FMC execution status is one of these.
        completedStatuses: ["ARRIVED_AT_FINAL_DESTINATION", "COMPLETED"],
        // Status filter default: everything except these.
        defaultExcludedStatuses: ["CANCELLED"],
        // Destination type: an Amazon node code (short upper-case code such as
        // DTM2 / LEJ1 / RSWR) is INBOUND; anything else (the long
        // "PROCTER__53881_118"-style customer codes) is OFF-AMAZON. Heuristic.
        amazonNodePattern: "^[A-Z][A-Z0-9]{2,4}$",
        // RLB tab: placeholder carriers (SCACs) that mean "no real carrier yet".
        placeholderCarriers: ["RLB1", "DUMMY", "AZNG"],
        // Auto-refresh: minutes between reloads while the page is open.
        autoRefresh: { min: 5, max: 60, step: 5, default: 15 },
      },
    },
  },
};
