/**
 * TMS data source — content-script side.
 *
 * Runs on the JDA / BlueYonder TMS ("Transportation Manager") pages. Unlike SMC,
 * TMS has no JSON API we can call — it renders the Shipment Leg list as a
 * server-side HTML table. So this bridge SCRAPES the rendered DOM of
 * #ShipmentLegListSEARCH_RESULTSTableID and returns structured rows.
 *
 * The TMS UI is a frameset (top.i2ui_shell_content...), so the content script is
 * injected into all frames (manifest all_frames:true). Only the frame that
 * actually contains the results table answers with rows; the others report
 * hasTable:false and the background picks the frame that found data.
 *
 * Two consumers: content/overlay.js (same frame) calls window.__pgTms.extract()
 * directly, and the background (tmsClient.js) can send `tms:*` messages,
 * answered at the bottom of this file, for diagnostics and future SMC work.
 */
(function () {
  "use strict";

  // 0-based column indexes on each data row. Duplicated from config.js because
  // content scripts can't import ES modules. Keep in sync with Config.COLUMNS.
  const COL = {
    po: 0,
    crdd: 1,
    status: 2,
    loadId: 3,
    ladenLength: 4,
    site: 5,
    loadTracking: 6,
    commodity: 7,
    originCity: 8,
    shipmentTracking: 9,
    shipmentId: 10,
    customerName: 11,
    destAddress: 12,
    pallets: 13,
    loadMitcc: 14,
    bookingNumber: 15,
    loadLadenLength: 16,
    pickupTo: 17,
    deliveryFrom: 18,
    deliveryTo: 19,
    apptFrom: 20,
  };

  const TABLE_ID = "ShipmentLegListSEARCH_RESULTSTableID";

  const SITE_NAMES = {
    DE08: "Euskirchen (DE)",
    DE87: "Altfeld (DE)",
    DEB7: "Altfeld (DE)", // the list renders it as DEB7 (letter B)
    FR57: "Amiens (FR)",
  };

  function dlog(...a) {
    if (window.__pgDebug) console.debug("[PG tms]", ...a);
  }

  // ── text helpers ────────────────────────────────────────────────────────────
  const clean = (s) => (s == null ? "" : String(s).replace(/\u00a0/g, " ").trim());

  // TMS prints dates as "DD/MM/YYYY HH:MM". Parse to an ISO string (local-naive)
  // so the UI can sort/compare. Returns "" when the cell is blank.
  function parseTmsDate(raw) {
    const s = clean(raw);
    if (!s) return { raw: "", iso: "" };
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) return { raw: s, iso: "" };
    const [, dd, mm, yyyy, hh = "00", mi = "00"] = m;
    const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00`;
    return { raw: s, iso };
  }

  // ── find the results table (may be in this frame or not) ─────────────────────
  function findTable() {
    return document.getElementById(TABLE_ID);
  }

  // Read the checkbox RowKey (TMS's internal shipment-leg key) from a data row.
  function rowKeyOf(tr) {
    const cb = tr.querySelector('input[name="RowKey"]');
    return cb ? clean(cb.value) : "";
  }

  // ── header-based column mapping ─────────────────────────────────────────────
  // TMS lists are user-customisable (List Customization), so positional indexes
  // are fragile. Preferred: read the header row and map columns by their label.
  // Labels are matched after normalising to lowercase alphanumerics and by
  // PREFIX, so "Shipment Pickup From Date/Time" matches "shipmentpickupfrom".
  // Falls back to COL (positional) when no usable header row is found.
  const HEADERS = {
    po: ["customerpurchaseorder"],
    crdd: ["shipmentpickupfrom"],
    status: ["loadoperationalstatus"],
    loadId: ["loadid"],
    ladenLength: ["shipmentladenlength"],
    site: ["originlocationid"],
    originName: ["loadoriginlocationname", "originlocationname"],
    loadTracking: ["loadtrackingnumber"],
    commodity: ["shipmentcommodity"],
    originCity: ["origincity"],
    shipmentTracking: ["shipmenttrackingnumber"],
    shipmentId: ["shipmentid"],
    customerName: ["customername"],
    destAddress: ["destinationaddress"],
    pallets: ["theoreticalpallets"],
    loadMitcc: ["loadmitcc"],
    bookingNumber: ["bookingnumber"],
    loadLadenLength: ["loadladenlength"],
    pickupTo: ["shipmentpickupto"],
    deliveryFrom: ["shipmentdeliveryfrom"],
    deliveryTo: ["shipmentdeliveryto"],
    apptFrom: ["pickstopappointmentfrom"],
    weight: ["shipmentweight"],
  };
  const normHeader = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  /**
   * Build { field: rawCellIndex } from the header row, or null.
   * Header cells are indexed the same way as the data row's <td>s (both include
   * the leading checkbox column), so no offset is needed.
   */
  function headerMap(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    const firstData = rows.findIndex((tr) => tr.querySelector('input[name="RowKey"]'));
    const candidates = firstData < 0 ? rows : rows.slice(0, firstData);
    let best = null;
    for (const tr of candidates) {
      const cells = Array.from(tr.querySelectorAll("th, td"));
      if (cells.length < 8) continue;
      const labels = cells.map((c) => normHeader(c.textContent));
      const map = {};
      let hits = 0;
      for (const [field, keys] of Object.entries(HEADERS)) {
        const idx = labels.findIndex((l) => l && keys.some((k) => l.startsWith(k)));
        if (idx >= 0) {
          map[field] = idx;
          hits += 1;
        }
      }
      if (hits >= 6 && (!best || hits > best.hits)) best = { map, hits, cells: cells.length };
    }
    if (!best) return null;
    dlog(`header mapping: ${best.hits} column(s) recognised out of ${best.cells}`);
    return best;
  }

  // Amazon node code inside a TMS destination string, e.g. "AMAZON XLY2 TROYES"
  // → "XLY2". Node codes are 3 letters + 1 digit (XLY2, DTM2, LIL1) or, rarely,
  // 4 alphanumerics containing a digit. Returns "" for a plain postal address
  // (e.g. "1 AVENUE ALAIN BOUCHER 60309 SENLIS OISE FRA") — the background then
  // resolves that via SMC location search + the contracted lanes.
  function destNodeOf(dest) {
    const s = clean(dest).toUpperCase();
    // Only treat a token as a node when it's flagged as an Amazon node (the
    // column usually reads "AMAZON <NODE> <CITY>") to avoid matching random
    // 4-char chunks of a street address.
    let m = s.match(/\bAMAZON\s+([A-Z]{3}\d|[A-Z]{2}\d{2})\b/);
    if (m) return m[1];
    m = s.match(/\b([A-Z]{3}\d)\b/);
    if (m && !/\d{4,}/.test(s)) return m[1]; // a bare node, not inside an address with a 5-digit postcode
    return "";
  }

  // Postcode + city from a TMS destination address, for resolving the node when
  // no code is present. Handles FR/DE/ES/IT 4–5 digit and UK alphanumeric codes.
  function destPostalOf(dest) {
    const s = clean(dest);
    let pc = "";
    let m = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i); // UK
    if (m) pc = m[1].toUpperCase().replace(/\s+/, " ");
    else {
      m = s.match(/\b(\d{4,5})\b/); // continental
      if (m) pc = m[1];
    }
    // City: the token right after the postcode, else the last wordy token.
    let city = "";
    if (pc) {
      const after = s.split(pc)[1] || "";
      // First wordy token after the postcode, minus trailing region/country
      // noise (OISE, FRA, HAUTS-DE-FRANCE …).
      city = (after.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+)?/) || [""])[0].trim();
      city = city.replace(/\s+(OISE|FRA|FRANCE|DEU|DE|ESP|ITA|GBR|UK)\b.*$/i, "").trim();
    }
    return { postcode: pc, city };
  }

  // "Shipment Weight (KG)" → number rounded to 1 dp; "" when not numeric.
  // TMS prints KG with a dot decimal and NO thousands grouping (10433.0934,
  // 5436.275, 380.03), so a single separator is always the decimal point.
  // Grouped forms ("10.432,60", "10,432.60", "10 432") are handled too: with
  // two separator kinds the last one is the decimal; a repeated separator is
  // grouping only.
  function parseWeight(raw) {
    const s = clean(raw).replace(/\s/g, "").replace(/[^\d.,-]/g, "");
    if (!s) return "";
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    let num;
    if (dots && commas) {
      const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
      num = s.slice(0, lastSep).replace(/[.,]/g, "") + "." + s.slice(lastSep + 1);
    } else if (dots > 1) {
      num = s.replace(/\./g, "");
    } else if (commas > 1) {
      num = s.replace(/,/g, "");
    } else {
      num = s.replace(",", ".");
    }
    const n = parseFloat(num);
    return Number.isNaN(n) ? "" : Math.round(n * 10) / 10;
  }

  // ── one <tr> → structured order object ───────────────────────────────────────
  function rowToObj(tr, hdr) {
    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length < 2) return null;
    let cell;
    if (hdr && hdr.cells === tds.length) {
      // Header mode: index straight into the raw <td>s.
      cell = (field) => {
        const i = hdr.map[field];
        return i == null || !tds[i] ? "" : clean(tds[i].textContent);
      };
    } else {
      // Positional mode: drop the leading checkbox cell so COL indexes line up.
      const cells = tds.slice(1);
      cell = (field) => {
        const i = COL[field];
        return i == null || !cells[i] ? "" : clean(cells[i].textContent);
      };
    }

    const po = cell("po");
    if (!po) return null; // header/spacer row — skip

    const siteCode = cell("site");
    const crdd = parseTmsDate(cell("crdd"));
    const deliveryFrom = parseTmsDate(cell("deliveryFrom"));
    const deliveryTo = parseTmsDate(cell("deliveryTo"));
    const apptFrom = parseTmsDate(cell("apptFrom"));
    const status = cell("status");
    const destAddress = cell("destAddress");
    const ladenLength = cell("ladenLength");
    const loadLadenLength = cell("loadLadenLength");
    const palNum = (s) => (s ? Math.round(parseFloat(String(s).replace(",", ".")) || 0) || "" : "");

    return {
      rowKey: rowKeyOf(tr),
      po, // Customer Purchase Order (also the BOL)
      bol: po, // BOL must always equal the PO
      status, // Load Operational Status
      isTenderAccepted: /tender\s*accepted/i.test(status),
      loadId: cell("loadId"), // Load ID / shipper ref
      site: siteCode,
      siteName: SITE_NAMES[siteCode] || siteCode,
      originName: cell("originName"), // Load Origin Location Name (when listed)
      originCity: cell("originCity"),
      pallets: cell("pallets"), // Theoretical Pallets (display)
      ladenLength, // Shipment Laden Length (M) — kept for reference
      loadLadenLength, // Load Laden Length (M) — used as the SMC pallet count
      smcPallets: palNum(loadLadenLength),
      weightRaw: cell("weight"), // Shipment Weight as printed ("" if not listed)
      weight: parseWeight(cell("weight")), // number, 1 dp
      commodity: cell("commodity"),
      customerName: cell("customerName"),
      destAddress,
      destNode: destNodeOf(destAddress), // e.g. XLY2 → SMC location search ("" if the column is a street address)
      destPostcode: destPostalOf(destAddress).postcode,
      destCity: destPostalOf(destAddress).city,
      shipmentId: cell("shipmentId"),
      bookingNumber: cell("bookingNumber"),
      loadTracking: cell("loadTracking"),
      shipmentTracking: cell("shipmentTracking"),
      // dates (raw as shown + iso for sorting)
      crdd: crdd.raw,
      crddIso: crdd.iso,
      pickupTo: parseTmsDate(cell("pickupTo")).raw,
      deliveryFrom: deliveryFrom.raw,
      deliveryFromIso: deliveryFrom.iso,
      deliveryTo: deliveryTo.raw,
      deliveryToIso: deliveryTo.iso,
      // PO delivery window = [deliveryFrom, deliveryTo]
      poWindow:
        deliveryFrom.raw && deliveryTo.raw ? `${deliveryFrom.raw} → ${deliveryTo.raw}` : "",
      appointment: apptFrom.raw, // Pick Stop Appointment From (ISA)
      appointmentIso: apptFrom.iso,
    };
  }

  // ── derive simple validation flags per row (SOP rules) ───────────────────────
  // Non-blocking: the UI shows these as hints, it does not change TMS.
  function validate(row) {
    const flags = [];
    // Status must reach "Tender Accepted" before SMC creation (esp. ES).
    if (!row.isTenderAccepted && row.status)
      flags.push({ level: "warn", msg: `Status is "${row.status}" — wait for Tender Accepted` });
    // The "CRDD" column is Shipment Pickup From — a PICKUP timestamp. Pickup
    // naturally precedes the delivery window, so only a pickup AFTER the window
    // closes is impossible to deliver on time. Compare by calendar day: TMS
    // prints windows as 00:01 → 23:59, so a 00:00 pickup must not trip it.
    const day = (iso) => (iso ? iso.slice(0, 10) : "");
    if (row.crddIso && row.deliveryToIso && day(row.crddIso) > day(row.deliveryToIso))
      flags.push({
        level: "error",
        msg: "Pickup is after the PO delivery window closes — book inside the window, then push the order per RDD",
      });
    // Appointment past the delivery window is NORMAL practice per the SOP (book
    // inside the window, then push per RDD; only the original CRDD is measured),
    // so this is a note, not a warning.
    if (row.appointmentIso && row.deliveryToIso && day(row.appointmentIso) > day(row.deliveryToIso))
      flags.push({ level: "info", msg: "Appointment pushed past the PO window (per RDD)" });
    return flags;
  }

  // ── scrape the whole table ───────────────────────────────────────────────────
  function extract() {
    const table = findTable();
    if (!table) return { hasTable: false, href: location.href, rows: [] };
    const hdr = headerMap(table);
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      // data rows carry the RowKey checkbox; header row does not.
      if (!tr.querySelector('input[name="RowKey"]')) continue;
      const obj = rowToObj(tr, hdr);
      if (obj) {
        obj.flags = validate(obj);
        rows.push(obj);
      }
    }
    const mapping = hdr ? "header" : "positional";
    const missing = hdr ? Object.keys(HEADERS).filter((k) => hdr.map[k] == null) : [];
    dlog(`extracted ${rows.length} row(s) from ${TABLE_ID} (${mapping} mapping${missing.length ? `, not listed: ${missing.join(", ")}` : ""})`);
    return { hasTable: true, href: location.href, count: rows.length, rows, mapping, missingColumns: missing };
  }

  // ── bridge: answer the background's tms:* messages ───────────────────────────
  const fail = (err) => ({
    bridge: true,
    ok: false,
    error: String(err && err.message ? err.message : err),
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("tms:")) return;
    dlog(`bridge ← ${msg.action} (frame ${location.href})`);
    if (msg.action === "tms:ping") {
      return Promise.resolve({ bridge: true, ok: true, hasTable: !!findTable(), href: location.href });
    }
    if (msg.action === "tms:extract") {
      try {
        return Promise.resolve({ bridge: true, ok: true, ...extract() });
      } catch (e) {
        return Promise.resolve(fail(e));
      }
    }
    return Promise.resolve(fail(new Error(`Unknown tms action: ${msg.action}`)));
  });

  browser.runtime
    .sendMessage({ action: "tms:bridge-ready", href: location.href, hasTable: !!findTable() })
    .catch(() => {});

  window.__pgTms = { extract, findTable, headerMap: () => headerMap(findTable()), destNodeOf, destPostalOf, parseWeight };
})();
