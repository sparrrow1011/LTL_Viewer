/**
 * SMC client — delegates to the SMC-origin bridge (content/smc.js) and does
 * the TMS ↔ SMC matching.
 *
 * The overlay lives in the TMS frame and can't fetch SMC (different origin,
 * cookie session), so it asks the background, which finds/opens an SMC tab and
 * forwards the call. Same pattern as extension/background/smcClient.js.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { findLane } from "./lanesStore.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "smc",
  tabMatch: Config.SMC_TAB_MATCH,
  tabUrl: Config.SMC_TAB_URL,
  script: "content/smc.js",
});

/** Throws (with .expired) when the SMC session is gone. */
export async function ping() {
  await bridge.call({ action: "smc:ping" });
  return true;
}

/**
 * Signed-in SMC alias for the remote-control identity. Best-effort: returns
 * null when SMC is closed/unreachable so control never blocks on a network
 * blip (it just falls back to the install id).
 */
export async function getRequester() {
  try {
    const resp = await bridge.call({ action: "smc:requester" });
    return resp.requester || null;
  } catch {
    return null;
  }
}

/** All P&G orders in the window (one per SMC order). */
export async function fetchOrders(win, shipperIds) {
  const resp = await bridge.call({
    action: "smc:orders",
    win,
    opts: { query: Config.SMC_QUERY, shipperIds },
  });
  return { rows: resp.rows || [], meta: resp.meta || null };
}

const norm = (v) => String(v ?? "").trim().toUpperCase();

/**
 * SOP alignment checks between a TMS load and its SMC order.
 * Returns [{ level: "error"|"warn"|"info", msg }].
 *
 *  • BOL must equal the PO (P&G rule). Unknown when the SMC payload has no
 *    additionalReferenceIdList (search results may omit it) — then we say so
 *    once rather than flag every row.
 *  • SMC PO (commodity PURCHASE_ORDER_ID) should include the TMS PO.
 *  • Pickup stop should be the TMS origin site (Config.SITES[x].smcMatch
 *    keywords vs SMC stop name / location code / city).
 *  • ISA (destination appointmentId) should exist once the order is created.
 */
function alignOrder(load, order, laneLookup) {
  const out = [];
  const po = norm(load.po);

  if (order.bol === null) {
    out.push({ level: "info", msg: "BOL not readable from SMC — open the order to verify BOL = PO" });
  } else if (!order.bol) {
    out.push({ level: "warn", msg: "No BOL on the SMC order — BOL must be the PO" });
  } else if (po && norm(order.bol) !== po) {
    out.push({ level: "error", msg: `SMC BOL ${order.bol} ≠ PO ${load.po}` });
  }

  if (Array.isArray(order.pos) && po && order.pos.length && !order.pos.map(norm).includes(po)) {
    out.push({ level: "warn", msg: `SMC PO is ${order.pos.join(", ")}, TMS PO is ${load.po}` });
  }

  const site = Config.SITES[Config.SITE_CODES[load.site]];
  const hay = norm(
    [order.origin, order.origin_code, order.origin_city, order.origin_state].filter(Boolean).join(" | ")
  );
  if (site && site.smcMatch && hay) {
    const ok = site.smcMatch.some((k) => hay.includes(norm(k)));
    if (!ok) {
      const where = [order.origin || order.origin_code, order.origin_city, order.origin_state].filter(Boolean).join(", ");
      out.push({ level: "error", msg: `SMC picks up at "${where}", TMS site is ${site.name}` });
    }
  }

  if (!order.isa) out.push({ level: "warn", msg: "No ISA on the SMC order yet" });

  // Contracted lane: warn when the order's origin/destination isn't on one.
  // `laneLookup` is resolved by the caller (findLane is async because custom
  // lanes live in storage).
  const originCode = order.origin_code || (site && site.smcPickupCode);
  const destCode = order.dest_code;
  if (originCode && destCode) {
    if (!laneLookup) out.push({ level: "warn", msg: `No contracted lane ${originCode} → ${destCode}` });
    else if (laneLookup.validTo && laneLookup.validTo < new Date().toISOString().slice(0, 10))
      out.push({ level: "warn", msg: `Contracted lane expired ${laneLookup.validTo}` });
  }

  return out;
}

/**
 * For each TMS load, find its SMC order by Load ID == shipperReferenceId.
 *
 * @param {{loadId:string, crddIso?:string}[]} loads  extracted TMS rows
 * @param {{shipperIds:string[], windowPadDays:number}} settings
 * @returns {{ matches: Record<string, object>, unmatched: string[], meta, window }}
 */
