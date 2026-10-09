/**
 * Procurement Portal bridge — content script on the Portal's own origin.
 *
 * WHY: the Portal's vendor API needs that site's SSO session, which neither the
 * background worker nor the SMC page carries. Same arrangement as the SMC,
 * SharePoint and FMC bridges: the background finds (or opens) a Portal tab and
 * sends a message; this runs there and fetches same-origin.
 *
 * Message contract (from background/vendorClient.js):
 *   { action: "vendor:ping" }                  -> { bridge, ok, status }
 *   { action: "vendor:lookup", codes: [...] }  -> { bridge, ok, names: {code: name} }
 *
 * Read-only: it only ever resolves a vendor code to a vendor name.
 */
(function () {
  "use strict";

  const ORIGIN = "https://procurementportal-eu.corp.amazon.com";
  const API = `${ORIGIN}/bp-api/vendor`;
  // An expired session answers with the federate sign-in flow instead of data.
  const AUTH_HOSTS = /idp\.federate\.amazon\.com|signin|login\.microsoftonline/i;

  let trace = [];
  const dlog = (...a) => {
    trace.push(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    console.debug("[MSViewer vendor]", ...a);
  };

  function expiredError(why) {
    const e = new Error(`Procurement Portal session expired — ${why}`);
    e.status = 401;
    e.expired = true;
    return e;
  }

  /**
   * CSRF token from the page, the way the Portal's own UI sends it. Without
   * these headers the API rejects the POST — this is what the P&G TMS Viewer's
   * portal bridge does for /bp-api/search/po.
   */
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

  function apiHeaders() {
    const h = { "content-type": "application/json", accept: "application/json, text/plain, */*" };
    const csrf = captureCsrf();
    if (csrf) {
      h["x-csrf-token"] = csrf;
      h["anti-csrftoken-a2z"] = csrf;
    }
    dlog(csrf ? `csrf captured (len=${csrf.length})` : "no csrf token found on the page");
    return h;
  }

  /** fetch that turns a network-level failure into a clear expired-session error. */
  async function safeFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const e = new Error(
        `Procurement Portal request failed (${(err && err.message) || err}) — usually the session ` +
          `lapsed and the call was redirected. Open the Portal and retry.`
      );
      e.status = 0;
      e.expired = true;
      throw e;
    }
  }

  /**
   * One POST, one vendor.
   *
   * The request takes a `vendorCodes` array, but the reply describes a SINGLE
   * vendor under `buyingPortalVendorData` (an object, not a list) — posting
   * several codes just gets you the first one. So each code is its own call.
   *
   * @returns {Promise<{code: string, name: string|null}>}
   */
  async function lookupOne(code) {
    const res = await safeFetch(API, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: apiHeaders(),
      body: JSON.stringify({ vendorCodes: [code] }),
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    // Auth redirect: the Portal bounces to federate rather than returning 401.
    if (res.redirected && AUTH_HOSTS.test(res.url)) throw expiredError(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expiredError(`HTTP ${res.status}`);
    if (res.ok && !ctype.includes("json")) throw expiredError(`non-JSON reply (${ctype || "none"})`);
    if (!res.ok) {
      // A bad/unknown code shouldn't poison the whole batch — report it and
      // carry on with the rest.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      dlog(`${code}: HTTP ${res.status} — ${body}`);
      return { code, name: null };
    }

    const data = await res.json();
    // `buyingPortalVendorData` is an object; tolerate a list in case the API
    // ever starts batching for real.
    const raw = data.buyingPortalVendorData ?? data.vendorData ?? data.vendor ?? null;
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const name = entry ? String(entry.vendorName ?? entry.name ?? "").trim() : "";
    if (!name) {
      dlog(`${code}: no vendorName — response keys: ${Object.keys(data || {}).join(", ") || "(none)"}`);
      return { code, name: null };
    }
    // Trust the code the API echoes back when it gives one.
    const echoed = entry.vendorCode ? String(entry.vendorCode).trim() : code;
    return { code: echoed || code, name };
  }

  /** Resolve many codes, a few requests at a time. */
  async function lookup(codes) {
    const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
    if (!wanted.length) return {};
    dlog(`${API} — ${wanted.length} code(s): ${wanted.slice(0, 5).join(", ")}`);

    const names = {};
    const queue = [...wanted];
    const CONCURRENCY = 4;
    const worker = async () => {
      for (;;) {
        const code = queue.shift();
        if (!code) return;
        const { code: key, name } = await lookupOne(code);
        if (name) names[key] = name;
      }
    };
    // An expired session rejects here and fails the whole call, which is right:
    // retrying the remaining codes on a dead session is pointless.
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    const got = Object.keys(names).length;
    dlog(
      `resolved ${got}/${wanted.length}` +
        (got ? `: ${Object.entries(names).slice(0, 3).map(([c, n]) => `${c}=${n}`).join(", ")}` : "")
    );
    return names;
  }

  async function ping() {
    // The API would 400 on an empty body, so probe the SPA root instead and
    // just check we stay on-origin (same approach as the TMS portal bridge).
    const res = await safeFetch(`${ORIGIN}/`, { credentials: "include", cache: "no-store" });
    if (res.redirected && !res.url.startsWith(location.origin)) {
      throw expiredError(`redirected to ${res.url}`);
    }
    if (res.status === 401 || res.status === 403) throw expiredError(`HTTP ${res.status}`);
    return res.status;
  }

  const takeTrace = () => {
    const t = trace;
    trace = [];
    return t;
  };
  const ok = (extra) => ({ bridge: true, ok: true, trace: takeTrace(), ...extra });
  const fail = (err) => {
    dlog(`FAILED: ${(err && err.message) || err}`);
    return {
      bridge: true,
      ok: false,
      status: (err && err.status) || 0,
      expired: !!(err && err.expired),
      error: String((err && err.message) || err),
      trace: takeTrace(),
    };
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("vendor:")) return;
    trace = [];
    if (msg.action === "vendor:ping") {
      return ping()
        .then((status) => ok({ status }))
        .catch(fail);
    }
    if (msg.action === "vendor:lookup") {
      return lookup(msg.codes || [])
        .then((names) => ok({ names }))
        .catch(fail);
    }
    return fail(new Error(`Unknown vendor action: ${msg.action}`));
  });

  browser.runtime.sendMessage({ action: "vendor:bridge-ready", href: location.href }).catch(() => {});
  console.info("[MSViewer] Procurement Portal bridge ready on", location.origin);
})();
