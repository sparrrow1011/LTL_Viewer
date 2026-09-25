/**
 * CST shipper source of truth — the `shipperIds` filter CST_viewer's
 * scrapers/smc.py applies to /shipper/order/search (_read_shipper_ids).
 *
 * Source order:
 *   1. SharePoint CSV (Config.SHIPPER_SOURCE.paths) via content/sp-bridge.js,
 *      cached in storage for ttlMinutes;
 *   2. a CSV the user imported in Settings (stored in browser.storage.local);
 *   3. nothing → the sweep refuses to run (an unfiltered sweep is what produced
 *      1,400+ cases from every team's shippers).
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "sharepoint",
  tabMatch: Config.SP_TAB_MATCH,
  tabUrl: Config.SP_TAB_URL,
  script: "content/sp-bridge.js",
});

const KEY_CACHE = "shippersCache"; // { ids, count, source, path, fetchedAt }
const KEY_IMPORT = "shippersImport"; // { ids, count, importedAt, name }
const MAX_IDS = 1000; // smc.py caps shipperIds per request at 1000

// Minimal RFC4180-ish parser (quoted cells with commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const ID_HEADERS = new Set(["shipperid", "shipper id", "shipper_id"]);

/** CSV text → unique numeric shipper IDs (header row required, like smc.py). */
export function shipperIdsFromCsv(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("shipper CSV is empty");
  const idx = table[0].findIndex((h) => ID_HEADERS.has(String(h).trim().toLowerCase()));
  if (idx < 0) throw new Error("shipper CSV has no 'shipperid' column");
  const ids = [];
  const seen = new Set();
  for (const r of table.slice(1)) {
    const id = String(r[idx] ?? "").trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, MAX_IDS);
}

const KEY_PATH = "shippersPath"; // last SharePoint path that worked

/** Accept a full SharePoint URL or a server-relative path; return the path. */
function toServerRelative(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch (_) {
      return null;
    }
  }
  return s.startsWith("/") ? s : `/${s}`;
}

async function readSharePoint() {
  const src = Config.SHIPPER_SOURCE;
  const tried = new Set();
  const attempts = [];

  const attempt = async (path, via) => {
    if (!path || tried.has(path)) return null;
    tried.add(path);
    try {
      const resp = await bridge.call({ action: "sp:file", serverRelativeUrl: path });
      const ids = shipperIdsFromCsv(resp.text);
      if (!ids.length) {
        attempts.push(`${path} → 0 shipper IDs`);
        return null;
      }
      log.info("shippers", `found via ${via}: ${path}`);
      return { ids, path };
    } catch (e) {
      if (e && e.expired) throw e; // sign-in problem: surface, don't fall through
      attempts.push(`${path} → ${e.message.replace(/^SharePoint file not readable /, "")}`);
      return null;
    }
  };

  const got = await browser.storage.local.get([KEY_PATH, "settings"]);
  const override = toServerRelative(got.settings && got.settings.shipperPath);
  const remembered = got[KEY_PATH] || null;

  let hit =
    (await attempt(override, "Settings override")) ||
    (await attempt(remembered, "remembered path"));
  for (const p of src.paths) if (!hit) hit = await attempt(p, "configured path");

  if (!hit && src.file) {
    // Ask SharePoint Search where the file actually lives.
    let paths = [];
    try {
      paths = (await bridge.call({ action: "sp:search", filename: src.file })).paths || [];
      log.info("shippers", `SharePoint Search for ${src.file}: ${paths.length} hit(s)`);
    } catch (e) {
      if (e && e.expired) throw e;
      attempts.push(`search → ${e.message}`);
    }
    for (const p of paths) if (!hit) hit = await attempt(p, "SharePoint Search");
  }

  if (!hit) {
    throw new Error(`shipper CSV not found. Tried: ${attempts.join("; ")}`);
  }
  await browser.storage.local.set({ [KEY_PATH]: hit.path });
  return hit;
}

export async function ping() {
  await bridge.call({ action: "sp:ping" });
  return true;
}

/**
 * Generic SharePoint REST op through the bridge (sp:req). Returns the raw
 * { ok, status, data, body, expired } so callers decide how to treat failures
 * (used by the usage roster, which must never throw into the pipeline).
 */
export async function spRequest({ method = "GET", path, body = null, etag = "*" }) {
  try {
    return await bridge.call({ action: "sp:req", method, path, body, etag });
  } catch (e) {
    // bridge.call folds a non-ok reply into an Error; keep SharePoint's own
    // error text (e.body) so a 400 says WHICH field it disliked.
    return { ok: false, status: e.status || 0, body: e.body || e.message, expired: !!e.expired, data: null };
  }
}

/** Save a user-imported CSV (Settings tab). */
export async function importCsv(text, name = "import.csv") {
  const ids = shipperIdsFromCsv(text);
  if (!ids.length) throw new Error("no shipper IDs found in that CSV");
  const rec = { ids, count: ids.length, importedAt: Date.now(), name };
  await browser.storage.local.set({ [KEY_IMPORT]: rec });
  log.info("shippers", `imported ${ids.length} shipper IDs from ${name}`);
  return { count: ids.length, name };
}

export async function clearImport() {
  await browser.storage.local.remove(KEY_IMPORT);
}

/**
 * Current shipper IDs + provenance.
 * @returns {Promise<{ids:string[], count:number, source:"sharepoint"|"import"|"none", path, fetchedAt}>}
 */
export async function getShipperIds({ force = false } = {}) {
  const got = await browser.storage.local.get([KEY_CACHE, KEY_IMPORT]);
  const cache = got[KEY_CACHE];
  const imported = got[KEY_IMPORT];
  const ttl = (Config.SHIPPER_SOURCE.ttlMinutes || 30) * 60_000;

  if (!force && cache && cache.ids && cache.ids.length && Date.now() - cache.fetchedAt < ttl) {
    log.debug("shippers", `${cache.count} IDs from cache (${cache.source}, ${cache.path})`);
    return cache;
  }

  try {
    const { ids, path } = await readSharePoint();
    const rec = { ids, count: ids.length, source: "sharepoint", path, fetchedAt: Date.now() };
    await browser.storage.local.set({ [KEY_CACHE]: rec });
    log.info("shippers", `${ids.length} CST shipper IDs from SharePoint (${path})`);
    return rec;
  } catch (e) {
    log.warn("shippers", `SharePoint shipper CSV unavailable: ${e.message}`);
    if (imported && imported.ids && imported.ids.length) {
      log.info("shippers", `using ${imported.count} imported shipper IDs (${imported.name})`);
      return { ...imported, source: "import", path: imported.name, fetchedAt: imported.importedAt };
    }
    if (cache && cache.ids && cache.ids.length) {
      log.warn("shippers", `using stale cache from ${new Date(cache.fetchedAt).toISOString()}`);
      return { ...cache, stale: true };
    }
    if (e && e.expired) throw e;
    return { ids: [], count: 0, source: "none", path: null, fetchedAt: null, error: e.message };
  }
}