export async function checkLoads(loads, settings) {
  const shipperIds = (settings.shipperIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!shipperIds.length) {
    const e = new Error(
      "No P&G shipper ID configured. Open Settings in the overlay and enter the SMC shipper account ID(s) first."
    );
    e.config = true;
    throw e;
  }

  // Origin window = [min CRDD − pad, max CRDD + pad]; SMC filters on the
  // pickup (origin) date, and the TMS CRDD column is "Shipment Pickup From".
  const pad = Number(settings.windowPadDays ?? Config.DEFAULT_SETTINGS.windowPadDays) * 86400_000;
  const times = loads.map((l) => (l.crddIso ? new Date(l.crddIso).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  const now = Date.now();
  const lo = times.length ? Math.min(...times) : now - 7 * 86400_000;
  const hi = times.length ? Math.max(...times) : now + 21 * 86400_000;
  const win = { start: new Date(lo - pad).toISOString(), end: new Date(hi + pad).toISOString() };

  const { rows, meta } = await fetchOrders(win, shipperIds);
  const byRef = new Map();
  for (const r of rows) {
    const key = norm(r.shipper_ref);
    if (!key) continue;
    // Several SMC orders can share a reference (re-created orders); keep them all.
    if (!byRef.has(key)) byRef.set(key, []);
    byRef.get(key).push(r);
  }

  // Pair each load with its SMC order(s) first …
  const pairs = [];
  const unmatched = [];
  for (const l of loads) {
    const key = norm(l.loadId);
    if (!key) continue;
    const hits = byRef.get(key);
    if (hits && hits.length) pairs.push({ load: l, orders: hits.map((h) => ({ ...h })) });
    else unmatched.push(l.loadId);
  }

  // … then, if the search payload omitted the BOL (bol === null), pull the
  // order detail for those matched orders so the BOL = PO check is real.
  const needDetail = pairs.flatMap((p) => p.orders).filter((o) => o.bol === null);
  let detailEndpoint = null;
  if (needDetail.length) {
    try {
      const { details, endpoint } = await fetchDetails(needDetail.map((o) => o.orderid));
      detailEndpoint = endpoint;
      for (const o of needDetail) {
        const d = details[o.orderid];
        if (!d) continue;
        // Detail wins for the reference fields; keep search values otherwise.
        for (const k of ["bol", "pos", "pallets", "isa", "equipment_type", "carrier", "has_carrier", "vrids"]) {
          if (d[k] !== null && d[k] !== undefined && d[k] !== "" && !(Array.isArray(d[k]) && !d[k].length)) o[k] = d[k];
        }
        if (o.bol === null) o.bol = ""; // detail seen but no BOL on it → genuinely missing
      }
      log.info("smc", `order detail fetched for ${Object.keys(details).length}/${needDetail.length} order(s)` + (endpoint ? ` via ${endpoint}` : " (no endpoint answered)"));
    } catch (e) {
      if (e.expired) throw e;
      log.warn("smc", `order detail enrichment failed: ${e.message}`);
    }
  }

  const matches = {};
  for (const p of pairs) {
    const orders = [];
    for (const h of p.orders) {
      const site = Config.SITES[Config.SITE_CODES[p.load.site]];
      const originCode = h.origin_code || (site && site.smcPickupCode);
      const lane = originCode && h.dest_code ? await findLane(originCode, h.dest_code) : null;
      orders.push({ ...h, url: Config.SMC_ORDER_URL(h.orderid), checks: alignOrder(p.load, h, lane) });
    }
    matches[p.load.loadId] = { orders };
  }
  log.info(
    "smc",
    `checked ${loads.length} load(s) against ${rows.length} SMC order(s): ${Object.keys(matches).length} exist, ${unmatched.length} new` +
      (meta && meta.truncated ? " (SMC result TRUNCATED)" : "")
  );
  return { matches, unmatched, meta, window: win, smcOrders: rows.length, detailEndpoint };
}

/**
 * Resolve stop names / node codes to SMC locations (what the create form does).
 * @returns {Promise<Record<string, object[]|{error}>>} keyed by upper-cased name
 */
export async function lookupLocations(names) {
  const resp = await bridge.call({ action: "smc:locations", names });
  return resp.locations || {};
}

/** Distance between two postal codes via /mileage/calculate → { value, unit }. */
export async function mileage(from, to) {
  const resp = await bridge.call({ action: "smc:mileage", from, to });
  return { value: resp.value || 0, unit: resp.unit || "KM" };
}

/** POST /shipper/order/createV3/ → { orderId, response, status }. */
export async function createOrder(payload) {
  const resp = await bridge.call({ action: "smc:createOrder", payload });
  return { orderId: resp.orderId || null, response: resp.response, status: resp.status };
}

/** Transit time (seconds) between two SMC node codes → { seconds }. */
export async function transitTime(originCode, destCode, shipperId) {
  const resp = await bridge.call({ action: "smc:transit", originCode, destCode, shipperId });
  return { seconds: resp.seconds ?? null };
}

/** Order-detail rows for the given SMC order ids (fields the search omits). */
export async function fetchDetails(ids) {
  const resp = await bridge.call({ action: "smc:details", ids });
  return { details: resp.details || {}, endpoint: resp.endpoint || null };
}
