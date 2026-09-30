/**
 * Procurement Portal bridge — content-script side (P&G TMS Viewer).
 *
 * Runs on a procurementportal-eu.corp.amazon.com tab and POSTs a PO id to
 * /bp-api/search/po same-origin with the user's Midway session. The response
 * is the authoritative source for two things the TMS list only implies:
 *   • fcId          the delivery FC (destination node) — e.g. "XCD2"
 *   • handOffStart  PO delivery window start
 *   • handOffEnd    PO delivery window end = "Latest Vendor Delivery Date"
 *     (epoch millis; handOffEnd 1791244800000 == 2026-10-06T00:00Z, which the
 *      portal shows as 10/6/2026 01:00 GMT+1 — confirmed).
 *
 * The PO id is the BOL, i.e. the TMS "Customer Purchase Order", so every TMS
 * row already carries the key. Cookie-auth like SMC: a redirect to Midway or a
 * 200 that isn't JSON = expired session (tagged .expired so the caller can
 * offer a sign-in link).
 *
 * Bridge protocol (answered at the bottom): `portal:ping`, `portal:po`.
 */
(function () {
  "use strict";

  const ORIGIN = "https://procurementportal-eu.corp.amazon.com";
  const SEARCH_URL = `${ORIGIN}/bp-api/search/po`;
  const MAX_CONCURRENCY = 4;

  function dlog(...a) {
    if (window.__pgDebug) console.debug("[PG portal]", ...a);
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
    const e = new Error(`Procurement Portal session expired — ${extra}`);
    e.status = res && res.status === 200 ? 401 : (res && res.status) || 401;
    e.expired = true;
    return e;
  }

  async function safeFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const e = new Error(
        `Procurement Portal request failed (${err && err.message ? err.message : err}) — usually the ` +
          `Midway session expired and the call was redirected. Open the portal and retry.`
      );
      e.status = 0;
      e.expired = true;
      throw e;
    }
  }

  // Raw PO record for a single poId, or null when the portal has no such PO.
  async function fetchPoRaw(poId) {
    const csrf = captureCsrf();
    const headers = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
      headers["anti-csrftoken-a2z"] = csrf;
    }
    const res = await safeFetch(SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ orderId: String(poId) }),
      cache: "no-store",
    });
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.status === 200 && !ctype.includes("json")) throw sessionError(res, "sign-in page returned");
    if (res.status === 404) return null;
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      const e = new Error(`Procurement Portal HTTP ${res.status} — ${snippet}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json().catch(() => null);
    return data && data.poData ? data.poData : null;
  }

  // epoch millis → ISO, or "" when absent.
  const iso = (ms) => (ms == null ? "" : new Date(Number(ms)).toISOString());

  function poToRow(poId, p) {
    if (!p) return { poId, found: false };
    // Portal "Vendor Delivery Date" window, confirmed against the UI on two POs:
    //   Earliest Vendor Delivery Date = orderedOn
    //   Latest Vendor Delivery Date   = handOffEnd
    // both rendered in a FIXED GMT+1 (not DST-aware) — the UI shows e.g.
    // 1791244800000 (2026-10-06T00:00Z) as "10/6/2026, 1:00 AM GMT+1".
    return {
      poId: p.poId || poId,
      found: true,
      fcId: p.fcId || "", // delivery FC = destination node
      handOffType: p.handOffType || "",
      windowStart: iso(p.orderedOn), // = "Earliest Vendor Delivery Date"
      windowEnd: iso(p.handOffEnd), // = "Latest Vendor Delivery Date"
      windowStartMs: p.orderedOn ?? null,
      windowEndMs: p.handOffEnd ?? null,
      vendor: p.vendor || "",
      condition: p.poCondition || "",
      currency: p.foreignCurrencyCode || "",
      cancellationState: p.cancellationState || "",
    };
  }

  /** { poId: row } for several POs, MAX_CONCURRENCY at a time. */
  async function lookupPos(poIds) {
    const out = {};
    const queue = [...new Set((poIds || []).map((x) => String(x).trim()).filter(Boolean))];
    const worker = async () => {
      while (queue.length) {
        const poId = queue.shift();
        try {
          out[poId] = poToRow(poId, await fetchPoRaw(poId));
        } catch (e) {
          if (e.expired) throw e; // stop the whole batch on a session lapse
          out[poId] = { poId, found: false, error: e.message };
        }
      }
    };
    const n = Math.min(MAX_CONCURRENCY, queue.length) || 1;
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  async function ping() {
    // Cheapest reliable probe is the search endpoint itself with no body would
    // 400; instead hit the SPA root and check we stay on-origin as JSON/HTML.
    const res = await safeFetch(`${ORIGIN}/`, { credentials: "include", cache: "no-store" });
    if (res.redirected && !res.url.startsWith(location.origin)) throw sessionError(res, `redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw sessionError(res, `HTTP ${res.status}`);
    return res.status;
  }

  const fail = (err) => ({
    bridge: true,
    ok: false,
    status: (err && err.status) || 0,
    expired: !!(err && err.expired),
    error: String(err && err.message ? err.message : err),
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("portal:")) return;
    dlog(`bridge ← ${msg.action}`);
    if (msg.action === "portal:ping") {
      return ping().then((status) => ({ bridge: true, ok: true, status })).catch(fail);
    }
    if (msg.action === "portal:po") {
      return lookupPos(msg.poIds || [])
        .then((pos) => ({ bridge: true, ok: true, pos }))
        .catch(fail);
    }
    return fail(new Error(`Unknown portal action: ${msg.action}`));
  });
  browser.runtime.sendMessage({ action: "portal:bridge-ready", href: location.href }).catch(() => {});

  window.__pgPortal = { lookupPos, fetchPoRaw, ping };
})();
