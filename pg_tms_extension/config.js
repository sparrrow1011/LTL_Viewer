/**
 * P&G TMS Viewer — configuration.
 *
 * Reads P&G freight orders straight off the JDA / BlueYonder TMS
 * ("Transportation Manager") Shipment Leg list page. Unlike SMC (a JSON API),
 * TMS renders a server-side HTML table, so the content script scrapes the
 * rendered DOM rather than calling an API — no creds stored, uses the page's
 * own logged-in session.
 *
 * AUTH MODEL: cookie-based. The user is already signed in to TMS in Firefox.
 * The content-script "bridge" runs ON the TMS origin and reads the DOM there.
 *
 * Only the background (ES module) imports this file. Content scripts
 * (tms.js, overlay.js) can't import modules, so column indexes and SITE_NAMES
 * are duplicated in content/tms.js — keep them in sync.
 */

export const Config = {
  DEBUG: false,

  // ── remote control (control.json on the updates branch) ────────────────────
  // Global/per-user/per-install kill switch + minVersion + notice. Shared
  // background/control.js re-reads this every CONTROL_REFRESH_MINUTES and
  // before each run. Slug: pg-tms-viewer.
  CONTROL_URL: "https://raw.githubusercontent.com/sparrrow1011/LTL_Viewer/updates/pg-tms-viewer/control.json",
  CONTROL_REFRESH_MINUTES: 15,

  // ── SharePoint (usage roster only) ─────────────────────────────────────────
  // Cookie-auth REST works only from a page ON the SharePoint origin, so the
  // usage reporter routes _api calls through content/sp-bridge.js on a tab of
  // this site. Same tenant/site as the other extensions' Extension_Installs.
  SP_ORIGIN: "https://amazongbr.sharepoint.com",
  SP_SITE_PATH: "/sites/AmazonFreightOperations",
  SP_TAB_URL: "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations",
  SP_TAB_MATCH: "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations/*",

  // ── TMS (JDA / BlueYonder "Transportation Manager") ────────────────────────
  // The P&G prod SSO host. host_permissions uses the wildcard so other JDA
  // hostnames (test/stage) still work.
  TMS_ORIGIN: "https://pgem-aztms-sso-pr1.jdadelivers.com",
  TMS_TAB_MATCH: "https://*.jdadelivers.com/*",
  // The Shipment Leg list controller — where the order table lives.
  TMS_LIST_HINT: "LP_ShipmentLegListController.gsm",

  // Every origin the add-on needs site access for. Installed MV3 add-ons (and
  // temporary ones reloaded after a manifest change) start without it; the
  // toolbar click requests whatever is missing.
  HOST_ORIGINS: [
    "https://*.jdadelivers.com/*",
    "https://smc-eu-dub.dub.proxy.amazon.com/*",
    "https://amazongbr.sharepoint.com/*",
    "https://procurementportal-eu.corp.amazon.com/*",
  ],

  // ── Shipment Leg list table ────────────────────────────────────────────────
  // The results table id and the 0-based column indexes on each data row
  // (tr.tableRow0 / tr.tableRow1). Confirmed against the live page markup.
  // If P&G re-orders the list columns (List Customization), update these.
  TABLE_ID: "ShipmentLegListSEARCH_RESULTSTableID",
  COLUMNS: {
    po: 0, // Customer Purchase Order  → BOL must equal this
    crdd: 1, // Shipment Pickup From Date/Time (CRDD)
    status: 2, // Load Operational Status (Open / Tender Accepted ...)
    loadId: 3, // Load ID (shipper ref)
    ladenLength: 4, // Shipment Laden Length (M)
    site: 5, // Origin Location ID (DE08 = Euskirchen, FR57 = Amiens ...)
    loadTracking: 6, // Load Tracking Number
    commodity: 7, // Shipment Commodity
    originCity: 8, // Origin City
    shipmentTracking: 9, // Shipment Tracking Number
    shipmentId: 10, // Shipment ID
    customerName: 11, // Customer Name
    destAddress: 12, // Destination Address
    pallets: 13, // Theoretical Pallets (true count)
    loadMitcc: 14, // Load MITCC
    bookingNumber: 15, // BOOKING NUMBER
    loadLadenLength: 16, // Load Laden Length (M)
    pickupTo: 17, // Shipment Pickup To Date/Time
    deliveryFrom: 18, // Shipment Delivery From Date/Time  (PO window start)
    deliveryTo: 19, // Shipment Delivery To Date/Time    (PO window end)
    apptFrom: 20, // Pick Stop Appointment From Date/Time (ISA)
  },

  // ── Origin Location ID → site name (from the SOP + observed data) ───────────
  SITE_NAMES: {
    DE08: "Euskirchen (DE)",
    DE87: "Altfeld (DE)",
    DEB7: "Altfeld (DE)", // the list renders it as DEB7 (letter B)
    FR57: "Amiens (FR)",
    // Fill in the rest as their Origin Location IDs are confirmed:
    // Jijona (ES), Cabanillas (ES), Agnadello (IT), London (UK), Manchester (UK).
  },

  // ── Origin Location ID → SITES key. DE08 / DE87 / FR57 are confirmed from
  // live data; add the others here as soon as their IDs show up in the list.
  SITE_CODES: {
    DE08: "euskirchen",
    DE87: "altfeld",
    DEB7: "altfeld",
    FR57: "amiens",
  },

  // ── Per-site rules from the P&G SOP (docks, equipment, deadlines, contacts).
  // Shown in the overlay's site panel. Keep the wording short — it's a cheat
  // sheet, not the SOP itself. `smcMatch`: keywords expected in the SMC pickup
  // stop (name / code / city / state) for the alignment check; the UK ones are
  // guesses until a real P&G UK order is seen. `smcPickup`: the shipper location
  // name SMC knows the site by (typed into the create form) — only Amiens is
  // confirmed ("Big Box"); fill the others in from real orders.
  SITES: {
    euskirchen: {
      smcPickupCode: "PROCTER__53881_118", // SMC location code (from contracted lanes)
      tz: "Europe/Berlin", currency: "EUR", country: "DE",
      smcMatch: ["EUSKIRCHEN"],
      name: "Euskirchen (DE)",
      docks: "LIVE_OUT0101 – LIVE_OUT0107",
      contacts: [
        "cnf-tcf-euskirchen@groups.pg.com",
        "cnf-eus-dc-operations@groups.pg.com",
        "cnf-eus-dc-whseteam@groups.pg.com",
      ],
      notes: [
        "Create the SMC order + ISA for every open forecast load daily; first CRDD must match the RDD in TMS and sit inside the PO window.",
        "Once ISA is valid, book the loading slot in Dock Schedule; do not postpone or reschedule it afterwards.",
        "After P&G releases the order, compare the final RDD with the ISA and adjust the ISA (edit, never cancel).",
      ],
    },
    amiens: {
      smcPickupCode: "BIG_BOX_80000_398", // SMC location code (from contracted lanes)
      tz: "Europe/Paris", currency: "EUR", country: "FR",
      // SMC stop seen live: "Big Box" / BIG_BOX_80000_398, city Poulainville, state Amiens
      smcMatch: ["AMIENS", "BIG BOX", "BIG_BOX", "POULAINVILLE"],
      smcPickup: "Big Box", // name to type in the SMC create form's pickup stop
      name: "Amiens (FR)",
      docks: "LIVE_CUST0101 – LIVE_CUST0103",
      contacts: ["cnf-tcf-amiens@groups.pg.com"],
      notes: [
        "Frequent ASN/BOL discrepancies — validate ASN, unit counts and PO/BOL before dispatch; hold dispatch until aligned.",
        "Amiens does not accept trailers with straps.",
        "Same daily flow as Euskirchen (SMC order + ISA, then Dock Schedule slot).",
      ],
    },
    altfeld: {
      smcPickupCode: "PROCTER__97828__849", // SMC location code (from contracted lanes)
      tz: "Europe/Berlin", currency: "EUR", country: "DE",
      smcMatch: ["ALTFELD"],
      name: "Altfeld (DE)",
      docks: "DC_OUT_DIRECT4",
      contacts: [
        "kimmel.n@pg.com",
        "schick.d@pg.com",
        "cnf-dca-dispo@groups.pg.com",
        "cffbnlaltfeld.im@pg.com",
      ],
      notes: ["Same daily flow as Euskirchen (SMC order + ISA, then Dock Schedule slot)."],
    },
    jijona: {
      smcPickupCode: "6415___J_03100_283", // SMC location code (from contracted lanes)
      tz: "Europe/Madrid", currency: "EUR", country: "ES",
      smcMatch: ["JIJONA"],
      name: "Jijona (ES)",
      docks: "DC_LOADS_1_PUNTA, DC_OVERBOOKING",
      contacts: ["CNF-GestionCd@groups.pg.com", "cnf-operadores_cd_jijona@groups.pg.com"],
      notes: [
        "Orders arrive via Paragon case and EDI. Wait for Tender Accepted before touching the EDI draft.",
        "Add the PO as BOL, align to RDD, Set to Appointed to create the ISA; confirm ISA is inside the PO window.",
        "Driver + truck details incl. last 4 digits of the driver ID must be in TMS; drivers sign in with the P&G shipment number.",
      ],
    },
    cabanillas: {
      smcPickupCode: "B145___L_19171_315", // SMC location code (from contracted lanes)
      tz: "Europe/Madrid", currency: "EUR", country: "ES",
      smcMatch: ["CABANILLAS"],
      name: "Cabanillas (ES)",
      docks: "LIVE_OUT_CUST_05 – LIVE_OUT_CUST_08",
      contacts: ["perezcubillo.r@pg.com", "layout.naveb@luis-simoes.com", "david.jimenez@luis-simoes.com"],
      notes: [
        "Same flow as Jijona (Tender Accepted → edit EDI draft → Set to Appointed → slot).",
        "Driver + truck details incl. last 4 digits of the driver ID must be in TMS.",
      ],
    },
    agnadello: {
      smcPickupCode: "CD_GROUP_26020__751", // SMC location code (from contracted lanes)
      tz: "Europe/Rome", currency: "EUR", country: "IT",
      smcMatch: ["AGNADELLO"],
      name: "Agnadello (IT)",
      docks: "Pre-booked by P&G (changes: rausa.lf@pg.com, dezi.fr@pg.com)",
      contacts: [
        "dagostino.f.2@pg.com",
        "menichetti.e@pg.com",
        "rausa.lf@pg.com",
        "corridoni.s@pg.com",
        "romano.s@pg.com",
      ],
      notes: [
        "Pre-book from the forecast and assign the carrier per tender guidelines.",
        "When the tender is accepted an EDI order arrives with the Load ID: delete the EDI order and add its Load ID to the forecast order.",
      ],
    },
    london: {
      smcPickupCode: "DROPP_RO_RM20_4AL_622", // SMC location code (from contracted lanes)
      tz: "Europe/London", currency: "GBP", country: "GB",
      smcMatch: ["LONDON", "TILBURY", "THURROCK"],
      name: "London (UK)",
      docks: "DROP_CUST0101 – DROP_CUST0107",
      equipment: "Single deck / 3-axle detach trailer, swing doors, no shutter door or tail lift",
      contacts: ["cnf-t-ops@groups.pg.com", "droplotlondon.im@pg.com", "Gatehouse 01375 395 274"],
      notes: [
        "Process UK orders between 15:45 and 17:00 UK; book the Dock Schedule slot before 17:00 or it may auto-book.",
        "Edit the EDI draft: PO as BOL, times per RDD inside the PO window, Stop 1 Drop & Hook, Stop 2 Live, pallets doubled, shipper price added.",
        "Send truck + driver details to droplotlondon.im@pg.com or the driver is refused.",
      ],
    },
    manchester: {
      tz: "Europe/London", currency: "GBP", country: "GB",
      smcMatch: ["MANCHESTER", "TRAFFORD"],
      name: "Manchester (UK)",
      docks: "DROP_CUST0200 – DROP_CUST0206",
      equipment: "13.6 m curtain trailer, 3-axle",
      contacts: [
        "cnf-mandistribution@groups.pg.com",
        "Mansecurityreleases@pgone.onmicrosoft.com",
        "Gatehouse 0161 875 6000",
      ],
      notes: [
        "Process UK orders between 15:45 and 17:00 UK; book the Dock Schedule slot before 17:00 or it may auto-book.",
        "Edit the EDI draft: PO as BOL, times per RDD inside the PO window, Stop 1 Drop & Hook, Stop 2 Live, pallets doubled, shipper price added.",
        "Send truck + driver details to cnf-mandistribution@groups.pg.com and Mansecurityreleases@pgone.onmicrosoft.com.",
      ],
    },
  },

  // ── SMC (read-only, via the SMC-origin bridge content/smc.js) ───────────────
  // Used to answer "does this forecast load already have an SMC order?".
  // Match key: TMS Load ID == SMC shipperReferenceId (the "shipper reference"
  // column of the SMC export the SOP has you paste into Excel).
  SMC_ORIGIN: "https://smc-eu-dub.dub.proxy.amazon.com",
  SMC_TAB_URL: "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1",
  SMC_TAB_MATCH: "https://smc-eu-dub.dub.proxy.amazon.com/*",
  SMC_ORDER_URL: (id) => `https://smc-eu-dub.dub.proxy.amazon.com/order/${encodeURIComponent(id)}`,

  // ── Procurement Portal (authoritative PO window + destination FC) ──────────
  // Cookie-auth (Midway). content/portal.js runs on a portal tab and POSTs the
  // PO (= BOL = TMS Customer Purchase Order) to /bp-api/search/po. Response
  // gives fcId (delivery FC) and handOffStart/handOffEnd (the PO delivery
  // window; handOffEnd = "Latest Vendor Delivery Date").
  PORTAL_ORIGIN: "https://procurementportal-eu.corp.amazon.com",
  PORTAL_SEARCH_URL: "https://procurementportal-eu.corp.amazon.com/bp-api/search/po",
  PORTAL_TAB_URL: "https://procurementportal-eu.corp.amazon.com/",
  PORTAL_TAB_MATCH: "https://procurementportal-eu.corp.amazon.com/*",
  PORTAL_PO_URL: (poId) =>
    `https://procurementportal-eu.corp.amazon.com/bp/po?poId=${encodeURIComponent(poId)}&tabId=summary`,
  // New-order form for a shipper (P&G: /order/create/9206952112).
  SMC_CREATE_URL: (shipperId) =>
    `https://smc-eu-dub.dub.proxy.amazon.com/order/create/${encodeURIComponent(shipperId)}`,
  // Draft creation — the request the SMC create form sends when you save
  // (captured 2026-09-29: POST /shipper/order/createV3/ with status "DRAFT").
  SMC_CREATE_ENDPOINT: "https://smc-eu-dub.dub.proxy.amazon.com/shipper/order/createV3/",
  SMC_MILEAGE_ENDPOINT: "https://smc-eu-dub.dub.proxy.amazon.com/mileage/calculate",
  // Defaults for a P&G order as seen on real ones (orders 7294135589, 8241426373).
  SMC_ORDER_DEFAULTS: {
    shipperName: "Procter & Gamble International Operations SA",
    businessChannel: "DE",
    equipmentType: "DETACHED_TRAILER",
    freightType: "TRUCKLOAD",
    palletType: "EU_PALLET",
    loadingType: "LIVE_LOAD",
    invoicePreference: "SCHEDULED",
    weightUnit: "kg",
    // Panel defaults (site-local time); all editable before creating.
    pickupFrom: "07:00",
    pickupTo: "13:00",
    deliveryTime: "12:00",
  },
  // IDC (1DC) destination nodes — flagged on the row and in the draft panel.
  // Add codes here as they're confirmed.
  IDC_NODES: ["ZAZ8", "EUK1", "DRS8", "DTM5", "XBR2", "XDT6", "XLY2"],

  // Destination time zone by country (Amazon nodes have no tz in the location
  // search result); falls back to the pickup site's tz.
  COUNTRY_TZ: {
    FR: "Europe/Paris", DE: "Europe/Berlin", ES: "Europe/Madrid", IT: "Europe/Rome", GB: "Europe/London",
    NL: "Europe/Amsterdam", BE: "Europe/Brussels", PL: "Europe/Warsaw", CZ: "Europe/Prague", AT: "Europe/Vienna",
    LU: "Europe/Luxembourg", PT: "Europe/Lisbon", SE: "Europe/Stockholm", IE: "Europe/Dublin",
  },
  // andCriteria for /shipper/order/search. P&G runs are truckload, from DE / FR /
  // ES / IT / GB entities; readyForScheduling is NOT sent so drafts are found too.
  SMC_QUERY: {
    orderSources: ["SMC", "EDI", "R4S", "AFAPI", "AFDIG"],
    freightTypes: ["TRUCKLOAD", "LESS_THAN_TRUCKLOAD", "INTERMODAL"],
    orderExecutionStatuses: [
      "IN_DRAFT", "PENDING_CARRIER_ACCEPTANCE", "CARRIER_TENDER_ACCEPTED",
      "DRIVER_DISPATCHED", "LATE_TO_ARRIVE", "ARRIVED", "LATE_TO_DEPART",
      "DEPARTED", "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED",
      "PENDING_PAYMENT", "PAID", "REJECTED", "NOT_PLANNED",
    ],
    shipperBusinessChannels: ["DE", "FR", "ES", "IT", "GB"],
    readyForScheduling: null,
  },

  // ── User settings (browser.storage.local "pg.settings"), editable in the
  // overlay's Settings panel. `shipperIds` is REQUIRED for the SMC check —
  // without it the search would span every shipper in the window.
  SETTINGS_KEY: "pg.settings",
  DEFAULT_SETTINGS: {
    shipperIds: [], // P&G shipper account IDs in SMC (one per entity)
    windowPadDays: 2, // SMC origin window = [min CRDD − pad, max CRDD + pad]
    prices: {}, // last LINE_HAUL price used per site key, e.g. { amiens: 295 }
  },
};
