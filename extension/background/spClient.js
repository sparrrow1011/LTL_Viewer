/**
 * SharePoint REST client — delegates to the SharePoint-origin bridge.
 *
 * The background worker's own fetch to SharePoint does NOT carry the user's
 * session (write-authorization via `_api/contextinfo` 403s). So instead of
 * fetching here, we forward every REST op to content/sp-bridge.js, which runs
 * ON the SharePoint page and fetches same-origin with the real session.
 *
 * Flow: spGet/spWrite → bridgeRequest → find/open a SharePoint tab →
 * tabs.sendMessage({action:"sp:req", ...}) → bridge performs fetch → result.
 */

import { Config } from "../config.js";
import { log } from "./debug.js";

const SP_TAB_URL = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}`;
const SP_MATCH = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}/*`;

export class SpError extends Error {
  /**
   * @param {string} message
   * @param {number} status   HTTP status (0 = never reached SharePoint)
   * @param {string} body     SharePoint's own response body, kept verbatim
   * @param {{expired?:boolean, denied?:boolean}} [flags] from the bridge, which
   *        is the only place that sees the real response
   *
   * 401 and 403 are DIFFERENT problems and used to be reported identically as
   * "session expired", which sent people to re-sign-in for what was actually a
   * permissions problem. 401 (or a redirect to the sign-in page) = not signed
   * in. 403 after a digest refresh = signed in, but not allowed to do this.
   */
  constructor(message, status = 0, body = "", flags = {}) {
    super(message);
    this.name = "SpError";
    this.status = status;
    this.body = body;
    this.expired = flags.expired != null ? !!flags.expired : status === 401;
    this.denied = flags.denied != null ? !!flags.denied : status === 403;
    if (this.expired) {
      this.message = "SharePoint session expired — open the SharePoint tab, sign in, then retry.";
    } else if (this.denied) {
      this.message =
        `SharePoint refused this (HTTP 403): you're signed in but don't have permission. ` +
        `${message}. Ask a site owner for edit access to ${Config.SP_SITE_PATH}.`;
    }
    // Any other failure keeps the caller's message and the response body, so
    // the real cause is visible instead of being overwritten.
  }
}

/** One-line summary for a toast: real status + a snippet of SharePoint's reply. */
export function spErrorDetail(err) {
  if (!err) return "";
  const bits = [];
  if (err.status) bits.push(`HTTP ${err.status}`);
  const body = String(err.body || "").trim();
  if (body) {
    // SharePoint errors are JSON with the useful text nested; fall back to raw.
    let text = body;
    try {
      const j = JSON.parse(body);
      text = j?.error?.message?.value || j?.["odata.error"]?.message?.value || body;
    } catch {
      /* not JSON */
    }
    bits.push(String(text).replace(/\s+/g, " ").slice(0, 200));
  }
  return bits.join(" — ");
}

// ── locate (or open) a SharePoint tab that has the bridge ─────────────────────

async function findSpTab() {
  const tabs = await browser.tabs.query({ url: SP_MATCH });
  // Prefer a fully loaded tab.
  const ready = tabs.find((t) => t.status === "complete") || tabs[0];
  return ready || null;
}

let _openingPromise = null;

async function ensureSpTab() {
  let tab = await findSpTab();
  if (tab) return tab;

  // Open one (once), wait for it to finish loading so the bridge is injected.
  if (!_openingPromise) {
    log.info("sp", `no SharePoint tab open — opening ${SP_TAB_URL}`);
    _openingPromise = (async () => {
      const created = await browser.tabs.create({ url: SP_TAB_URL, active: false });
      // Wait for the tab to complete loading (bridge injects at document_idle).
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === created.id && info.status === "complete") {
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        browser.tabs.onUpdated.addListener(listener);
        // Safety timeout.
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 20_000);
      });
      // Give the content script a moment to register its listener.
      await new Promise((r) => setTimeout(r, 500));
      return created;
    })();
  }
  try {
    await _openingPromise;
  } finally {
    _openingPromise = null;
  }
  tab = await findSpTab();
  return tab;
}

/** Send one REST op to the bridge; returns the bridge's { ok, status, data, body }. */
async function bridgeRequest({ method = "GET", path, body = null, etag = "*", raw = false, probe = null }) {
  const tab = await ensureSpTab();
  if (!tab) {
    throw new SpError(
      "No SharePoint tab available. Open the SharePoint site in a tab and retry.",
      0,
      ""
    );
  }
  const message = { action: "sp:req", method, path, body, etag, raw, probe };
  let resp;
  try {
    resp = await browser.tabs.sendMessage(tab.id, message);
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (!/Receiving end does not exist|Could not establish connection/i.test(m)) {
      throw new SpError(`SharePoint bridge not reachable (tab ${tab.id})`, 0, m);
    }
    // Bridge content script not present yet — inject it and retry once.
    log.info("sp", `bridge missing in tab ${tab.id} — injecting sp-bridge.js`);
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/sp-bridge.js"],
      });
    } catch (injErr) {
      throw new SpError(
        `Couldn't inject SharePoint bridge into tab ${tab.id}`,
        0,
        String(injErr && injErr.message ? injErr.message : injErr)
      );
    }
    await new Promise((r) => setTimeout(r, 300));
    resp = await browser.tabs.sendMessage(tab.id, message);
  }
  if (!resp || !resp.bridge) {
    throw new SpError("SharePoint bridge returned no response", 0, JSON.stringify(resp));
  }
  return resp;
}

