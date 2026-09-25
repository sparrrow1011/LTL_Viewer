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
  constructor(message, status = 0, body = "") {
    super(message);
    this.name = "SpError";
    this.status = status;
    this.body = body;
    // 401 (and some 403s) mean the SharePoint session lapsed — surface a clear,
    // actionable message rather than a raw HTTP code.
    this.expired = status === 401 || status === 403;
    if (this.expired) {
      this.message =
        "SharePoint session expired — open the SharePoint tab, sign in, then retry.";
    }
  }
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
async function bridgeRequest({ method = "GET", path, body = null, etag = "*", raw = false }) {
  const tab = await ensureSpTab();
  if (!tab) {
    throw new SpError(
      "No SharePoint tab available. Open the SharePoint site in a tab and retry.",
      0,
      ""
    );
  }
  const message = { action: "sp:req", method, path, body, etag, raw };
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
    if (!r.ok) throw new SpError(`GET ${path} → HTTP ${r.status}`, r.status, r.body);
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
    if (!r.ok) throw new SpError(`GET ${next} → HTTP ${r.status}`, r.status, r.body);
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
  if (!r.ok) throw new SpError(`${method} ${path} → HTTP ${r.status}`, r.status, r.body);
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
    throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body);
  }
  // 2. Direct download URL — works for files on ANY site of the tenant, since
  //    the bridge fetches with the SharePoint session. `download=1` forces the
  //    raw bytes instead of an Office/preview page.
  const direct = `${Config.SP_ORIGIN}${rel.split("/").map(encodeURIComponent).join("/")}?download=1`;
  r = await bridgeRequest({ method: "GET", path: direct, raw: true });
  log.debug("FILE", `direct → HTTP ${r.status}`, rel);
  if (!r.ok) throw new SpError(`GET file ${rel} → HTTP ${r.status}`, r.status, r.body);
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
  if (!r.ok) throw new SpError(`SharePoint ping → HTTP ${r.status}`, r.status, r.body);
  return true;
}
