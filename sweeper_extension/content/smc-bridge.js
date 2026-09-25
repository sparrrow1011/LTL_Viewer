/**
 * SMC bridge — a content script injected into the SMC origin.
 *
 * Replaces CST_viewer's `cst_runs` table as the source of (orderid, vrid)
 * pairs for the Paragon sweep (fmc_update.py fetch_paragon_queries). Runs ON
 * the SMC page and replays /shipper/order/search same-origin with the user's
 * session (trimmed port of MS Viewer's content/smc.js).
 *
 * Message contract (from background):
 *   { action:"smc:ping" }                              -> { bridge, ok, status }
 *   { action:"smc:pairs", window:{start,end}, query }  -> { bridge, ok, pairs, orders }
 *     pairs: [{ orderid, vrid, shipper, origin, dest, checkin, status }]
 */
(function () {
  "use strict";

  // No "already injected" guard — see paragon-bridge.js for why (orphaned
  // copies after an extension reload would block re-injection).

  const ORIGIN = "https://smc-eu-dub.dub.proxy.amazon.com";
  const SEARCH_URL = `${ORIGIN}/shipper/order/search`;
  // CST_viewer scrapers/smc.py: PAGE_SIZE = 200, shipperIds capped at 1000.
  const PAGE_SIZE = 200;
  const MAX_PAGES = 200;
  const MAX_SHIPPER_IDS = 1000;

  let trace = [];
  const dlog = (...a) => {
    trace.push(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    console.debug("[LobbySweeper smc]", ...a);
  };

  const DEFAULT_QUERY = {
    orderSources: ["SMC", "EDI", "R4S", "AFAPI", "AFDIG"],
    freightTypes: ["LESS_THAN_TRUCKLOAD", "TRUCKLOAD", "INTERMODAL"],
    orderExecutionStatuses: [
      "IN_DRAFT", "NOT_PLANNED", "PENDING_CARRIER_ACCEPTANCE", "CARRIER_TENDER_ACCEPTED",
      "DRIVER_DISPATCHED", "LATE_TO_ARRIVE", "ARRIVED", "LATE_TO_DEPART", "DEPARTED",
      "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED", "PENDING_PAYMENT", "PAID",
      "CANCELLED", "REJECTED",
    ],
    shipperBusinessChannels: [],
    readyForScheduling: null,
  };

  const isoZ = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, ".000Z");

  function buildPayload(page, win, query, shipperIds) {
    const q = { ...DEFAULT_QUERY, ...(query || {}) };
    const andCriteria = {
      orderSources: q.orderSources,
      freightTypes: q.freightTypes,
      orderExecutionStatuses: q.orderExecutionStatuses,
      shipperBusinessChannels: q.shipperBusinessChannels || [],
      originDateRangeLabel: null,
      originDateRange: { start: isoZ(win.start), end: isoZ(win.end) },
    };
    if (q.readyForScheduling != null) andCriteria.readyForScheduling = q.readyForScheduling;
    // The CST filter (smc.py and_c["shipperIds"] = shipper_ids).
    if (shipperIds && shipperIds.length) andCriteria.shipperIds = shipperIds.slice(0, MAX_SHIPPER_IDS);
    return {
      sortCriteria: [{ field: "ORDER_CREATION_DATE", sortDirection: "DESC" }],
      andCriteria,
      orCriteria: {},
      pageCriteria: { page, size: PAGE_SIZE, totalRecords: 0 },
    };
  }

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

  function assertApiResponse(res) {
    const onOrigin = !res.url || res.url.startsWith(ORIGIN);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const expired = (why, status = 401) => {
      const err = new Error(`SMC session expired — ${why}`);
      err.status = status;
      err.expired = true;
      return err;
    };
    if (res.redirected && !onOrigin) throw expired(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expired(`HTTP ${res.status}`, res.status);
    if (res.status === 200 && !ctype.includes("json")) throw expired(`non-JSON reply (${ctype || "none"})`);
  }

  async function postSearch(payload, csrf) {
    const headers = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    dlog(`POST /shipper/order/search page ${payload.pageCriteria.page} (csrf ${csrf ? "yes" : "no"})`);
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload),
    });
    dlog(
      `← HTTP ${res.status} ${res.redirected ? `(redirected to ${res.url}) ` : ""}content-type=${
        res.headers.get("content-type") || "none"
      }`
    );
    assertApiResponse(res);
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      dlog(`body: ${snippet}`);
      const err = new Error(`SMC API HTTP ${res.status} — ${snippet}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // One row per VRID on the order; orders with no VRID yet come back with
  // vrid:"" so the FMC step can try to resolve them and Paragon can still be
  // searched by orderid.
  function orderToPairs(order) {
    const stops = order.stops || [];
    const s1 = stops[0] || {};
    const s2 = stops.length > 1 ? stops[stops.length - 1] : {};
    const shipper = order.shipperDetails || {};
    const orderid = String(order.orderIdentifier?.id ?? "").trim();
    if (!orderid) return [];
    const vrids = (order.vehicleRunIds || []).map((v) => String(v).trim()).filter(Boolean);
    const base = {
      orderid,
      shipperid: String(shipper.shipperId ?? "").trim(),
      shipper: shipper.shipperName || "",
      origin: s1.stopName || s1.stopLocationCode || "",
      dest: s2.stopName || s2.stopLocationCode || "",
      checkin: s1.startTime || "",
      status: order.orderStatus || "",
    };
    return (vrids.length ? vrids : [""]).map((vrid) => ({ ...base, vrid }));
  }

  async function fetchPairs(win, query, shipperIds) {
    const csrf = captureCsrf();
    const pairs = [];
    let orders = 0;
    let page = 1;
    let total = 0;
    for (;;) {
      const data = await postSearch(buildPayload(page, win, query, shipperIds), csrf);
      const list = data.orders || [];
      orders += list.length;
      for (const o of list) pairs.push(...orderToPairs(o));
      total = data.pageResult?.totalRecords ?? list.length;
      dlog(`page ${page}: ${list.length} orders (total ${total}), rows so far ${pairs.length}`);
      if (page * PAGE_SIZE >= total || page >= MAX_PAGES || !list.length) break;
      page += 1;
    }
    return { pairs, orders, total, truncated: orders < total };
  }

  // cache:"no-store" matters: a GET can be answered from the HTTP cache with no
  // network at all, making a dead connection look "live" (seen 2026-09-25 —
  // ping ok, the search POST then failed with NetworkError until the tab was
  // reloaded).
  async function ping() {
    const res = await fetch(`${ORIGIN}/configuration/constants`, {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    assertApiResponse(res);
    return res.status;
  }

  const takeTrace = () => {
    const t = trace;
    trace = [];
    return t;
  };
  const ok = (extra) => ({ bridge: true, ok: true, trace: takeTrace(), ...extra });
  const fail = (err) => {
    dlog(`FAILED: ${err && err.message ? err.message : err}`);
    return {
      bridge: true,
      ok: false,
      status: (err && err.status) || 0,
      expired: !!(err && err.expired),
      error: String(err && err.message ? err.message : err),
      trace: takeTrace(),
    };
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("smc:")) return;
    trace = [];
    dlog(`${msg.action} on ${location.href}`);
    if (msg.action === "smc:ping") {
      return ping()
        .then((status) => (status === 200 ? ok({ status }) : fail(Object.assign(new Error(`ping HTTP ${status}`), { status }))))
        .catch(fail);
    }
    if (msg.action === "smc:pairs") {
      const win = msg.window || {};
      if (!win.start || !win.end) return fail(new Error("smc:pairs needs window.start/end"));
      dlog(
        `window ${win.start} → ${win.end}; shipperIds ${(msg.shipperIds || []).length}; freightTypes ${(
          (msg.query && msg.query.freightTypes) || []
        ).join("/")}`
      );
      return fetchPairs(win, msg.query, msg.shipperIds || [])
        .then((r) => {
          dlog(`done: ${r.orders}/${r.total} orders → ${r.pairs.length} rows`);
          return ok(r);
        })
        .catch(fail);
    }
    return fail(new Error(`Unknown smc action: ${msg.action}`));
  });

  browser.runtime.sendMessage({ action: "smc:bridge-ready", href: location.href }).catch(() => {});
  console.info("[LobbySweeper] SMC bridge ready on", location.origin);
})();
