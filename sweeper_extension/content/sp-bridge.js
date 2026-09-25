/**
 * SharePoint bridge — a content script injected into amazongbr.sharepoint.com.
 *
 * Only job: read the CST shipper source-of-truth CSV
 * (source_of_truth_crawler.csv, written by CST_viewer scripts/update_shippers.py)
 * so the SMC pull can be restricted to CST shipper IDs like scrapers/smc.py.
 * Same-origin fetch with the user's SharePoint session; the background's own
 * fetch would not carry it. Trimmed from MS Viewer's sp-bridge.js.
 *
 * Message contract:
 *   { action:"sp:ping" }                         -> { bridge, ok, status }
 *   { action:"sp:file", serverRelativeUrl }      -> { bridge, ok, text }
 */
(function () {
  "use strict";

  const SITE_PATH = "/sites/AmazonFreightOperations";
  const API_BASE = `${location.origin}${SITE_PATH}/_api`;

  let trace = [];
  const dlog = (...a) => {
    trace.push(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    console.debug("[LobbySweeper sp]", ...a);
  };

  function expiredError(why, status = 401) {
    const err = new Error(`SharePoint session expired — ${why}`);
    err.status = status;
    err.expired = true;
    return err;
  }

  function assertOnOrigin(res) {
    const onOrigin = !res.url || res.url.startsWith(location.origin);
    if (res.redirected && !onOrigin) throw expiredError(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expiredError(`HTTP ${res.status}`, res.status);
  }

  /**
   * Raw text GET; returns { ok, status, text }.
   * Only a redirect off-origin (to the Midway/SSO login) or login HTML means
   * the session is gone. A 401/403 on a specific FILE just means we can't read
   * that path (other site / no permission) — report it, don't abort the run.
   */
  async function getRaw(url) {
    dlog(`GET ${url}`);
    const res = await fetch(url, { method: "GET", credentials: "include" });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    dlog(`← HTTP ${res.status} ${res.redirected ? `(redirected to ${res.url}) ` : ""}content-type=${ctype || "none"}`);
    const onOrigin = !res.url || res.url.startsWith(location.origin);
    if (res.redirected && !onOrigin) throw expiredError(`redirected to ${res.url}`);
    const text = await res.text();
    if (res.ok && ctype.includes("text/html")) {
      // Only a real sign-in page means the session is gone. SharePoint also
      // serves HTML *error pages* with 200 (e.g. download.aspx on a missing
      // file) — those just mean "not this URL", so report a soft failure.
      if (/login\.microsoftonline|midway-auth|sign in|signin|<title>[^<]*(login|sign)/i.test(text.slice(0, 4000))) {
        throw expiredError("login page returned for a file GET");
      }
      dlog(`HTML (not CSV) returned — treating as not found. <title>: ${(text.match(/<title>([^<]{0,80})/i) || [])[1] || "?"}`);
      return { ok: false, status: 404, text: "HTML page instead of file" };
    }
    return { ok: res.ok, status: res.status, text: res.ok ? text : text.slice(0, 300) };
  }

  /**
   * Read a file by server-relative URL. Two strategies (MS Viewer spClient):
   *   1. site-scoped REST GetFileByServerRelativePath(...)/$value
   *   2. direct download URL (?download=1) — works across sites of the tenant
   */
  async function readFile(serverRelativeUrl) {
    const rel = String(serverRelativeUrl || "");
    if (!rel.startsWith("/")) throw new Error(`sp:file needs a server-relative path, got ${rel}`);
    // OData string literal: quotes doubled, then percent-encoded. `+` MUST be
    // %2B here ("CST L4+") — a raw + is decoded as a space by SharePoint.
    const lit = encodeURIComponent(rel.replace(/'/g, "''"));
    const encodedPath = rel.split("/").map(encodeURIComponent).join("/");
    const candidates = [
      `${API_BASE}/web/GetFileByServerRelativePath(decodedurl='${lit}')/$value`,
      `${API_BASE}/web/GetFileByServerRelativeUrl('${lit}')/$value`,
      `${location.origin}${SITE_PATH}/_layouts/15/download.aspx?SourceUrl=${lit}`,
      `${location.origin}${encodedPath}?download=1`,
    ];
    let last = null;
    for (const url of candidates) {
      const r = await getRaw(url);
      if (r.ok) return r.text;
      last = r;
    }
    // Diagnostic: does the parent folder exist, and what's in it?
    try {
      const folder = rel.slice(0, rel.lastIndexOf("/"));
      const flit = encodeURIComponent(folder.replace(/'/g, "''"));
      const res = await fetch(`${API_BASE}/web/GetFolderByServerRelativePath(decodedurl='${flit}')/Files?$select=Name&$top=50`, {
        credentials: "include",
        headers: { Accept: "application/json;odata=nometadata" },
      });
      if (res.ok) {
        const data = await res.json();
        const names = (data.value || []).map((f) => f.Name);
        dlog(`folder exists: ${folder} — files: ${names.join(", ") || "(none)"}`);
      } else {
        dlog(`folder lookup HTTP ${res.status} for ${folder}`);
      }
    } catch (e) {
      dlog(`folder lookup failed: ${e.message}`);
    }
    const err = new Error(`SharePoint file not readable (HTTP ${last.status}): ${rel}`);
    err.status = last.status;
    throw err;
  }

  /**
   * Find files by name via SharePoint Search → server-relative paths on this
   * tenant, most relevant first. (MS Viewer spClient.spSearchFilePaths.)
   */
  async function searchFile(filename) {
    const q = `filename:"${String(filename).replace(/"/g, "")}"`;
    const url =
      `${API_BASE}/search/query?querytext='${encodeURIComponent(q)}'` +
      `&selectproperties='Path'&rowlimit=20&trimduplicates=false`;
    dlog(`SEARCH ${q}`);
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json;odata=nometadata" },
    });
    dlog(`← HTTP ${res.status} content-type=${res.headers.get("content-type") || "none"}`);
    assertOnOrigin(res);
    if (!res.ok) {
      const err = new Error(`search HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const rows =
      data?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ||
      data?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows?.results ||
      [];
    const paths = [];
    for (const row of rows) {
      const cells = row.Cells?.results || row.Cells || [];
      const cell = cells.find((c) => c.Key === "Path");
      if (!cell || !cell.Value) continue;
      try {
        const u = new URL(cell.Value);
        if (u.origin === location.origin) paths.push(decodeURIComponent(u.pathname));
      } catch (_) {
        /* not a URL */
      }
    }
    dlog(`${paths.length} hit(s): ${paths.join(" | ")}`);
    return paths;
  }

  async function ping() {
    const res = await fetch(`${API_BASE}/web?$select=Title`, {
      credentials: "include",
      cache: "no-store", // a cached GET would hide a dead connection
      headers: { Accept: "application/json;odata=nometadata" },
    });
    assertOnOrigin(res);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && !ctype.includes("json")) throw expiredError(`non-JSON reply (${ctype || "none"})`);
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
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("sp:")) return;
    trace = [];
    dlog(`${msg.action} on ${location.href}`);
    if (msg.action === "sp:ping") {
      return ping()
        .then((status) => (status === 200 ? ok({ status }) : fail(Object.assign(new Error(`ping HTTP ${status}`), { status }))))
        .catch(fail);
    }
    if (msg.action === "sp:file") {
      return readFile(msg.serverRelativeUrl)
        .then((text) => {
          dlog(`read ${text.length} chars; first line: ${text.split(/\r?\n/)[0].slice(0, 100)}`);
          return ok({ text });
        })
        .catch(fail);
    }
    if (msg.action === "sp:search") {
      return searchFile(msg.filename)
        .then((paths) => ok({ paths }))
        .catch(fail);
    }
    return fail(new Error(`Unknown sp action: ${msg.action}`));
  });

  browser.runtime.sendMessage({ action: "sp:bridge-ready", href: location.href }).catch(() => {});
  console.info("[LobbySweeper] SharePoint bridge ready on", location.origin);
})();
