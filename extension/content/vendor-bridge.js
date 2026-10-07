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

  const API = "https://procurementportal-eu.corp.amazon.com/bp-api/vendor";
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
   * POST the codes and map them back to names.
   * The response carries `buyingPortalVendorData` — a list of
   * { vendorCode, vendorName, ... }.
   */
  async function lookup(codes) {
    const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
    if (!wanted.length) return {};
    dlog(`POST ${API} for ${wanted.length} code(s)`);
    const res = await fetch(API, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ vendorCodes: wanted }),
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    dlog(`← HTTP ${res.status} ${res.redirected ? `(redirected to ${res.url}) ` : ""}type=${ctype || "none"}`);

    // Auth redirect: the Portal bounces to federate rather than returning 401.
    if (res.redirected && AUTH_HOSTS.test(res.url)) throw expiredError(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expiredError(`HTTP ${res.status}`);
    if (res.ok && !ctype.includes("json")) throw expiredError(`non-JSON reply (${ctype || "none"})`);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      const e = new Error(`vendor API HTTP ${res.status} — ${body}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const list = data.buyingPortalVendorData || data.vendorData || [];
    const names = {};
    for (const v of list) {
      const code = String(v.vendorCode ?? "").trim();
      const name = String(v.vendorName ?? "").trim();
      if (code && name) names[code] = name;
    }
    dlog(`resolved ${Object.keys(names).length}/${wanted.length}`);
    return names;
  }

  async function ping() {
    const res = await fetch(API, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ vendorCodes: [] }),
    });
    if (res.redirected && AUTH_HOSTS.test(res.url)) throw expiredError(`redirected to ${res.url}`);
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
