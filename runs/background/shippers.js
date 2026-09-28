/**
 * CST shipper source of truth — `source_of_truth_crawler.csv` on SharePoint.
 *
 * In this extension the file does NOT scope the SMC query (every run is
 * pulled). It only tags each run: shipper in the file → CST, and CST - ELEX
 * when its shipper_group says so; not in the file → FTL.
 *
 * Resolution order: the path that worked last time → each configured path →
 * SharePoint Search by file name. Cached in memory for `ttlMinutes`.
 */

import { Config } from "../config.js";
import { spGetFileText, spSearchFilePaths, SpError } from "./spClient.js";
import { log } from "./debug.js";

export const SHIPPER_FIELDS = ["shipperid", "shippername", "shipper_group"];

export function teamConfig(team) {
  const key = String(team || Config.DEFAULT_TEAM).toUpperCase();
  const cfg = Config.TEAMS[key];
  if (!cfg) throw new Error(`Unknown team: ${team}`);
  return cfg;
}

/** Normalize one shipper row; returns null for junk (no numeric shipperid). */
function cleanShipper(raw) {
  const shipperid = String(raw.shipperid ?? "").trim();
  if (!/^\d+$/.test(shipperid)) return null;
  return {
    shipperid,
    shippername: String(raw.shippername ?? "").trim(),
    shipper_group: String(raw.shipper_group ?? "").trim(),
  };
}

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

const HEADER_ALIASES = {
  shipperid: "shipperid", "shipper id": "shipperid", shipper_id: "shipperid",
  shippername: "shippername", "shipper name": "shippername", shipper_name: "shippername", shipper: "shippername",
  shipper_group: "shipper_group", "shipper group": "shipper_group", group: "shipper_group", dept: "shipper_group",
};

/** CSV text -> { shipperid: shipper }. Throws if there's no shipperid column. */
export function shippersFromCsv(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("shipper CSV is empty");
  const header = table[0].map((h) => HEADER_ALIASES[String(h).trim().toLowerCase()] || null);
  if (!header.includes("shipperid")) throw new Error("shipper CSV has no 'shipperid' column");
  const out = {};
  for (const r of table.slice(1)) {
    const obj = {};
    header.forEach((k, i) => {
      if (k) obj[k] = String(r[i] ?? "").trim();
    });
    const s = cleanShipper(obj);
    if (s) out[s.shipperid] = s;
  }
  return out;
}

const _cache = new Map(); // team -> { shippers, source, path, count, fetchedAt }
const PATH_KEY = (team) => `runs.shipperPath.${team}`;

async function storedPath(team) {
  try {
    const got = await browser.storage.local.get(PATH_KEY(team));
    return got && got[PATH_KEY(team)] ? String(got[PATH_KEY(team)]) : null;
  } catch {
    return null;
  }
}
async function storePath(team, path) {
  try {
    await browser.storage.local.set({ [PATH_KEY(team)]: path });
  } catch {
    /* best effort */
  }
}

/**
 * Try each candidate path. Session expiry is re-thrown so the UI can prompt for
 * sign-in instead of silently tagging nothing.
 */
async function fromSharePointFile(team, src) {
  const tried = new Set();
  const candidates = [];
  const last = await storedPath(team);
  if (last) candidates.push(last);
  for (const p of src.paths || []) candidates.push(p);

  const attempt = async (path) => {
    if (!path || tried.has(path)) return null;
    tried.add(path);
    try {
      const shippers = shippersFromCsv(await spGetFileText(path));
      if (!Object.keys(shippers).length) {
        log.warn("shippers", `${path}: parsed 0 valid shippers`);
        return null;
      }
      return { shippers, path };
    } catch (e) {
      // Sign-in and site-access problems must surface, not fall through to
      // "no shippers" (which would silently tag every run FTL).
      if (e instanceof SpError && (e.expired || e.permission)) throw e;
      log.debug("shippers", `${path}: ${e && e.message}`);
      return null;
    }
  };

  for (const p of candidates) {
    const hit = await attempt(p);
    if (hit) return hit;
  }
  if (src.file) {
    for (const p of await spSearchFilePaths(src.file)) {
      const hit = await attempt(p);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The CST shippers.
 * @returns {Promise<{shippers: Record<string, object>, source: "file"|"none", path, count, fetchedAt}>}
 */
export async function getShippers(team, { force = false } = {}) {
  const cfg = teamConfig(team);
  const src = cfg.shipperSource;
  if (!src) return { shippers: {}, source: "none", path: null, count: 0, fetchedAt: null };

  const cached = _cache.get(cfg.key);
  const ttlMs = (src.ttlMinutes || 30) * 60_000;
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) return cached;

  let result;
  const hit = await fromSharePointFile(cfg.key, src);
  if (hit) {
    await storePath(cfg.key, hit.path);
    result = { shippers: hit.shippers, source: "file", path: hit.path };
    log.info("shippers", `${cfg.key}: ${Object.keys(hit.shippers).length} from ${hit.path}`);
  } else {
    log.warn("shippers", `${cfg.key}: shipper CSV not found in SharePoint`);
    result = { shippers: {}, source: "none", path: null };
  }
  result.count = Object.keys(result.shippers).length;
  result.fetchedAt = Date.now();
  _cache.set(cfg.key, result);
  return result;
}
