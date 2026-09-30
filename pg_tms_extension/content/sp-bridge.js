/**
 * SharePoint bridge — a content script injected into the SharePoint origin
 * (amazongbr.sharepoint.com).
 *
 * WHY THIS EXISTS: the background worker's fetch to SharePoint does NOT carry
 * the user's SharePoint session, so write-authorization (`_api/contextinfo`)
 * returns 403. A content script running ON the SharePoint page fetches
 * same-origin with the real session cookies + page context, so contextinfo and
 * writes succeed — the same reason the SMC content script can call SMC.
 *
 * The background routes every SharePoint REST op here via runtime messages:
 *   { action: "sp:req", method, path, body, etag }
 * and this bridge performs the fetch and returns { ok, status, data } / error.
 *
 * `path` is relative to the site's `_api` (e.g. "/web/lists/getbytitle('X')/items").
 */
(function () {
  "use strict";

  // Derive the site _api base from the current SharePoint URL. The bridge is
  // injected on the site, so location.pathname already contains /sites/<site>.
  // We only need the origin + the configured site path; keep it robust by
  // reading the site path from the injected marker the background sets, with a
  // sensible fallback.
  const SITE_PATH = "/sites/AmazonFreightOperations";
  const API_BASE = `${location.origin}${SITE_PATH}/_api`;

  const JSON_HEADERS = {
    Accept: "application/json;odata=nometadata",
    "Content-Type": "application/json;odata=nometadata",
  };

  let _digest = null; // { value, expiresAt }

  /**
   * Session-expiry detection (same issue as the FMC bridge).
   *
   * An expired Midway/SharePoint session usually does NOT come back as 401/403
   * — SharePoint REDIRECTS to the sign-in page, `fetch` follows it, and we get
   * an HTTP 200 whose body is login HTML. `res.ok` is then true and the caller
   * would either treat it as authenticated (ping) or blow up on `res.json()`.
   *
   * A real authenticated `_api` reply must stay on the SharePoint origin and
   * be JSON. Otherwise throw with `.expired = true` so the pre-flight can show
   * the sign-in blocker instead of continuing.
   */
  function assertApiResponse(res) {
    const onOrigin = !res.url || res.url.startsWith(location.origin);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const isJson = ctype.includes("json");
    if (res.redirected && !onOrigin) {
      const err = new Error(`SharePoint session expired — redirected to ${res.url}`);
      err.status = 401;
      err.expired = true;
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`SharePoint session expired — HTTP ${res.status}`);
      err.status = res.status;
      err.expired = true;
      throw err;
    }
    // 204 (no content) is a legitimate write reply with no body/content-type.
    if (res.ok && res.status !== 204 && !isJson) {
      const err = new Error(
        `SharePoint returned non-JSON (${ctype || "no content-type"}) — session likely expired`
      );
      err.status = 401;
      err.expired = true;
      throw err;
    }
  }

  async function safeText(res) {
    try {
      return (await res.text())?.slice(0, 500) || "";
    } catch {
      return "";
    }
  }

  async function getDigest(force = false) {
    const now = Date.now();
    if (!force && _digest && _digest.expiresAt - 60_000 > now) return _digest.value;
    const res = await fetch(`${API_BASE}/contextinfo`, {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
    });
    assertApiResponse(res); // expired session → throws with .expired
    if (!res.ok) {
      const body = await safeText(res);
      const err = new Error(`contextinfo failed: HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    const data = await res.json();
    const value =
      data.FormDigestValue || data.GetContextWebInformation?.FormDigestValue;
    const timeout =
      data.FormDigestTimeoutSeconds ||
      data.GetContextWebInformation?.FormDigestTimeoutSeconds ||
      1800;
    if (!value) {
      const err = new Error("contextinfo returned no FormDigestValue");
      err.status = 0;
      err.body = JSON.stringify(data).slice(0, 500);
      throw err;
    }
    _digest = { value, expiresAt: now + timeout * 1000 };
    return value;
  }

  /**
   * Raw file GET (e.g. `/web/GetFileByServerRelativePath(...)/$value`). Returns
   * the body as TEXT — used to read the CST shipper source-of-truth CSV from a
   * document library. Only the redirect/401/403 checks apply (the content-type
   * is text/csv, not JSON).
   */
  async function doGetRaw(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const res = await fetch(url, { method: "GET", credentials: "include" });
    const onOrigin = !res.url || res.url.startsWith(location.origin);
    if ((res.redirected && !onOrigin) || res.status === 401 || res.status === 403) {
      const err = new Error(`SharePoint session expired — HTTP ${res.status}`);
      err.status = res.status || 401;
      err.expired = true;
      throw err;
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && ctype.includes("text/html")) {
      // A file GET never returns HTML; this is the login page.
      const err = new Error("SharePoint returned HTML for a file GET — session likely expired");
      err.status = 401;
      err.expired = true;
      throw err;
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: res.ok ? null : text.slice(0, 500), data: res.ok ? text : null };
  }

  async function doGet(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json;odata=nometadata" },
    });
    // Reject redirect-to-login / HTML 200 before trusting res.ok. This is what
    // makes the SharePoint session pre-flight (spClient.ping) trustworthy.
    assertApiResponse(res);
    const body = res.ok ? null : await safeText(res);
    return { ok: res.ok, status: res.status, body, data: res.ok ? await res.json() : null };
  }

  async function doWrite(method, path, body, etag) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const digest = await getDigest();
    const headers = { ...JSON_HEADERS, "X-RequestDigest": digest };
    if (method === "MERGE" || method === "DELETE") {
      headers["X-HTTP-Method"] = method;
      headers["IF-MATCH"] = etag || "*";
    }
    const send = (dg) => {
      const h = { ...headers, "X-RequestDigest": dg };
      return fetch(url, {
        method: "POST",
        credentials: "include",
        headers: h,
        body: body != null ? JSON.stringify(body) : undefined,
      });
    };
    let res = await send(digest);
    if (res.status === 403) {
      // Stale digest — refresh once and retry. (A 403 here is usually a stale
      // digest, not an expired session, so don't treat it as expiry yet.)
      const dg2 = await getDigest(true);
      res = await send(dg2);
    }
    // After the digest retry, a redirect/HTML/401/403 is a genuine expiry.
    assertApiResponse(res);
    if (!res.ok) {
      return { ok: false, status: res.status, body: await safeText(res), data: null };
    }
    if (res.status === 204) return { ok: true, status: 204, data: null };
    const text = await res.text();
    return { ok: true, status: res.status, data: text ? JSON.parse(text) : null };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== "sp:req") return; // not for us
    const { method = "GET", path, body = null, etag = "*", raw = false } = msg;
    const run =
      method === "GET"
        ? raw
          ? doGetRaw(path)
          : doGet(path)
        : doWrite(method, path, body, etag);
    return run
      .then((result) => ({ bridge: true, ...result }))
      .catch((err) => ({
        bridge: true,
        ok: false,
        status: err.status || 0,
        expired: !!(err && err.expired),
        body: err.body || String(err && err.message ? err.message : err),
        data: null,
      }));
  });

  // Announce presence so the background can detect a live bridge tab.
  browser.runtime
    .sendMessage({ action: "sp:bridge-ready", href: location.href })
    .catch(() => {});

  console.info("[LTL] SharePoint bridge ready on", location.origin + SITE_PATH);
})();
