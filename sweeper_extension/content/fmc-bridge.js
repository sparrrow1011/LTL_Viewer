/**
 * FMC bridge — content script on trans-logistics-eu.amazon.com.
 *
 * Step 3 of the pipeline: confirm the VRIDs SMC reported (and try to resolve
 * VRIDs for orders SMC shows without one) via FMC's by-id search. Port of
 * CST_viewer scrapers/fmc_api.py (POST /fmc/search/execution/by-id,
 * searchByIds, ≤50 ids per request), trimmed from MS Viewer's fmc-bridge.js.
 *
 * Message contract:
 *   { action:"fmc:ping" }                 -> { bridge, ok, status }
 *   { action:"fmc:byId", ids:string[] }   -> { bridge, ok, records:[{vrid,status,carrier,tour,orderIds,...}] }
 */
(function () {
  "use strict";

  const ORIGIN = "https://trans-logistics-eu.amazon.com";
  const API_URL = `${ORIGIN}/fmc/search/execution/by-id`;
  const BATCH_SIZE = 50;

  let trace = [];
  const dlog = (...a) => {
    trace.push(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    console.debug("[LobbySweeper fmc]", ...a);
  };

  function assertApiResponse(res) {
    const onOrigin = !res.url || res.url.startsWith(ORIGIN);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const expired = (why, status = 401) => {
      const err = new Error(`FMC session expired — ${why}`);
      err.status = status;
      err.expired = true;
      return err;
    };
    if (res.redirected && !onOrigin) throw expired(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expired(`HTTP ${res.status}`, res.status);
    if (res.status === 200 && !ctype.includes("json")) throw expired(`non-JSON reply (${ctype || "none"})`);
  }

  function captureCsrf() {
    const meta = document.querySelector(
      'meta[name="anti-csrftoken-a2z"], meta[name="csrf-token"], meta[name="x-csrf-token"]'
    );
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");
    const input = document.querySelector(
      'input[name="anti-csrftoken-a2z"], input[name="csrfToken"], input[name="csrf-token"]'
    );
    if (input && input.value) return input.value;
    for (const key of ["antiCsrfToken", "csrfToken", "CSRF_TOKEN", "anti_csrftoken_a2z"]) {
      try {
        if (window[key]) return String(window[key]);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      for (const s of document.scripts) {
        const m = s.textContent && s.textContent.match(/anti-?csrftoken-?a2z["'\s:=]+([A-Za-z0-9+/=]{20,})/i);
        if (m) return m[1];
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function buildPayload(ids) {
    const pageSize = Math.max(BATCH_SIZE, ids.length);
    return {
      searchIds: ids,
      searchByIds: true,
      page: 0,
      pageSize,
      bookmarkedSavedSearch: false,
      executionViewModePreference: "vrs",
      originalCriteria: JSON.stringify({ searchIds: ids, pageSize }),
    };
  }

  async function postBatch(ids, csrf) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
    };
    if (csrf) {
      headers["anti-csrftoken-a2z"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    dlog(`POST by-id with ${ids.length} ids (csrf ${csrf ? "yes" : "no"})`);
    const res = await fetch(API_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(buildPayload(ids)),
    });
    dlog(`← HTTP ${res.status} ${res.redirected ? `(redirected to ${res.url}) ` : ""}`);
    assertApiResponse(res);
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      const err = new Error(`FMC by-id HTTP ${res.status} — ${snippet}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const records = (data.returnedObject && data.returnedObject.records) || [];
    dlog(`${records.length} records`);
    return records;
  }

  // Pull any order/shipment identifiers FMC exposes on the record so the
  // background can tie a VRID back to an SMC order even when SMC lacked it.
  function collectOrderIds(rec) {
    const out = new Set();
    const visit = (v, depth) => {
      if (v == null || depth > 4) return;
      if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
      if (typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (/orderId|shipperOrderId|shipmentId|loadId|blockId/i.test(k) && (typeof val === "string" || typeof val === "number")) {
            out.add(String(val));
          } else if (typeof val === "object") visit(val, depth + 1);
        }
      }
    };
    visit(rec, 0);
    return [...out];
  }

  function mapRecord(rec) {
    const vrid = rec && rec.vehicleRunId ? String(rec.vehicleRunId).trim() : "";
    if (!vrid) return null;
    return {
      vrid,
      status: rec.executionStatus ?? null,
      carrier: rec.carrierId ?? null,
      carrierName: rec.carrierName ?? null,
      tour: rec.tourId ?? null,
      orderIds: collectOrderIds(rec),
    };
  }

  async function byId(ids) {
    const clean = [...new Set((ids || []).map((v) => String(v).trim()).filter(Boolean))];
    const csrf = captureCsrf();
    const records = [];
    for (let i = 0; i < clean.length; i += BATCH_SIZE) {
      const batch = clean.slice(i, i + BATCH_SIZE);
      for (const rec of await postBatch(batch, csrf)) {
        const m = mapRecord(rec);
        if (m) records.push(m);
      }
    }
    return records;
  }

  async function ping() {
    const csrf = captureCsrf();
    const res = await fetch(API_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        ...(csrf ? { "anti-csrftoken-a2z": csrf, "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(buildPayload(["__ping__"])),
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
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("fmc:")) return;
    trace = [];
    dlog(`${msg.action} on ${location.href}`);
    if (msg.action === "fmc:ping") {
      return ping()
        .then((status) => (status === 200 ? ok({ status }) : fail(Object.assign(new Error(`ping HTTP ${status}`), { status }))))
        .catch(fail);
    }
    if (msg.action === "fmc:byId") {
      return byId(msg.ids)
        .then((records) => ok({ records }))
        .catch(fail);
    }
    // One ≤50-id request; the background loops so each round-trip is short.
    if (msg.action === "fmc:batch") {
      const ids = (msg.ids || []).map((v) => String(v).trim()).filter(Boolean).slice(0, BATCH_SIZE);
      return postBatch(ids, captureCsrf())
        .then((recs) => ok({ records: recs.map(mapRecord).filter(Boolean) }))
        .catch(fail);
    }
    return fail(new Error(`Unknown fmc action: ${msg.action}`));
  });

  browser.runtime.sendMessage({ action: "fmc:bridge-ready", href: location.href }).catch(() => {});
  console.info("[LobbySweeper] FMC bridge ready on", location.origin);
})();