/**
 * Non-throwing REST op for callers that treat failures as data (the usage
 * roster). Returns the bridge's { ok, status, data, body, expired }.
 */
export async function spRequest(req) {
  try {
    return await bridgeRequest(req);
  } catch (e) {
    return { ok: false, status: (e && e.status) || 0, body: String(e && e.message ? e.message : e), expired: false, data: null };
  }
}

// ── public API (same signatures as before) ────────────────────────────────────

/** GET a REST path (relative to `_api`), following @odata.nextLink paging. */
export async function spGet(path, { paged = false } = {}) {
  if (!paged) {
    log.debug("GET", path);
    const r = await bridgeRequest({ method: "GET", path });
    log.debug("GET", `→ HTTP ${r.status}`, path);
    if (!r.ok) throw new SpError(`GET ${path} → HTTP ${r.status}`, r.status, r.body, r);
    return r.data;
  }

  const all = [];
  let next = path;
  let pageNo = 0;
  while (next) {
    pageNo += 1;
    log.debug("GET", `page ${pageNo}`, next);
    const r = await bridgeRequest({ method: "GET", path: next });
    log.debug("GET", `page ${pageNo} → HTTP ${r.status}`);
    if (!r.ok) throw new SpError(`GET ${next} → HTTP ${r.status}`, r.status, r.body, r);
    const data = r.data || {};
    if (Array.isArray(data.value)) all.push(...data.value);
    next = data["@odata.nextLink"] || data["odata.nextLink"] || null;
  }
  log.debug("GET", `paged total: ${all.length} items`);
  return { value: all };
}

/** Write helper: POST / MERGE / DELETE (MERGE+DELETE tunneled through POST). */
export async function spWrite(path, { method = "POST", body = null, etag = "*" } = {}) {
  log.debug("WRITE", `${method} ${path}`, body ? { bodyKeys: Object.keys(body) } : "");
  const r = await bridgeRequest({ method, path, body, etag });
  log.debug("WRITE", `${method} ${path} → HTTP ${r.status}`);
  if (!r.ok) throw new SpError(`${method} ${path} → HTTP ${r.status}`, r.status, r.body, r);
  return r.data;
}

/** Convenience: list-scoped path builder. */
export function listPath(listTitle, suffix = "") {
  return `/web/lists/getbytitle('${encodeURIComponent(listTitle)}')${suffix}`;
}

/**
 * Read a document-library file as text by its server-relative URL, e.g.
 * "/sites/AmazonFreightOperations/CST/CST L4+/PROCESS IMPROVEMENT/x.csv".
 * Throws SpError (status 404 when the file isn't there).
 */
export async function spGetFileText(serverRelativeUrl) {
  const rel = String(serverRelativeUrl);
  // 1. Site-scoped REST (only resolves files inside Config.SP_SITE_PATH).
  const lit = rel.replace(/'/g, "''"); // single quotes doubled in OData literals
  const apiPath = `/web/GetFileByServerRelativePath(decodedurl='${encodeURIComponent(lit)}')/$value`;
  log.debug("FILE", rel);
  let r = await bridgeRequest({ method: "GET", path: apiPath, raw: true });
  log.debug("FILE", `api → HTTP ${r.status}`, rel);
  if (r.ok) return r.data;
  if (r.status === 401 || r.status === 403 || r.expired) {
    throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body, r);
  }
  // 2. Direct download URL — works for files on ANY site of the tenant, since
  //    the bridge fetches with the SharePoint session. `download=1` forces the
  //    raw bytes instead of an Office/preview page.
  const direct = `${Config.SP_ORIGIN}${rel.split("/").map(encodeURIComponent).join("/")}?download=1`;
  r = await bridgeRequest({ method: "GET", path: direct, raw: true });
  log.debug("FILE", `direct → HTTP ${r.status}`, rel);
  if (!r.ok) throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body, r);
  return r.data;
}

/**
 * List a document-library folder. Lets us resolve a file by pattern instead of
 * guessing its exact name — spaces, capitalisation and "(1)" suffixes in
 * hand-managed libraries make exact paths brittle.
 * @returns {Promise<Array<{name: string, url: string}>>} empty on failure
 */
