/**
 * SMC data source — content-script side.
 *
 * Runs on the SMC page, so it fetches /shipper/order/search same-origin with the
 * page's own session cookies (credentials:"include"). This is the read source of
 * truth for the load list (SharePoint only holds the manual-sourcing work we do
 * on top).
 *
 * It is the SMC BRIDGE for the standalone UI (ui/app.html): the background
 * (smcClient.js) finds/opens an SMC tab and sends `smc:*` messages, answered at
 * the bottom of this file. window.__ltlSmc is kept for console diagnostics.
 */
(function () {
  "use strict";

  const SEARCH_URL = "https://smc-eu-dub.dub.proxy.amazon.com/shipper/order/search";
  const PAGE_SIZE = 25;
  const MAX_PAGES = 100;
  const DAYS_BACK = 7;
  const DAYS_FORWARD = 7;

  // Raw orders from the most recent fetch, kept for diagnostics.
  let __lastRawOrders = [];

  function dlog(...a) {
    if (window.__ltlDebug && window.__ltlDebug.status && window.__ltlDebug.status.call)
      console.debug("[LTL smc]", ...a);
    else console.debug("[LTL smc]", ...a);
  }

  // ── date window: default one week back / one week forward, ".000Z" ──────────
  function defaultWindow() {
    const now = Date.now();
    const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, ".000Z");
    return { start: fmt(now - DAYS_BACK * 86400_000), end: fmt(now + DAYS_FORWARD * 86400_000) };
  }

  // Normalize a caller-supplied window into ISO-Z bounds.
  //  - start/end as "YYYY-MM-DD"  → start = 00:00:00Z, end = 23:59:59Z of that day
  //  - start/end as a full ISO datetime (contains "T") → used as-is
  // Missing/invalid start or end falls back to the default bound.
  function resolveWindow(win) {
    const def = defaultWindow();
    if (!win || (!win.start && !win.end)) return def;
    const norm = (v, kind, fallback) => {
      if (!v) return fallback;
      const s = String(v);
      // Full datetime provided → use verbatim (parse to normalize the format).
      if (s.includes("T")) {
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? fallback : d.toISOString().replace(/\.\d+Z$/, ".000Z");
      }
      // Date-only → start/end of that UTC day.
      const time = kind === "start" ? "T00:00:00.000Z" : "T23:59:59.000Z";
      const d = new Date(`${s.slice(0, 10)}${time}`);
      return Number.isNaN(d.getTime()) ? fallback : d.toISOString().replace(/\.\d+Z$/, ".000Z");
    };
    return { start: norm(win.start, "start", def.start), end: norm(win.end, "end", def.end) };
  }

  // ── query (team-scoped) ─────────────────────────────────────────────────────
  // Historical LTL query, used when no team query is supplied.
  const DEFAULT_QUERY = {
    orderSources: ["SMC", "EDI", "R4S", "AFAPI", "AFDIG"],
    freightTypes: ["LESS_THAN_TRUCKLOAD"],
    orderExecutionStatuses: [
      "IN_DRAFT", "PENDING_CARRIER_ACCEPTANCE", "CARRIER_TENDER_ACCEPTED",
      "DRIVER_DISPATCHED", "LATE_TO_ARRIVE", "ARRIVED", "LATE_TO_DEPART",
      "DEPARTED", "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED",
      "PENDING_PAYMENT", "PAID", "REJECTED", "NOT_PLANNED",
    ],
    shipperBusinessChannels: ["DE", "GB"],
    readyForScheduling: true,
  };
  // SMC caps shipperIds per request (CST_viewer used 1000).
  const MAX_SHIPPER_IDS = 1000;

  /**
   * Build the /shipper/order/search payload.
   * @param {number} page
   * @param {{start,end}} win
   * @param {object} [opts]
   * @param {object} [opts.query]      andCriteria overrides (Config.TEAMS[x].smcQuery)
   * @param {string[]} [opts.shipperIds]  restrict to these shipper IDs (CST SoT)
   */
  function buildPayload(page, win, opts = {}) {
    const { start, end } = resolveWindow(win);
    const q = { ...DEFAULT_QUERY, ...(opts.query || {}) };
    const andCriteria = {
      orderSources: q.orderSources,
      freightTypes: q.freightTypes,
      orderExecutionStatuses: q.orderExecutionStatuses,
      shipperBusinessChannels: q.shipperBusinessChannels || [],
      originDateRangeLabel: null,
      originDateRange: { start, end },
    };
    // null/undefined = don't send the readyForScheduling filter at all.
    if (q.readyForScheduling != null) andCriteria.readyForScheduling = q.readyForScheduling;
    if (opts.shipperIds && opts.shipperIds.length) {
      andCriteria.shipperIds = opts.shipperIds.slice(0, MAX_SHIPPER_IDS);
    }
    return {
      sortCriteria: [{ field: "ORDER_CREATION_DATE", sortDirection: "DESC" }],
      andCriteria,
      orCriteria: {},
      pageCriteria: { page, size: opts.pageSize || PAGE_SIZE },
    };
  }

  // ── best-effort CSRF token from the live page ───────────────────────────────
  function captureCsrf() {
    const meta = document.querySelector(
      'meta[name="csrf-token"], meta[name="x-csrf-token"], meta[name="anti-csrftoken-a2z"]'
    );
    if (meta) return meta.getAttribute("content");
    const cookie = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => /csrf|xsrf/i.test(s));
    return cookie ? cookie.split("=").slice(1).join("=") : null;
  }

  async function postSearch(payload, csrf) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
    };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload),
    });
    dlog(`POST search page → HTTP ${res.status}`);
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`SMC API HTTP ${res.status} — ${snippet}`);
    }
    return res.json();
  }

  // ── shipper price (revenue) ─────────────────────────────────────────────────
  // Port of CST_viewer scripts/smc_update.py _extract_revenue(): prefer the
  // LINE_HAUL line, else the first priced line.
  function pricingLines(order) {
    return ((order.shipperPricing || {}).pricing) || [];
  }
  function preferredLine(order) {
    const lines = pricingLines(order);
    if (!lines.length) return null;
    return lines.find((p) => p && p.type === "LINE_HAUL") || lines[0];
  }
  function extractRevenue(order) {
    const line = preferredLine(order);
    const v = line && line.price ? line.price.value : null;
    const n = v == null ? NaN : parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  // Currency varies by channel (GBP/EUR), so read it rather than assuming.
  function extractRevenueCurrency(order) {
    const line = preferredLine(order);
    const p = (line && line.price) || {};
    const c = p.currencyCode || p.currency || p.currencyUnit || null;
    return c ? String(c).trim().toUpperCase() : null;
  }

  // ── order -> one row per VRID ───────────────────────────────────────────────
  function orderToRows(order) {
    const stops = order.stops || [];
    const stop1 = stops[0] || {};
    const stop2 = stops.length > 1 ? stops[stops.length - 1] : {};
    const shipper = order.shipperDetails || {};
    const carrierDetails = order.carrierDetails || {};
    const origAddr = stop1.address || {};
    const destAddr = stop2.address || {};

    const base = {
      orderid: String(order.orderIdentifier?.id ?? ""),
      shipperid: String(shipper.shipperId ?? "").trim(),
      shippername: shipper.shipperName,
      shipper_ref: order.shipperReferenceId,
      // sourcing signals (SMC has no RLB1/DUMMY/AZNG — "needs sourcing" = no carrier yet)
      carrier_offer_count: order.carrierOfferCount ?? 0,
      has_carrier: !!(carrierDetails && (carrierDetails.carrierId || carrierDetails.carrierName)),
      order_status: order.orderStatus,
      scheduling_status: order.schedulingStatus,
      orig_country: origAddr.countryCode,
      dest_country: destAddr.countryCode,
      origin: stop1.stopName,
      dest: stop2.stopName,
      lane: `${stop1.stopName || ""} → ${stop2.stopName || ""}`,
      origin_code: stop1.stopLocationCode,
      dest_code: stop2.stopLocationCode,
      orig_node: stop1.stopLocationCode,
      dest_node: stop2.stopLocationCode,
      equipment_type: order.equipmentType,
      freight_type: order.freightType,
      vehicle_carrier: carrierDetails.carrierId,
      orig_planned_yard_checkin_time: stop1.startTime,
      dest_planned_yard_checkin_time: stop2.startTime,
      status: order.orderStatus,
      execution_status: order.executionStatus,
      vehicle_execution_status: order.vrExecutionStatus || order.executionStatus,
      isa: stop2.appointmentId,
      // Shipper price — what the margin calculator rates the carrier quote
      // against. Ports CST_viewer smc_update.py _extract_revenue().
      revenue: extractRevenue(order),
      revenue_currency: extractRevenueCurrency(order),
    };

    const vrids = (order.vehicleRunIds || []).filter(Boolean);
    const list = vrids.length ? vrids : [null];
    return list.map((vrid) => ({ ...base, vrid }));
  }

  /**
   * Fetch every order in the window (all pages), return flat rows (one per VRID).
   * `opts` is forwarded to buildPayload ({query, shipperIds}).
   */
  async function fetchRows(win, opts = {}) {
    const csrf = captureCsrf();
    dlog(csrf ? `csrf captured (len=${csrf.length})` : "no csrf token found on page");
    const w = resolveWindow(win);
    dlog(`window ${w.start} → ${w.end}`);
    const rows = [];
    const size = opts.pageSize || PAGE_SIZE;
    __lastRawOrders = [];
    let page = 1;
    while (true) {
      const data = await postSearch(buildPayload(page, w, opts), csrf);
      const orders = data.orders || [];
      __lastRawOrders.push(...orders);
      for (const o of orders) rows.push(...orderToRows(o));
      const total = data.pageResult?.totalRecords ?? orders.length;
      dlog(`page ${page}: ${orders.length} orders (total ${total}), rows so far ${rows.length}`);
      if (page * size >= total || page >= MAX_PAGES || orders.length === 0) break;
      page += 1;
    }
    return rows;
  }

  /**
   * Keep only rows that "still need sourcing", per the team's sourcing knobs
   * (Config.TEAMS[x].sourcing):
   *   requireVrid          manual sourcing is per-VRID, so no VRID = not a candidate
   *   requireNoCarrier     no carrier assigned in SMC (RLB1/AZNG/DUMMY placeholders
   *                        live in FMC, not SMC)
   *   excludeFreightTypes  e.g. CST drops LESS_THAN_TRUCKLOAD (LTL team owns those)
   */
  const DEFAULT_SOURCING = { requireVrid: true, requireNoCarrier: true, excludeFreightTypes: [] };

  function filterSourcing(rows, sourcing = DEFAULT_SOURCING) {
    const s = { ...DEFAULT_SOURCING, ...(sourcing || {}) };
    const excluded = new Set((s.excludeFreightTypes || []).map((v) => String(v).toUpperCase()));
    return rows.filter((r) => {
      if (s.requireVrid && String(r.vrid ?? "").trim() === "") return false;
      if (s.requireNoCarrier && r.has_carrier) return false;
      if (excluded.size && excluded.has(String(r.freight_type ?? "").toUpperCase())) return false;
      return true;
    });
  }

  /**
   * Fetch within `win` ({start,end}) + filter to orders still needing sourcing.
   * @param {{start,end}} win
   * @param {object} [opts]
   * @param {object} [opts.query]       andCriteria overrides for the team
   * @param {string[]} [opts.shipperIds] shipper allow-list (team SoT)
   * @param {object} [opts.sourcing]    post-filter knobs for the team
   * @param {object} [opts.shipperMap]  { shipperid: {shipper_group,...} } → tags rows
   */
  async function fetchSourcingRows(win, opts = {}) {
    const all = await fetchRows(win, { query: opts.query, shipperIds: opts.shipperIds });
    const filtered = filterSourcing(all, opts.sourcing);
    if (opts.shipperMap) {
      for (const r of filtered) {
        const s = opts.shipperMap[String(r.shipperid ?? "").trim()];
        r.shipper_group = s ? s.shipper_group : "";
      }
    }
    dlog(`fetched ${all.length} rows, ${filtered.length} still need sourcing`);
    return filtered;
  }

  /**
   * Look up specific orders/VRIDs regardless of sourcing state (e.g. a run that
   * already has a real carrier and so isn't on the list).
   *
   * SMC's search API has no by-ID filter we know of, so: (1) check the raw
   * orders from the most recent fetch (already in memory, free); (2) if any ID
   * is still missing, re-pull `win` (caller passes a wide window) with the
   * team's query at a large page size and match again.
   * @returns {{ rows, found: string[], missing: string[], source: "cache"|"smc" }}
   */
  async function lookupByIds(ids, win, opts = {}) {
    const wanted = new Set(ids.map((v) => String(v).trim()).filter(Boolean));
    if (!wanted.size) return { rows: [], found: [], missing: [], source: "cache" };
    const matches = (rows) =>
      rows.filter((r) => wanted.has(String(r.orderid ?? "").trim()) || wanted.has(String(r.vrid ?? "").trim()));
    const foundIds = (rows) => {
      const s = new Set();
      for (const r of rows) {
        if (wanted.has(String(r.orderid ?? "").trim())) s.add(String(r.orderid).trim());
        if (wanted.has(String(r.vrid ?? "").trim())) s.add(String(r.vrid).trim());
      }
      return s;
    };

    let rows = matches(__lastRawOrders.flatMap(orderToRows));
    let source = "cache";
    if (foundIds(rows).size < wanted.size) {
      dlog(`lookup: ${wanted.size - foundIds(rows).size} id(s) not in cache — re-pulling window`);
      const all = await fetchRows(win, { query: opts.query, shipperIds: opts.shipperIds, pageSize: 200 });
      rows = matches(all);
      source = "smc";
    }
    if (opts.shipperMap) {
      for (const r of rows) {
        const s = opts.shipperMap[String(r.shipperid ?? "").trim()];
        r.shipper_group = s ? s.shipper_group : "";
      }
    }
    const found = [...foundIds(rows)];
    const missing = [...wanted].filter((id) => !found.includes(id));
    dlog(`lookup: ${rows.length} row(s), found ${found.length}, missing ${missing.length} (${source})`);
    return { rows, found, missing, source };
  }

  // ── logged-in user (requester) from SMC config ──────────────────────────────
  // Same-origin fetch of /configuration/constants; the `requester` field is the
  // signed-in alias (e.g. "mayowas"). Cached after first success.
  let __requester = null;
  async function getRequester() {
    if (__requester) return __requester;
    try {
      const res = await fetch(
        "https://smc-eu-dub.dub.proxy.amazon.com/configuration/constants",
        { credentials: "include", headers: { accept: "application/json" } }
      );
      if (res.status !== 200) {
        dlog(`getRequester: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      __requester = data && data.requester ? String(data.requester).trim() : null;
      dlog(`getRequester: ${__requester || "(none)"}`);
      return __requester;
    } catch (e) {
      dlog(`getRequester failed: ${e.message}`);
      return null;
    }
  }

  // ── bridge: answer the background's smc:* messages ──────────────────────────
  // The UI is a standalone extension page (ui/app.html), so it can't fetch SMC
  // itself. The background finds/opens an SMC tab and sends these; we run the
  // same-origin fetch here and reply { bridge:true, ok, ... }.
  const fail = (err) => ({
    bridge: true,
    ok: false,
    status: (err && err.status) || 0,
    expired: !!(err && err.expired),
    error: String(err && err.message ? err.message : err),
  });

  async function ping() {
    const res = await fetch(
      "https://smc-eu-dub.dub.proxy.amazon.com/configuration/constants",
      { credentials: "include", headers: { accept: "application/json" } }
    );
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.redirected && !res.url.startsWith(location.origin)) {
      const e = new Error(`SMC session expired — redirected to ${res.url}`);
      e.status = 401; e.expired = true; throw e;
    }
    if (res.status === 401 || res.status === 403 || (res.status === 200 && !ctype.includes("json"))) {
      const e = new Error(`SMC session expired — HTTP ${res.status} (${ctype || "no content-type"})`);
      e.status = res.status === 200 ? 401 : res.status; e.expired = true; throw e;
    }
    if (res.status !== 200) {
      const e = new Error(`SMC ping HTTP ${res.status}`);
      e.status = res.status; throw e;
    }
    return res.status;
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("smc:")) return;
    dlog(`bridge ← ${msg.action}`);
    if (msg.action === "smc:ping") {
      return ping().then((status) => ({ bridge: true, ok: true, status })).catch(fail);
    }
    if (msg.action === "smc:requester") {
      return getRequester().then((requester) => ({ bridge: true, ok: true, requester })).catch(fail);
    }
    if (msg.action === "smc:lookup") {
      return lookupByIds(msg.ids || [], msg.win || {}, msg.opts || {})
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch((err) => {
          if (/HTTP (401|403)|redirected|Unexpected token/i.test(String(err && err.message))) {
            err.expired = true;
            err.status = err.status || 401;
          }
          return fail(err);
        });
    }
    if (msg.action === "smc:sourcingRows") {
      return fetchSourcingRows(msg.win || {}, msg.opts || {})
        .then((rows) => ({ bridge: true, ok: true, rows }))
        .catch((err) => {
          // A 200 that isn't JSON / a redirect means the session lapsed.
          if (/HTTP (401|403)|redirected|Unexpected token/i.test(String(err && err.message))) {
            err.expired = true;
            err.status = err.status || 401;
          }
          return fail(err);
        });
    }
    return fail(new Error(`Unknown smc action: ${msg.action}`));
  });
  browser.runtime.sendMessage({ action: "smc:bridge-ready", href: location.href }).catch(() => {});

  window.__ltlSmc = {
    fetchRows,
    fetchSourcingRows,
    filterSourcing,
    getRequester,
    rawOrders: () => __lastRawOrders,
  };
})();
