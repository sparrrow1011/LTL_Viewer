/**
 * SMC data source — content-script side (P&G TMS Viewer).
 *
 * Runs on an SMC tab and fetches /shipper/order/search same-origin with the
 * page's own session cookies. Trimmed port of extension/content/smc.js
 * (LTL_Viewer): here we only need one order per row with the fields that
 * answer "does this TMS Load ID already have an SMC order, and in what state?".
 *
 * Bridge protocol (answered at the bottom): `smc:ping`, `smc:orders`.
 * Replies are { bridge:true, ok, ... }; failures carry status / expired.
 */
(function () {
  "use strict";

  const ORIGIN = "https://smc-eu-dub.dub.proxy.amazon.com";
  const SEARCH_URL = `${ORIGIN}/shipper/order/search`;
  const CONSTANTS_URL = `${ORIGIN}/configuration/constants`;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;
  const MAX_SHIPPER_IDS = 1000;

  function dlog(...a) {
    if (window.__pgDebug) console.debug("[PG smc]", ...a);
  }

  // ── window: caller passes ISO-ish bounds; normalise to ".000Z" ──────────────
  const zulu = (d) => d.toISOString().replace(/\.\d+Z$/, ".000Z");
  function resolveWindow(win) {
    const now = Date.now();
    const def = { start: zulu(new Date(now - 7 * 86400_000)), end: zulu(new Date(now + 21 * 86400_000)) };
    if (!win) return def;
    const norm = (v, kind, fallback) => {
      if (!v) return fallback;
      const s = String(v);
      const d = s.includes("T")
        ? new Date(s)
        : new Date(`${s.slice(0, 10)}${kind === "start" ? "T00:00:00.000Z" : "T23:59:59.000Z"}`);
      return Number.isNaN(d.getTime()) ? fallback : zulu(d);
    };
    return { start: norm(win.start, "start", def.start), end: norm(win.end, "end", def.end) };
  }

  // ── payload ─────────────────────────────────────────────────────────────────
  function buildPayload(page, win, opts) {
    const q = opts.query || {};
    const andCriteria = {
      orderSources: q.orderSources || ["SMC", "EDI", "R4S", "AFAPI", "AFDIG"],
      freightTypes: q.freightTypes || ["TRUCKLOAD", "LESS_THAN_TRUCKLOAD", "INTERMODAL"],
      orderExecutionStatuses: q.orderExecutionStatuses || [],
      shipperBusinessChannels: q.shipperBusinessChannels || [],
      originDateRangeLabel: null,
      originDateRange: win,
    };
    if (q.readyForScheduling != null) andCriteria.readyForScheduling = q.readyForScheduling;
    if (opts.shipperIds && opts.shipperIds.length) {
      andCriteria.shipperIds = opts.shipperIds.slice(0, MAX_SHIPPER_IDS);
    }
    return {
      sortCriteria: [{ field: "ORDER_CREATION_DATE", sortDirection: "DESC" }],
      andCriteria,
      orCriteria: {},
      pageCriteria: { page, size: PAGE_SIZE },
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

  function sessionError(res, extra) {
    const e = new Error(`SMC session expired — ${extra}`);
    e.status = res && res.status === 200 ? 401 : (res && res.status) || 401;
    e.expired = true;
    return e;
  }

  // fetch() throws a bare TypeError ("NetworkError when attempting to fetch
  // resource") when the request is redirected off-origin (Midway sign-in) or
  // the tab is half-dead. Treat it as an expired session: the background then
  // reloads the SMC tab (SSO re-issues the cookie) and retries once.
  async function safeFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const e = new Error(
        `SMC request failed (${err && err.message ? err.message : err}) — usually the SMC session ` +
          `expired and the call was redirected to Midway. Sign in to SMC and retry.`
      );
      e.status = 0;
      e.expired = true;
      throw e;
    }
  }

  async function postSearch(payload, csrf) {
    const headers = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    const res = await safeFetch(SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    dlog(`POST search → HTTP ${res.status}`);
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.status === 200 && !ctype.includes("json")) throw sessionError(res, "sign-in page returned");
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      const e = new Error(`SMC API HTTP ${res.status} — ${snippet}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  // ── order → one flat row (we match on the order, not per VRID) ──────────────
  // Tolerates both SMC shapes: the search result (flat: orderIdentifier,
  // shipperReferenceId string, vehicleRunIds[]) and the order detail
  // (orderId, orderDetails.{...}, shipperReferenceId {type,id}, vrId).
  const refId = (v) => (v && typeof v === "object" ? v.id : v);
  const attr = (stop, type) => ((stop.stopAttributes || []).find((a) => a.type === type) || {}).value;

  function orderToRow(order) {
    const d = order.orderDetails || order;
    const stops = d.stops || order.stops || [];
    const stop1 = stops[0] || {};
    const stop2 = stops.length > 1 ? stops[stops.length - 1] : {};
    const shipper = d.shipperDetails || {};
    const carrier = d.carrierDetails || order.carrierDetails || {};
    const refList = d.additionalReferenceIdList;
    const bol = Array.isArray(refList)
      ? (refList.find((r) => r.type === "BILL_OF_LADING_NUMBER") || {}).id || ""
      : null; // null = field absent in this shape → unknown, not "missing"
    const pos = Array.isArray(d.commodities)
      ? [
          ...new Set(
            d.commodities
              .flatMap((c) => [c.referenceId, ...(c.referenceIds || [])])
              .filter((r) => r && r.type === "PURCHASE_ORDER_ID" && r.id)
              .map((r) => String(r.id).trim())
          ),
        ]
      : null;
    const vrids = (order.vehicleRunIds || []).filter(Boolean);
    if (!vrids.length && order.vrId) vrids.push(order.vrId);
    return {
      orderid: String(order.orderIdentifier?.id ?? order.orderId?.id ?? ""),
      shipperid: String(shipper.shipperId ?? "").trim(),
      shippername: shipper.shipperName,
      shipper_ref: String(refId(d.shipperReferenceId) ?? "").trim(), // == TMS Load ID
      order_status: order.orderStatus,
      execution_status: order.executionStatus,
      scheduling_status: order.schedulingStatus,
      freight_type: d.freightType,
      equipment_type: d.equipmentType,
      has_carrier: !!(carrier && (carrier.carrierId || carrier.carrierName)),
      carrier: (carrier && (carrier.carrierId || carrier.carrierName)) || "",
      vrids,
      origin: stop1.stopName,
      origin_code: stop1.stopLocationCode,
      origin_city: attr(stop1, "CITY"),
      origin_state: attr(stop1, "STATE"), // P&G Amiens shows up here ("Amiens"), city is Poulainville
      origin_country: attr(stop1, "COUNTRY_CODE"),
      dest: stop2.stopName,
      dest_code: stop2.stopLocationCode,
      pickup_time: stop1.startTime,
      pickup_tz: stop1.timeZone && stop1.timeZone.id,
      delivery_time: stop2.appointmentTime || stop2.startTime,
      isa: stop2.appointmentId || "",
      bol, // "" = present but empty, null = not in this payload
      pos, // PURCHASE_ORDER_ID list, or null when commodities absent
      pallets: Array.isArray(d.commodities)
        ? d.commodities.reduce((n, c) => n + (Number(c.handlingDetails?.unit) || 0), 0)
        : null,
    };
  }

  // Raw orders from the most recent fetch — diagnostics only. In the SMC tab's
  // console: __pgSmc.rawOrder("<shipper reference / Load ID>") or rawOrders().
  let __lastRawOrders = [];

  /** Fetch every order in `win` for the given shipper IDs (all pages). */
  async function fetchOrders(win, opts = {}) {
    const csrf = captureCsrf();
    const w = resolveWindow(win);
    dlog(`window ${w.start} → ${w.end}, shipperIds=${(opts.shipperIds || []).length}`);
    const rows = [];
    __lastRawOrders = [];
    let page = 1;
    let total = 0;
    let truncated = false;
    while (true) {
      const data = await postSearch(buildPayload(page, w, opts), csrf);
      const orders = data.orders || [];
      __lastRawOrders.push(...orders);
      for (const o of orders) rows.push(orderToRow(o));
      total = data.pageResult?.totalRecords ?? orders.length;
      dlog(`page ${page}: ${orders.length} orders (total ${total})`);
      if (page * PAGE_SIZE >= total || orders.length === 0) break;
      if (page >= MAX_PAGES) {
        truncated = true;
        console.warn(`[PG smc] stopped at the ${MAX_PAGES}-page cap (${rows.length} of ${total})`);
        break;
      }
      page += 1;
    }
    return { rows, meta: { total, fetched: rows.length, pages: page, truncated, window: w } };
  }

  // ── order detail (for fields the search result may omit: BOL, PO, pallets) ──
  // The UI route is /order/<id>; the JSON endpoint behind it isn't documented,
  // so try a few likely paths once and remember the one that returns order
  // JSON. If none does, callers keep bol === null and the UI says so.
  const DETAIL_CANDIDATES = [
    (id) => `${ORIGIN}/shipper/order/${encodeURIComponent(id)}`,
    (id) => `${ORIGIN}/shipper/order/get/${encodeURIComponent(id)}`,
    (id) => `${ORIGIN}/shipper/order/details/${encodeURIComponent(id)}`,
    (id) => `${ORIGIN}/shipper/order?orderId=${encodeURIComponent(id)}`,
  ];
  let detailBuilder = null; // pinned after the first success
  let detailUnavailable = false; // all candidates failed for this page load

  function looksLikeOrder(j) {
    return !!(j && typeof j === "object" && (j.orderDetails || j.orderIdentifier || j.orderId));
  }

  async function fetchDetailOnce(url) {
    const res = await safeFetch(url, {
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*" },
      cache: "no-store",
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    if (res.status !== 200 || !ctype.includes("json")) return null; // wrong path, not a session issue
    const j = await res.json().catch(() => null);
    // Some APIs wrap: { order: {...} }
    const o = looksLikeOrder(j) ? j : j && looksLikeOrder(j.order) ? j.order : null;
    return o;
  }

  async function fetchDetail(id) {
    if (detailUnavailable) return null;
    if (detailBuilder) return fetchDetailOnce(detailBuilder(id));
    for (const build of DETAIL_CANDIDATES) {
      const o = await fetchDetailOnce(build(id));
      if (o) {
        detailBuilder = build;
        dlog(`order detail endpoint pinned: ${build("<id>")}`);
        return o;
      }
    }
    detailUnavailable = true;
    console.warn("[PG smc] no order-detail endpoint answered; tried", DETAIL_CANDIDATES.map((b) => b("<id>")));
    return null;
  }

  /** Detail rows for several order ids (4 at a time). Missing ones are skipped. */
  async function fetchDetails(ids) {
    const out = {};
    const queue = [...new Set((ids || []).map(String).filter(Boolean))];
    // Pin the endpoint with the first id before fanning out, otherwise every
    // worker probes all candidates at once.
    if (queue.length && !detailBuilder && !detailUnavailable) {
      const id = queue.shift();
      const o = await fetchDetail(id);
      if (o) out[id] = orderToRow(o);
    }
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const o = await fetchDetail(id);
          if (o) out[id] = orderToRow(o);
        } catch (e) {
          if (e.expired) throw e;
          dlog(`detail ${id} failed: ${e.message}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { details: out, endpoint: detailBuilder ? detailBuilder("<id>") : null };
  }

  // ── location search (what the create-order form does when you type a stop) ──
  // POST /shipper/location/search/ { name } → [ { nodeCode, locationType,
  // locationName, shipperId, capabilities:[{type, addressIdentifier}], addressContent } ]
  const LOCATION_URL = `${ORIGIN}/shipper/location/search/`;
  const __locCache = new Map();
  const clean = (s) => (s == null ? "" : String(s).replace(/\u00a0/g, " ").trim());

  function locationToRow(n) {
    const caps = {};
    for (const c of n.capabilities || []) {
      if (c && c.type && c.addressIdentifier) caps[c.type] = c.addressIdentifier;
    }
    const a = n.addressContent || {};
    return {
      nodeCode: n.nodeCode || "",
      locationName: n.locationName || a.name || "",
      locationType: n.locationType || "",
      shipperId: n.shipperId || null,
      addresses: caps, // { GENERAL, PICKUP, DELIVERY } → { addressId, marketplaceId }
      city: a.city || "",
      state: a.stateOrRegion || "",
      postalCode: a.postalCode || "",
      country: a.country || "",
      addressLine: [a.addressLine1, a.addressLine2, a.addressLine3].filter(Boolean).join(", "),
    };
  }

  async function searchLocation(name) {
    const key = clean(name).toUpperCase();
    if (!key) return [];
    if (__locCache.has(key)) return __locCache.get(key);
    const csrf = captureCsrf();
    const headers = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    let res = await safeFetch(LOCATION_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ name: key }),
      cache: "no-store",
    });
    // Unknown method/shape? Try the GET form once before giving up.
    if (res.status === 404 || res.status === 405 || res.status === 400) {
      res = await safeFetch(`${LOCATION_URL}?name=${encodeURIComponent(key)}`, {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
    }
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    if (res.status !== 200) {
      const e = new Error(`SMC location search HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const j = await res.json().catch(() => null);
    const list = Array.isArray(j) ? j : Array.isArray(j && j.locations) ? j.locations : [];
    const rows = list.map(locationToRow);
    __locCache.set(key, rows);
    dlog(`location "${key}": ${rows.length} result(s)`);
    return rows;
  }

  /** { name: rows[] } for several names, 3 at a time. */
  async function searchLocations(names) {
    const out = {};
    const queue = [...new Set((names || []).map((n) => clean(n).toUpperCase()).filter(Boolean))];
    const worker = async () => {
      while (queue.length) {
        const n = queue.shift();
        try {
          out[n] = await searchLocation(n);
        } catch (e) {
          if (e.expired) throw e;
          out[n] = { error: e.message };
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  // ── generic same-origin JSON POST (mileage, createV3) ───────────────────────
  async function postJson(url, payload) {
    const csrf = captureCsrf();
    const headers = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    const res = await safeFetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (res.status < 200 || res.status >= 300) {
      const e = new Error(`SMC ${new URL(url).pathname} HTTP ${res.status} — ${text.slice(0, 400)}`);
      e.status = res.status;
      e.body = text.slice(0, 2000);
      throw e;
    }
    return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
  }

  const MILEAGE_URL = `${ORIGIN}/mileage/calculate`;
  const CREATE_URL = `${ORIGIN}/shipper/order/createV3/`;
  const TRANSIT_URL = `${ORIGIN}/transit-time/calculate`;

  // Transit time (seconds) between two SMC node codes. Response:
  // { driverType, transitTimeInSeconds }. Returns { seconds }.
  async function transitTime(originCode, destCode, shipperId) {
    const { json } = await postJson(TRANSIT_URL, {
      originLocation: { type: "nodeLocation", nodeCode: originCode },
      destinationLocation: { type: "nodeLocation", nodeCode: destCode },
      shipperId: String(shipperId || ""),
    });
    const secs = json && (json.transitTimeInSeconds ?? findNumber(json, ["transitTimeInSeconds", "seconds"]));
    return { seconds: Number.isFinite(secs) ? secs : null, raw: json };
  }

  // Distance between two postal codes, as the create form computes it.
  // Response shape not captured — take the first numeric "value" we can find.
  async function mileage(from, to) {
    const { json } = await postJson(MILEAGE_URL, {
      locations: [
        { type: "postalCodeLocation", postalCode: from.postalCode, countryCode: from.countryCode },
        { type: "postalCodeLocation", postalCode: to.postalCode, countryCode: to.countryCode },
      ],
    });
    const found = findNumber(json, ["value", "distance", "mileage", "km"]);
    const unit = (findString(json, ["unit"]) || "KM").toUpperCase();
    return { value: found == null ? 0 : Math.round(found), unit: found == null ? "KM" : unit, raw: json };
  }

  function findNumber(obj, keys, depth = 0) {
    if (obj == null || depth > 5) return null;
    if (typeof obj === "number") return obj;
    if (typeof obj === "string" && /^\d+(\.\d+)?$/.test(obj)) return parseFloat(obj);
    if (Array.isArray(obj)) {
      for (const x of obj) {
        const n = findNumber(x, keys, depth + 1);
        if (n != null) return n;
      }
      return null;
    }
    if (typeof obj === "object") {
      for (const k of keys) if (obj[k] != null && typeof obj[k] !== "object") return findNumber(obj[k], keys, depth + 1);
      for (const v of Object.values(obj)) {
        const n = findNumber(v, keys, depth + 1);
        if (n != null) return n;
      }
    }
    return null;
  }
  function findString(obj, keys, depth = 0) {
    if (obj == null || depth > 5 || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const x of obj) {
        const s = findString(x, keys, depth + 1);
        if (s) return s;
      }
      return null;
    }
    for (const k of keys) if (typeof obj[k] === "string" && obj[k]) return obj[k];
    for (const v of Object.values(obj)) {
      const s = findString(v, keys, depth + 1);
      if (s) return s;
    }
    return null;
  }

  // Create an order (the payload the form sends; status "DRAFT" → reviewable in SMC).
  async function createOrder(payload) {
    const { json, text, status } = await postJson(CREATE_URL, payload);
    // Response shape not captured; the id showed up as "orderId" in follow-up
    // calls, so look for that first.
    const orderId =
      (json && (json.orderId?.id || json.orderId || json.id || json.orderIdentifier?.id)) ||
      (typeof json === "string" && /^\d{6,}$/.test(json) ? json : null) ||
      (text && /^\s*"?(\d{6,})"?\s*$/.test(text) ? text.match(/(\d{6,})/)[1] : null);
    dlog(`createV3 → HTTP ${status}, orderId=${orderId}`);
    return { orderId: orderId ? String(orderId) : null, response: json ?? text ?? null, status };
  }

  // Signed-in SMC alias (e.g. "mayowas") from /configuration/constants — used
  // as the remote-control identity. Cached after first success.
  let __requester = null;
  async function getRequester() {
    if (__requester) return __requester;
    try {
      const res = await fetch(CONSTANTS_URL, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (res.status !== 200) return null;
      const data = await res.json().catch(() => null);
      __requester = data && data.requester ? String(data.requester).trim() : null;
      return __requester;
    } catch {
      return null;
    }
  }

  async function ping() {
    const res = await safeFetch(CONSTANTS_URL, {
      credentials: "include",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403 || (res.status === 200 && !ctype.includes("json"))) {
      throw sessionError(res, `HTTP ${res.status} (${ctype || "no content-type"})`);
    }
    if (res.status !== 200) {
      const e = new Error(`SMC ping HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.status;
  }

  // ── bridge ──────────────────────────────────────────────────────────────────
  const fail = (err) => ({
    bridge: true,
    ok: false,
    status: (err && err.status) || 0,
    expired: !!(err && err.expired),
    error: String(err && err.message ? err.message : err),
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("smc:")) return;
    dlog(`bridge ← ${msg.action}`);
    if (msg.action === "smc:ping") {
      return ping().then((status) => ({ bridge: true, ok: true, status })).catch(fail);
    }
    if (msg.action === "smc:requester") {
      return getRequester().then((requester) => ({ bridge: true, ok: true, requester })).catch(fail);
    }
    if (msg.action === "smc:orders") {
      return fetchOrders(msg.win || null, msg.opts || {})
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch((err) => {
          if (/Unexpected token|JSON/i.test(String(err && err.message)) && !err.expired) {
            err.expired = true; // a 200 that isn't JSON = sign-in page
            err.status = err.status || 401;
          }
          return fail(err);
        });
    }
    if (msg.action === "smc:details") {
      return fetchDetails(msg.ids || [])
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch(fail);
    }
    if (msg.action === "smc:locations") {
      return searchLocations(msg.names || [])
        .then((locations) => ({ bridge: true, ok: true, locations }))
        .catch(fail);
    }
    if (msg.action === "smc:mileage") {
      return mileage(msg.from || {}, msg.to || {})
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch(fail);
    }
    if (msg.action === "smc:transit") {
      return transitTime(msg.originCode, msg.destCode, msg.shipperId)
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch(fail);
    }
    if (msg.action === "smc:createOrder") {
      return createOrder(msg.payload || {})
        .then((r) => ({ bridge: true, ok: true, ...r }))
        .catch((err) => ({ ...fail(err), body: err && err.body }));
    }
    return fail(new Error(`Unknown smc action: ${msg.action}`));
  });
  browser.runtime.sendMessage({ action: "smc:bridge-ready", href: location.href }).catch(() => {});

  window.__pgSmc = {
    fetchOrders,
    fetchDetail,
    fetchDetails,
    searchLocation,
    searchLocations,
    mileage,
    transitTime,
    createOrder,
    ping,
    getRequester,
    orderToRow,
    rawOrders: () => __lastRawOrders,
    // One raw order by shipper reference (TMS Load ID) or SMC order id, as JSON text.
    rawOrder: (ref) => {
      const key = String(ref).trim().toUpperCase();
      const o = __lastRawOrders.find(
        (x) =>
          String(x.shipperReferenceId ?? "").trim().toUpperCase() === key ||
          String(x.orderIdentifier?.id ?? "") === key
      );
      return o ? JSON.stringify(o, null, 1) : `no order with reference/id ${ref} in the last fetch`;
    },
  };
})();
