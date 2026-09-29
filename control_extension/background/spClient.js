/**
 * SharePoint REST client — delegates to the SharePoint-origin bridge.
 *
 * The background's own fetch to SharePoint does NOT carry the user's session,
 * so every REST op is forwarded to content/sp-bridge.js, which runs ON a
 * SharePoint tab and fetches same-origin with the real cookies.
 *
 * Read-only here: the roster list is written by the controlled add-ons.
 */

import { Config } from "../config.js";
import { log } from "./debug.js";
import { makeBridge } from "./bridgeClient.js";

const SP_TAB_URL = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}`;
const SP_MATCH = `${Config.SP_ORIGIN}${Config.SP_SITE_PATH}/*`;

const bridge = makeBridge({ name: "sp", tabMatch: SP_MATCH, tabUrl: SP_TAB_URL, script: "content/sp-bridge.js" });

export class SpError extends Error {
  constructor(message, status = 0, body = "") {
    super(message);
    this.name = "SpError";
    this.status = status;
    this.body = body;
    this.expired = status === 401 || status === 403;
    if (this.expired) this.message = "SharePoint session expired — open the SharePoint tab, sign in, then retry.";
  }
}

async function bridgeRequest({ method = "GET", path, body = null, etag = "*" }) {
  const tab = await bridge.ensureTab();
  if (!tab) {
    throw new SpError(`No SharePoint tab on ${SP_TAB_URL} (it was probably redirected to sign in). Open it, sign in, then retry.`, 401, "");
  }
  let resp;
  try {
    resp = await bridge.send(tab, { action: "sp:req", method, path, body, etag });
  } catch (e) {
    const err = new SpError(String((e && e.message) || e), 0, "");
    err.permission = !!(e && e.permission);
    throw err;
  }
  if (!resp || !resp.bridge) throw new SpError("SharePoint bridge returned no response", 0, JSON.stringify(resp));
  return resp;
}

/** GET a REST path (relative to `_api`), following @odata.nextLink paging when asked. */
export async function spGet(path, { paged = false } = {}) {
  if (!paged) {
    log.debug("GET", path);
    const r = await bridgeRequest({ method: "GET", path });
    if (!r.ok) throw new SpError(`GET ${path} → HTTP ${r.status}`, r.status, r.body);
    return r.data;
  }
  const all = [];
  let next = path;
  while (next) {
    const r = await bridgeRequest({ method: "GET", path: next });
    if (!r.ok) throw new SpError(`GET ${next} → HTTP ${r.status}`, r.status, r.body);
    const data = r.data || {};
    if (Array.isArray(data.value)) all.push(...data.value);
    next = data["@odata.nextLink"] || data["odata.nextLink"] || null;
  }
  return { value: all };
}

/** Write helper (POST / MERGE / DELETE tunneled through POST). Used to prune roster rows. */
export async function spWrite(path, { method = "POST", body = null, etag = "*" } = {}) {
  log.debug("WRITE", `${method} ${path}`);
  const r = await bridgeRequest({ method, path, body, etag });
  if (!r.ok) throw new SpError(`${method} ${path} → HTTP ${r.status}`, r.status, r.body);
  return r.data;
}

export function listPath(listTitle, suffix = "") {
  return `/web/lists/getbytitle('${encodeURIComponent(listTitle)}')${suffix}`;
}

/** Cheap authenticated probe for the session pre-flight. */
export async function ping() {
  await spGet("/web?$select=Title");
  return true;
}

/** Site URL of a list (for the "open in SharePoint" link). */
export function listUrl(listTitle) {
  return `${SP_TAB_URL}/Lists/${encodeURIComponent(listTitle)}/AllItems.aspx`;
}
