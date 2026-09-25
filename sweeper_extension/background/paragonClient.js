/**
 * Paragon client (background side). Routes through content/paragon-bridge.js.
 *
 * The bridge needs the `pgn_csrf_token` cookie value for the `pgn-csrf-token`
 * header (paragon.py _get_csrf_token). Playwright read it from the browser
 * context, which sees HttpOnly cookies; a content script's document.cookie
 * might not. So we read it here with the `cookies` permission and hand it to
 * the bridge, which falls back to document.cookie if we came up empty.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "paragon",
  tabMatch: Config.PARAGON_TAB_MATCH,
  tabUrl: Config.PARAGON_TAB_URL,
  script: "content/paragon-bridge.js",
});

async function csrfToken() {
  try {
    const c = await browser.cookies.get({ url: Config.PARAGON_ORIGIN, name: Config.PARAGON_CSRF_COOKIE });
    return c && c.value ? c.value : null;
  } catch (e) {
    log.warn("paragon", "cookies.get failed:", e && e.message);
    return null;
  }
}

/** Throws (with .expired) if the Paragon session is gone. */
export async function ping() {
  const csrf = await csrfToken();
  const resp = await bridge.call({ action: "paragon:ping", csrf });
  log.debug("paragon", `ping ok (csrf via ${csrf ? "cookies API" : resp.hasCsrf ? "document.cookie" : "none"})`);
  return true;
}

/**
 * All CASE rows for one free-form Paragon query (e.g. the lobby filter).
 * Paginated from here, one page per bridge round-trip: Firefox terminates an
 * MV3 event page after ~30s without a *completed* API call, and a single
 * long-running message doesn't count. Short hops keep it alive.
 * @param {string} q
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function query(q, onProgress) {
  const csrf = await csrfToken();
  const rows = [];
  let pageNum = 1;
  for (;;) {
    const resp = await bridge.call({ action: "paragon:page", query: q, pageNum, csrf });
    rows.push(...(resp.rows || []));
    const total = resp.totalCount ?? rows.length;
    if (onProgress) onProgress(rows.length, total);
    if (rows.length >= total || !(resp.rows || []).length) break;
    pageNum += 1;
  }
  log.debug("paragon", `query returned ${rows.length} cases in ${pageNum} page(s)`);
  return rows;
}

/**
 * Batched sweep over quoted id terms, one batch per bridge round-trip
 * (see query() for why). Dedupes by case ID across batches.
 * @param {string[]} terms
 * @param {(done:number,total:number,cases:number)=>void} [onProgress]
 * @returns {{rows:object[], failedBatches:number[], batches:number}}
 */
export async function sweep(terms, onProgress) {
  const clean = [...new Set(terms.map((q) => String(q).trim()).filter(Boolean))];
  const size = Config.PARAGON_BATCH_SIZE;
  const batches = Math.ceil(clean.length / size);
  if (!batches) return { rows: [], failedBatches: [], batches: 0 };
  const csrf = await csrfToken();
  const seen = new Set();
  const rows = [];
  const failedBatches = [];
  for (let i = 0; i < batches; i++) {
    const batch = clean.slice(i * size, (i + 1) * size);
    const resp = await bridge.call({ action: "paragon:batch", terms: batch, csrf });
    if (!resp.batchOk) failedBatches.push(i + 1);
    for (const r of resp.rows || []) {
      if (r.ID && seen.has(r.ID)) continue;
      seen.add(r.ID);
      rows.push(r);
    }
    if (onProgress) onProgress(i + 1, batches, rows.length);
  }
  return { rows, failedBatches, batches };
}
