/**
 * SharePoint bridge — content script on amazongbr.sharepoint.com.
 *
 * The background's fetch to SharePoint does not carry the user's session, so
 * it forwards every REST op here as { action:"sp:req", method, path, body,
 * etag } and this script performs the fetch same-origin with the real cookies.
 * `path` is relative to the site's `_api`. Trimmed copy of the bridge used by
 * the other add-ons (JSON GET + write only — no file downloads needed here).
 */
(function () {
  "use strict";

  const SITE_PATH = "/sites/AmazonFreightOperations";
  const API_BASE = `${location.origin}${SITE_PATH}/_api`;
  const JSON_HEADERS = {
    Accept: "application/json;odata=nometadata",
    "Content-Type": "application/json;odata=nometadata",
  };
  let _digest = null; // { value, expiresAt }

  // An expired Midway/SharePoint session usually comes back as a 200 with login
  // HTML (fetch followed the redirect), not as 401/403. A real _api reply stays
  // on this origin and is JSON.
  function assertApiResponse(res) {
    const onOrigin = !res.url || res.url.startsWith(location.origin);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
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
    if (res.ok && res.status !== 204 && !ctype.includes("json")) {
      const err = new Error(`SharePoint returned non-JSON (${ctype || "no content-type"}) — session likely expired`);
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
    const res = await fetch(`${API_BASE}/contextinfo`, { method: "POST", credentials: "include", headers: JSON_HEADERS });
    assertApiResponse(res);
    if (!res.ok) {
      const err = new Error(`contextinfo failed: HTTP ${res.status}`);
      err.status = res.status;
      err.body = await safeText(res);
      throw err;
    }
    const data = await res.json();
    const value = data.FormDigestValue || data.GetContextWebInformation?.FormDigestValue;
    const timeout = data.FormDigestTimeoutSeconds || data.GetContextWebInformation?.FormDigestTimeoutSeconds || 1800;
    if (!value) {
      const err = new Error("contextinfo returned no FormDigestValue");
      err.status = 0;
      throw err;
    }
    _digest = { value, expiresAt: now + timeout * 1000 };
    return value;
  }

  async function doGet(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const res = await fetch(url, { method: "GET", credentials: "include", headers: { Accept: "application/json;odata=nometadata" } });
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
    const send = (dg) =>
      fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { ...headers, "X-RequestDigest": dg },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    let res = await send(digest);
    if (res.status === 403) res = await send(await getDigest(true)); // stale digest → refresh once
    assertApiResponse(res);
    if (!res.ok) return { ok: false, status: res.status, body: await safeText(res), data: null };
    if (res.status === 204) return { ok: true, status: 204, data: null };
    const text = await res.text();
    return { ok: true, status: res.status, data: text ? JSON.parse(text) : null };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== "sp:req") return; // not for us
    const { method = "GET", path, body = null, etag = "*" } = msg;
    const run = method === "GET" ? doGet(path) : doWrite(method, path, body, etag);
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

  browser.runtime.sendMessage({ action: "sp:bridge-ready", href: location.href }).catch(() => {});
  console.info("[CTL] SharePoint bridge ready on", location.origin + SITE_PATH);
})();
