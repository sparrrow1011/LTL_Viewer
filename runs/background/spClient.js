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
import { makeBridge } from "./bridgeClient.js";

const SP_TAB_URL = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}`;
const SP_MATCH = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}/*`;

// Same tab-finding / inject / reload logic as the SMC and FMC bridges: skips
// discarded tabs, reloads a tab whose bridge won't come up, and reports the
// underlying Firefox error (e.g. "Missing host permission for the tab").
const bridge = makeBridge({ name: "sp", tabMatch: SP_MATCH, tabUrl: SP_TAB_URL, script: "content/sp-bridge.js" });

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

// ── send one REST op to the bridge ────────────────────────────────────────────

/** Returns the bridge's raw { ok, status, data, body, expired }. */
async function bridgeRequest({
  method = "GET",
  path,
  body = null,
  etag = "*",
  raw = false,
  binary = false,
}) {
  const tab = await bridge.ensureTab();
  if (!tab) {
    // We just opened the site and the tab no longer matches — almost always a
    // redirect to the Midway sign-in page.
    throw new SpError(
      `No SharePoint tab on ${SP_TAB_URL} (it was probably redirected to sign in). Open it, sign in, then retry.`,
      401,
      ""
    );
  }
  const message = { action: "sp:req", method, path, body, etag, raw, binary };
  let resp;
  try {
    resp = await bridge.send(tab, message);
  } catch (e) {
    // bridge.send already reloaded/injected and composed a precise message
    // (incl. the underlying Firefox error) — pass it through verbatim.
    const err = new SpError(String((e && e.message) || e), 0, "");
    err.permission = !!(e && e.permission);
    throw err;
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
 * Read a document-library file as BYTES (the HAT .xlsx workbook). The bridge
 * base64-encodes the body and we decode it here.
 *
 * SharePoint has several ways to hand out a file and they don't all behave the
 * same for a big Office document, so we try them in turn and stop at the first
 * that returns bytes:
 *   1. by document id   /_api/web/GetFileById('<guid>')/$value — immune to
 *                       renames/moves; the guid is the `d=w…` part of a share link
 *   2. by path          /_api/web/GetFileByServerRelativePath(…)/$value
 *   3. direct URL       <path>?download=1
 *   4. download page    /_layouts/15/download.aspx?SourceUrl=<url>
 * An expired session stops immediately. If none works the error lists what
 * each route said (the bridge's own text, not just a status code), so a failure
 * is diagnosable from the message alone.
 *
 * @param {string} serverRelativeUrl
 * @param {{uniqueId?: string}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function spGetFileBytes(serverRelativeUrl, { uniqueId = null } = {}) {
  const rel = String(serverRelativeUrl);
  const lit = rel.replace(/'/g, "''");
  const absolute = `${Config.SP_ORIGIN}${rel.split("/").map(encodeURIComponent).join("/")}`;
  const site = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}`;
  const routes = [];
  if (uniqueId) {
    const guid = encodeURIComponent(uniqueId);
    routes.push(["by id", `/web/GetFileById('${guid}')/$value`]);
    // The link SharePoint's own "Download" button uses.
    routes.push(["download.aspx by id", `${site}/_layouts/15/download.aspx?UniqueId=${guid}`]);
  }
  routes.push(["by path", `/web/GetFileByServerRelativePath(decodedurl='${encodeURIComponent(lit)}')/$value`]);
  routes.push(["direct", `${absolute}?download=1`]);
  routes.push(["download.aspx by path", `${site}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(absolute)}`]);

  // Every route is tried: a refusal on one (401/403/redirect) says nothing
  // about the others, and says nothing about the session either.
  const tried = [];
  let refused = false;
  for (const [name, path] of routes) {
    const r = await bridgeRequest({ method: "GET", path, binary: true });
    log.debug("FILE", `${name} → HTTP ${r.status}${r.via ? ` via ${r.via}` : ""}`, rel);
    if (r.ok) {
      log.info("FILE", `${rel}: ${Math.round((r.bytes || 0) / 1024)} KB (${name}${r.via ? `, ${r.via}` : ""})`);
      return base64ToBytes(r.data);
    }
    if (r.refused || r.expired || r.status === 401 || r.status === 403) refused = true;
    tried.push(`${name}: HTTP ${r.status}${r.body ? ` (${String(r.body).slice(0, 240)})` : ""}`);
  }

  // Only call it an expired session if the session actually is expired.
  if (refused) {
    let sessionOk = true;
    try {
      await ping();
    } catch (e) {
      if (e && e.expired) sessionOk = false;
    }
    if (!sessionOk) throw new SpError(`GET file ${rel} → HTTP 401`, 401, tried.join("\n"));
  }
  // A plain Error, deliberately not an SpError: SpError turns a 401/403 into
  // "session expired", which is exactly the wrong message here.
  const err = new Error(
    `SharePoint ${refused ? "refused to hand out" : "couldn't send"} ${rel} although the session is fine — ` +
      tried.join(" · ")
  );
  err.status = refused ? 403 : 0;
  err.expired = false;
  err.body = tried.join("\n");
  throw err;
}

function base64ToBytes(b64) {
  const s = String(b64 || "");
  // Native decoder where available (Firefox 133+): no intermediate binary string.
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
