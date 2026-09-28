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

  /**
   * Binary file GET, returned as base64 (used for the HAT .xlsx workbook).
   *
   * Why not doGetRaw: res.text() UTF-8-decodes the bytes, so every invalid
   * sequence in a zip becomes U+FFFD and the archive is unrecoverable. The
   * messaging boundary only carries JSON-cloneable values, so the bytes travel
   * as base64 (see blobToBase64) and the background decodes them.
   */

  // Firefox gives content scripts two network stacks: the plain fetch/XHR run
  // with the EXTENSION's principal, while `content.fetch` / `content.XMLHttpRequest`
  // run as if the SharePoint page itself made the request. JSON calls work on
  // either, but a file download can be refused on one and fine on the other
  // (it throws a bare NetworkError — no status). So try each, keeping every
  // error so a failure says exactly what happened instead of "HTTP 0".
  function pageFetch() {
    try {
      // eslint-disable-next-line no-undef
      return typeof content !== "undefined" && content && typeof content.fetch === "function"
        ? content.fetch.bind(content)
        : null;
    } catch {
      return null;
    }
  }

  function xhrArrayBuffer(url, useContent) {
    return new Promise((resolve, reject) => {
      let Ctor = XMLHttpRequest;
      try {
        // eslint-disable-next-line no-undef
        if (useContent && typeof content !== "undefined" && content && content.XMLHttpRequest) {
          // eslint-disable-next-line no-undef
          Ctor = content.XMLHttpRequest;
        }
      } catch {
        /* fall back to the plain XHR */
      }
      const x = new Ctor();
      x.open("GET", url, true);
      x.withCredentials = true;
      // A Blob, not an ArrayBuffer: see blobToBase64() for why.
      x.responseType = "blob";
      x.onload = () =>
        resolve({
          status: x.status,
          url: x.responseURL || url,
          ctype: (x.getResponseHeader("content-type") || "").toLowerCase(),
          blob: x.response || null,
        });
      x.onerror = () => reject(new Error(`XHR network error (status ${x.status})`));
      x.ontimeout = () => reject(new Error("XHR timed out"));
      x.send();
    });
  }

  async function viaFetch(fetchFn, url) {
    const res = await fetchFn(url, { method: "GET", credentials: "include" });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const redirectedOff = res.redirected && res.url && !res.url.startsWith(location.origin);
    if (!res.ok || redirectedOff || res.status === 401 || res.status === 403 || ctype.includes("text/html")) {
      return { status: res.status, url: res.url || url, ctype, blob: null, text: await safeText(res), redirectedOff };
    }
    return { status: res.status, url: res.url || url, ctype, blob: await res.blob() };
  }

  /**
   * Blob → base64 string, WITHOUT ever touching a byte buffer.
   *
   * In a Firefox content script the DOM classes (fetch's Response, Blob, XHR)
   * come from the SharePoint PAGE, so any ArrayBuffer they produce lives in the
   * page's memory. Firefox's security wrapper blocks the extension from using
   * such a buffer — `.subarray()` & co throw `Permission denied to access
   * property "constructor"`. That hit every route (res.arrayBuffer(), an XHR
   * arraybuffer, even re-reading the Blob through a Response).
   *
   * FileReader.readAsDataURL hands back a STRING, and strings cross that
   * boundary freely. The data URL's payload is already the base64 we send.
   */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      if (!blob) {
        resolve("");
        return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || "");
        const comma = s.indexOf(",");
        resolve(comma >= 0 ? s.slice(comma + 1) : "");
      };
      fr.onerror = () => reject(new Error(`FileReader failed: ${(fr.error && fr.error.message) || "unknown error"}`));
      fr.readAsDataURL(blob);
    });
  }

  /** Decoded size of a base64 string (for logging / the empty-file check). */
  function base64Bytes(b64) {
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
  }

  async function doGetBinary(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const transports = [
      ["fetch", (u) => viaFetch(fetch, u)],
      ["page fetch", pageFetch() ? (u) => viaFetch(pageFetch(), u) : null],
      ["page XHR", (u) => xhrArrayBuffer(u, true)],
    ].filter(([, fn]) => fn);

    // NOTE: a 401/403, an off-origin redirect or an HTML page on ONE transport
    // is NOT treated as an expired session here. A file download can be refused
    // on one network stack and allowed on another while the session is fine
    // (every other _api call works). We record it, try the next transport, and
    // let the background decide — it pings the session before calling it expired.
    const errors = [];
    let refused = 0; // status of the last auth-like refusal (401/403), if any
    for (const [name, fn] of transports) {
      let r;
      try {
        r = await fn(url);
      } catch (e) {
        errors.push(`${name}: ${(e && e.message) || e}`);
        continue; // a thrown network error: the next transport may get through
      }
      const onOrigin = !r.url || r.url.startsWith(location.origin);
      if (r.redirectedOff || (!onOrigin && r.status >= 200 && r.status < 400)) {
        errors.push(`${name}: redirected to ${r.url}`);
        refused = refused || 401;
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        errors.push(`${name}: HTTP ${r.status}${r.text ? ` — ${r.text.slice(0, 160)}` : ""}`);
        refused = r.status;
        continue;
      }
      if (r.status >= 200 && r.status < 300 && r.ctype.includes("text/html")) {
        errors.push(`${name}: got an HTML page instead of the file`);
        refused = refused || 401;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        // A real HTTP answer (404, 400…) — every transport would say the same.
        return {
          ok: false,
          status: r.status,
          body: `${name}: HTTP ${r.status}${r.text ? ` — ${r.text.slice(0, 300)}` : ""}`,
          data: null,
        };
      }
      // The file arrived. If turning it into base64 fails, record it against
      // this transport and try the next rather than letting it escape as an
      // anonymous "HTTP 0".
      let data;
      try {
        data = await blobToBase64(r.blob);
      } catch (e) {
        errors.push(`${name}: got the file but couldn't read its bytes — ${(e && e.message) || e}`);
        continue;
      }
      const bytes = base64Bytes(data);
      if (!bytes) {
        errors.push(`${name}: the file came back empty`);
        continue;
      }
      console.info(`[RUNS] bridge: ${Math.round(bytes / 1024)} KB via ${name} from ${url}`);
      return { ok: true, status: r.status, data, encoding: "base64", bytes, via: name };
    }
    // Nothing returned the file. `refused` tells the background whether it was
    // an auth-style refusal (it will check the session) or a network failure.
    return { ok: false, status: refused || 0, refused: !!refused, body: errors.join(" | ") || "no response", data: null };
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
    const { method = "GET", path, body = null, etag = "*", raw = false, binary = false } = msg;
    const run =
      method === "GET"
        ? binary
          ? doGetBinary(path)
          : raw
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

  console.info("[RUNS] SharePoint bridge ready on", location.origin + SITE_PATH);
})();