export async function spListFolderFiles(folderServerRelativeUrl) {
  const lit = String(folderServerRelativeUrl).replace(/'/g, "''");
  const path =
    `/web/GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(lit)}')` +
    `/Files?$select=Name,ServerRelativeUrl,TimeLastModified&$top=500`;
  try {
    const d = await spGet(path);
    return (d.value || []).map((f) => ({
      name: f.Name,
      url: f.ServerRelativeUrl,
      modified: f.TimeLastModified || null,
    }));
  } catch (e) {
    log.debug("FOLDER", `${folderServerRelativeUrl}: ${e && e.message}`);
    return [];
  }
}

/**
 * File metadata (server-side, so it reflects the LIVE file rather than any
 * synced copy). Used to show when the shipper workbook was last edited, so a
 * stale list is visible instead of silent. Best-effort: returns null on failure.
 * @returns {Promise<{modified: string|null, name: string|null, length: number|null}|null>}
 */
export async function spGetFileInfo(serverRelativeUrl) {
  const lit = String(serverRelativeUrl).replace(/'/g, "''");
  const path =
    `/web/GetFileByServerRelativePath(decodedurl='${encodeURIComponent(lit)}')` +
    `?$select=TimeLastModified,Name,Length`;
  try {
    const d = await spGet(path);
    return {
      modified: d?.TimeLastModified || null,
      name: d?.Name || null,
      length: d?.Length != null ? Number(d.Length) : null,
    };
  } catch (e) {
    log.debug("FILE(info)", `${serverRelativeUrl}: ${e && e.message}`);
    return null;
  }
}

/**
 * Read a document-library file as BYTES (base64 over messaging → Uint8Array).
 * Needed for .xlsx, which is a ZIP and must not be decoded as text.
 */
export async function spGetFileBytes(serverRelativeUrl) {
  const rel = String(serverRelativeUrl);
  const lit = rel.replace(/'/g, "''");
  const apiPath = `/web/GetFileByServerRelativePath(decodedurl='${encodeURIComponent(lit)}')/$value`;
  log.debug("FILE(bytes)", rel);
  let r = await bridgeRequest({ method: "GET", path: apiPath, raw: "bytes" });
  log.debug("FILE(bytes)", `api → HTTP ${r.status}`, rel);
  if (r.ok) return r.data; // base64
  if (r.status === 401 || r.status === 403 || r.expired || r.denied) {
    throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body, r);
  }
  // Direct download URL — resolves files on any site of the tenant.
  const direct = `${Config.SP_ORIGIN}${rel.split("/").map(encodeURIComponent).join("/")}?download=1`;
  r = await bridgeRequest({ method: "GET", path: direct, raw: "bytes" });
  log.debug("FILE(bytes)", `direct → HTTP ${r.status}`, rel);
  if (!r.ok) throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body, r);
  return r.data;
}

/**
 * Find files by name via SharePoint Search. Returns server-relative paths (on
 * this tenant), most relevant first. Best-effort: returns [] on any failure.
 */
export async function spSearchFilePaths(filename) {
  try {
    const q = `filename:"${String(filename).replace(/"/g, "")}"`;
    const path =
      `/search/query?querytext='${encodeURIComponent(q)}'` +
      `&selectproperties='Path'&rowlimit=20&trimduplicates=false`;
    const data = await spGet(path);
    const rows =
      data?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ||
      data?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows?.results ||
      [];
    const out = [];
    for (const row of rows) {
      const cells = row.Cells?.results || row.Cells || [];
      const cell = cells.find((c) => c.Key === "Path");
      if (!cell || !cell.Value) continue;
      try {
        const u = new URL(cell.Value);
        if (u.origin === Config.SP_ORIGIN) out.push(decodeURIComponent(u.pathname));
      } catch {
        /* skip non-URL paths */
      }
    }
    log.debug("SEARCH", `${filename}: ${out.length} hit(s)`, out);
    return out;
  } catch (e) {
    log.warn("SEARCH", `search for ${filename} failed:`, e && e.message);
    return [];
  }
}

/**
 * Lightweight authenticated probe. Throws SpError (with .expired on 401/403)
 * if the SharePoint session is gone. Used by the session pre-flight.
 */
export async function ping() {
  const r = await bridgeRequest({ method: "GET", path: "/web?$select=Title" });
  if (!r.ok) throw new SpError(`SharePoint ping → HTTP ${r.status}`, r.status, r.body, r);
  return true;
}

/**
 * Write pre-flight: asks the bridge for a fresh form digest (`_api/contextinfo`,
 * a POST). Proves the session can actually WRITE, which ping() does not —
 * cached GETs and read-only permissions both sail through it. Used before any
 * action that saves, so the blocker appears before the user does the work.
 */
export async function pingWrite() {
  const r = await bridgeRequest({ method: "POST", path: "", probe: "write" });
  if (!r.ok) {
    throw new SpError(`SharePoint write check → HTTP ${r.status}`, r.status, r.body, r);
  }
  return true;
}
