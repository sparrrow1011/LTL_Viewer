/**
 * Records service — the manual-sourcing + email annotations layer.
 *
 * DATA MODEL (post-redesign): the load list comes from SMC (read source of
 * truth, fetched client-side). SharePoint stores ONLY the work we do on top —
 * one "record" per (orderid, vrid), holding manual-source + email-state fields.
 * The overlay merges these records onto the SMC rows by key `orderid|vrid`.
 *
 * Every entry point is TEAM-scoped: the team picks which SharePoint list holds
 * the records (Config.TEAMS[team].spList). Teams with a `shipperList` also get
 * a shipper source-of-truth store here (getShippers / importShippers).
 *
 * Acting user comes from the SMC requester alias (passed per call as `user`),
 * falling back to "DesktopUser" if unavailable.
 */

import * as store from "./sharepointStore.js";
import { spGetFileText, spSearchFilePaths, SpError } from "./spClient.js";
import * as fmcClient from "./fmcClient.js";
import { log } from "./debug.js";

const DEFAULT_USER = "DesktopUser";
// Normalize an incoming user (SMC requester alias) with a safe fallback.
function actingUser(u) {
  const s = (u == null ? "" : String(u)).trim();
  return s || DEFAULT_USER;
}

// The annotation fields a record carries (besides the orderid/vrid identity).
const RECORD_FIELDS = [
  "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
  "email_sent", "email_sent_count", "email_sent_confirmed_at", "email_sent_by",
  "email_generated_at",
];

// Load-context snapshot captured from the SMC/FMC row at save time, so history
// exports are self-contained after the load has left the sourcing list. The
// overlay passes these along with each mutation; non-empty values overwrite.
export const SNAPSHOT_FIELDS = [
  "shippername", "shipper_group", "orig_node", "dest_node", "orig_country",
  "dest_country", "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
  "vehicle_carrier", "tour_id", "freight_type",
  // FMC-sourced context: FM/MM tag + the shipper account that identifies MM runs.
  "mile", "shipper_account",
];

function applySnapshot(rec, snap) {
  if (!snap) return;
  for (const f of SNAPSHOT_FIELDS) {
    const v = snap[f];
    if (v != null && String(v).trim() !== "") rec[f] = v;
  }
}

// Outcome of the sourcing work, written by sweepOutcomes() from FMC: once a
// real carrier (not a placeholder) shows up on the VRID the record is "covered".
export const OUTCOME_FIELDS = [
  "final_carrier", "final_carrier_name", "final_status", "covered_at", "outcome_checked_at",
];

// Auto-tracking: every run that appears on the sourcing list gets a record
// (trackSeen), so runs covered WITHOUT our intervention (RLB pickups) are
// visible as outcomes too. A record with none of the work flags is "seen-only".
export const TRACK_FIELDS = ["first_seen_at", "last_seen_at"];

function isWorked(rec) {
  return truthy(rec.is_manual_source) || !!rec.email_generated_at || truthy(rec.email_sent);
}

function truthy(val) {
  if (typeof val === "boolean") return val;
  return ["1", "true", "yes"].includes(String(val).trim().toLowerCase());
}
function nowIso() {
  return new Date().toISOString();
}

function keyOf(orderid, vrid) {
  return `${String(orderid ?? "")}|${String(vrid ?? "")}`;
}

/** A blank record shell for a given identity. */
function blankRecord(orderid, vrid) {
  return {
    orderid: String(orderid ?? ""),
    vrid: String(vrid ?? ""),
    is_manual_source: 0,
    sims: null,
    ms_cost: null,
    manual_source_by: null,
    manual_source_date: null,
    email_sent: false,
    email_sent_count: 0,
    email_sent_confirmed_at: null,
    email_sent_by: null,
    email_generated_at: null,
  };
}

// ── read: all records as a { "orderid|vrid": record } map ─────────────────────

/**
 * Return every saved record keyed by orderid|vrid, for the overlay to merge onto
 * the SMC rows. Only the RECORD_FIELDS (+ identity) are meaningful.
 */
export async function getRecords(team) {
  const rows = await store.loadRuns(team);
  const out = {};
  for (const r of rows) {
    const k = keyOf(r.orderid, r.vrid);
    const rec = { orderid: String(r.orderid ?? ""), vrid: String(r.vrid ?? "") };
    for (const f of RECORD_FIELDS) rec[f] = r[f] ?? blankRecord()[f];
    for (const f of SNAPSHOT_FIELDS) if (r[f] != null) rec[f] = r[f];
    for (const f of OUTCOME_FIELDS) if (r[f] != null) rec[f] = r[f];
    for (const f of TRACK_FIELDS) if (r[f] != null) rec[f] = r[f];
    out[k] = rec;
  }
  return out;
}

/** Load records as an index Map for internal mutation. */
async function loadIndex(team) {
  const rows = await store.loadRuns(team);
  const idx = new Map();
  for (const r of rows) idx.set(keyOf(r.orderid, r.vrid), r);
  return idx;
}

async function saveIndex(team, idx) {
  await store.saveRuns(team, [...idx.values()]);
}

/** Get-or-create the record for an identity within an index. */
function ensureRecord(idx, orderid, vrid) {
  const k = keyOf(orderid, vrid);
  let rec = idx.get(k);
  if (!rec) {
    rec = blankRecord(orderid, vrid);
    idx.set(k, rec);
  }
  return rec;
}

// ── manual-source toggle (per orderid|vrid) ───────────────────────────────────

export async function toggleManualSource(team, data = {}) {
  const orderid = data.orderid;
  const vrid = data.vrid;
  const newValue = Boolean(data.value);
  const sims = data.sims;
  const msCost = data.ms_cost;
  const user = actingUser(data.user);

  if (!vrid || !orderid)
    return { status: "error", message: "orderid and vrid are required" };
  if (newValue && !sims)
    return { status: "error", message: "SIMS is required when enabling manual source" };

  const idx = await loadIndex(team);
  const now = nowIso();

  if (newValue) {
    const rec = ensureRecord(idx, orderid, vrid);
    applySnapshot(rec, data.snapshot);
    rec.is_manual_source = 1;
    rec.sims = sims;
    rec.ms_cost = msCost ?? null;
    rec.manual_source_by = user;
    if (!rec.manual_source_date) rec.manual_source_date = now;
  } else {
    // Disabling clears the manual-source fields. Keep the record if it still
    // carries email state or is auto-tracked (seen on the list); otherwise drop.
    const k = keyOf(orderid, vrid);
    const rec = idx.get(k);
    if (rec) {
      rec.is_manual_source = 0;
      rec.sims = null;
      rec.ms_cost = null;
      rec.manual_source_by = null;
      rec.manual_source_date = null;
      if (!rec.email_generated_at && !truthy(rec.email_sent) && !rec.first_seen_at) idx.delete(k);
    }
  }

  await saveIndex(team, idx);
  return { status: "ok" };
}

// ── email state ────────────────────────────────────────────────────────────────

function applyEmailSent(rec, sent, user) {
  if (sent) {
    const already = truthy(rec.email_sent);
    rec.email_sent = true;
    if (!already) {
      rec.email_sent_count = Number(rec.email_sent_count || 0) + 1;
      rec.email_sent_confirmed_at = nowIso();
    }
    rec.email_sent_by = user;
  } else {
    rec.email_sent = false;
  }
}

/** Toggle a single record's sent flag. Expects { orderid, vrid, value, user }. */
export async function toggleEmailSent(team, data = {}) {
  const { orderid, vrid } = data;
  const newValue = truthy(data.value);
  const user = actingUser(data.user);
  if (!vrid || !orderid)
    return { status: "error", message: "orderid and vrid are required" };

  const idx = await loadIndex(team);
  const rec = ensureRecord(idx, orderid, vrid);
  applySnapshot(rec, data.snapshot);
  applyEmailSent(rec, newValue, user);
  await saveIndex(team, idx);
  return { status: "ok" };
}

/**
 * Mark a batch sent. Expects keys = [{orderid, vrid, ...snapshot fields}, ...]
 * (extra fields on each key are the load-context snapshot).
 */
export async function markEmailsSent(team, keys, user) {
  if (!keys || !keys.length)
    return { status: "error", message: "No rows provided" };
  const u = actingUser(user);
  const idx = await loadIndex(team);
  for (const key of keys) {
    const { orderid, vrid } = key;
    if (!orderid || !vrid) continue;
    const rec = ensureRecord(idx, orderid, vrid);
    applySnapshot(rec, key);
    applyEmailSent(rec, true, u);
  }
  await saveIndex(team, idx);
  return { status: "ok" };
}

/** Mark a batch email-generated (Pending). Expects keys = [{orderid, vrid, ...snapshot}]. */
export async function markEmailsGenerated(team, keys, user) {
  if (!keys || !keys.length)
    return { status: "error", message: "No rows provided" };
  const u = actingUser(user);
  const now = nowIso();
  const idx = await loadIndex(team);
  for (const key of keys) {
    const { orderid, vrid } = key;
    if (!orderid || !vrid) continue;
    const rec = ensureRecord(idx, orderid, vrid);
    applySnapshot(rec, key);
    rec.email_sent = false;
    rec.email_sent_by = u;
    rec.email_sent_confirmed_at = null;
    rec.email_generated_at = now;
  }
  await saveIndex(team, idx);
  return { status: "ok" };
}

// ── auto-track: record every run that appears on the sourcing list ────────────

/**
 * Upsert a "seen" record for each row currently on the sourcing list.
 * rows = [{orderid, vrid, ...snapshot fields}]. New runs get first_seen_at;
 * existing ones get last_seen_at bumped at most once a day (to keep SharePoint
 * writes down). Snapshot fields are refreshed with non-empty values.
 * @returns {{added, updated, total}}
 */
export async function trackSeen(team, rows) {
  const cfg = store.teamConfig(team);
  if (!rows || !rows.length) return { added: 0, updated: 0, total: 0 };
  const idx = await loadIndex(cfg.key);
  const now = nowIso();
  const dayAgo = Date.now() - 86_400_000;
  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const { orderid, vrid } = row;
    if (!orderid || !vrid) continue;
    const k = keyOf(orderid, vrid);
    let rec = idx.get(k);
    if (!rec) {
      rec = blankRecord(orderid, vrid);
      idx.set(k, rec);
      rec.first_seen_at = now;
      rec.last_seen_at = now;
      applySnapshot(rec, row);
      added += 1;
      continue;
    }
    let changed = false;
    if (!rec.first_seen_at) {
      // Worked before tracking existed: best-effort backfill from its activity.
      rec.first_seen_at = rec.manual_source_date || rec.email_generated_at || now;
      changed = true;
    }
    const last = rec.last_seen_at ? new Date(rec.last_seen_at).getTime() : 0;
    if (last < dayAgo) {
      rec.last_seen_at = now;
      applySnapshot(rec, row);
      changed = true;
    }
    if (changed) updated += 1;
  }
  if (added || updated) await saveIndex(cfg.key, idx);
  log.info("track", `${cfg.key}: seen ${rows.length} → +${added} ~${updated}`);
  return { added, updated, total: idx.size };
}

// ── outcome sweep: did the run get covered (by us, or by RLB on its own)? ─────

function latestActivityMs(rec) {
  const ts = [
    rec.manual_source_date, rec.email_generated_at, rec.email_sent_confirmed_at,
    rec.last_seen_at, rec.first_seen_at,
  ]
    .map((v) => (v ? new Date(String(v).replace(" ", "T")).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : 0;
}

/**
 * Look up recent worked records (manual sourced or email generated) in FMC and
 * mark the ones that now carry a real carrier as covered.
 *
 * "Covered" = FMC carrier present and not one of the team's placeholder
 * carriers (Config.TEAMS[x].carrierDefaults, e.g. RLB1/AZNG/DUMMY). Once
 * covered, a record is never re-checked. Open records are re-checked on every
 * sweep while their latest activity is within `days`.
 *
 * FMC unavailability is reported, not thrown: the sweep is best-effort.
 * @returns {{checked, covered, open, skipped?: string}}
 */
export async function sweepOutcomes(team, { days } = {}) {
  const cfg = store.teamConfig(team);
  const windowDays = Number(days) || Number(cfg.outcomeSweepDays) || 30;
  // Same "not yet sourced" definition the overlay uses to build the list
  // (sourcing.placeholderCarriers + placeholderCarrierPrefixes), so a run the
  // overlay would still show as needing sourcing is never counted as covered.
  const src = cfg.sourcing || {};
  const placeholders = new Set(
    (src.placeholderCarriers || cfg.carrierDefaults || ["RLB1", "AZNG", "DUMMY"]).map((c) =>
      String(c).trim().toUpperCase()
    )
  );
  const prefixes = (src.placeholderCarrierPrefixes || []).map((p) => String(p).trim().toUpperCase()).filter(Boolean);
  const isPlaceholder = (c) => placeholders.has(c) || prefixes.some((p) => c.startsWith(p));
  const cutoff = Date.now() - windowDays * 86_400_000;

  const idx = await loadIndex(cfg.key);

  // Retention: seen-only records (never worked) are dropped `retentionDays`
  // after they were last seen on the list. Worked records are kept forever.
  const retentionDays = Number(cfg.retentionDays) || 180;
  const retainCutoff = Date.now() - retentionDays * 86_400_000;
  let expired = 0;
  for (const [k, rec] of idx) {
    if (isWorked(rec)) continue;
    const last = latestActivityMs(rec);
    if (last && last < retainCutoff) {
      idx.delete(k);
      expired += 1;
    }
  }

  // Every tracked run (worked or just seen) that isn't covered yet.
  const candidates = [];
  for (const rec of idx.values()) {
    if (rec.covered_at) continue;
    if (!isWorked(rec) && !rec.first_seen_at) continue; // nothing to track
    if (!String(rec.vrid ?? "").trim()) continue;
    if (latestActivityMs(rec) < cutoff) continue;
    candidates.push(rec);
  }
  if (!candidates.length) {
    if (expired) await saveIndex(cfg.key, idx);
    return { checked: 0, covered: 0, open: 0, expired };
  }

  let fmc;
  try {
    fmc = (await fmcClient.getFmcStatuses(candidates.map((r) => r.vrid))).records || {};
  } catch (e) {
    log.warn("outcomes", `${cfg.key}: FMC lookup skipped — ${e && e.message}`);
    if (expired) await saveIndex(cfg.key, idx);
    return {
      checked: 0, covered: 0, open: candidates.length, expired,
      skipped: String(e && e.message ? e.message : e),
    };
  }

  const now = nowIso();
  let covered = 0;
  let coveredMs = 0;
  let changed = expired > 0;
  for (const rec of candidates) {
    const f = fmc[String(rec.vrid).trim()];
    if (!f) continue;
    const carrier = String(f.vehicle_carrier ?? "").trim();
    const isReal = carrier !== "" && !isPlaceholder(carrier.toUpperCase());
    // Bump the check timestamp at most hourly so an open record isn't
    // re-written to SharePoint on every sweep.
    const lastChecked = rec.outcome_checked_at ? new Date(rec.outcome_checked_at).getTime() : 0;
    if (isReal || Date.now() - lastChecked > 3_600_000) {
      rec.outcome_checked_at = now;
      changed = true;
    }
    if (f.vehicle_execution_status && rec.final_status !== f.vehicle_execution_status) {
      rec.final_status = f.vehicle_execution_status;
      changed = true;
    }
    if (isReal) {
      rec.final_carrier = carrier;
      rec.final_carrier_name = f.carrier_name || null;
      rec.covered_at = now;
      covered += 1;
      if (truthy(rec.is_manual_source)) coveredMs += 1;
      changed = true;
    }
  }
  if (changed) await saveIndex(cfg.key, idx);

  const result = {
    checked: candidates.length,
    covered,
    coveredMs,
    coveredRlb: covered - coveredMs,
    open: candidates.length - covered,
    expired,
  };
  log.info("outcomes", `${cfg.key}: ${JSON.stringify(result)}`);
  return result;
}

// ── shipper source of truth (teams with Config.TEAMS[team].shipperList) ────────

const SHIPPER_FIELDS = ["shipperid", "shippername", "shipper_group"];

/** Normalize one shipper row; returns null for junk (no numeric shipperid). */
function cleanShipper(raw) {
  const shipperid = String(raw.shipperid ?? "").trim();
  if (!/^\d+$/.test(shipperid)) return null; // drops header/blank/"Shipper ID" rows
  return {
    shipperid,
    shippername: String(raw.shippername ?? "").trim(),
    shipper_group: String(raw.shipper_group ?? "").trim(),
  };
}

// ── shipper CSV from a SharePoint document library ────────────────────────────

// Minimal RFC4180-ish parser (quoted cells with commas/newlines). Returns rows
// of cells; blank lines dropped.
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

const SHIPPER_HEADER_ALIASES = {
  shipperid: "shipperid", "shipper id": "shipperid", shipper_id: "shipperid",
  shippername: "shippername", "shipper name": "shippername", shipper_name: "shippername", shipper: "shippername",
  shipper_group: "shipper_group", "shipper group": "shipper_group", group: "shipper_group", dept: "shipper_group",
};

/** CSV text -> { shipperid: shipper } (junk rows dropped). Throws if no shipperid column. */
function shippersFromCsv(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("shipper CSV is empty");
  const header = table[0].map((h) => SHIPPER_HEADER_ALIASES[String(h).trim().toLowerCase()] || null);
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

// In-memory cache per team: { shippers, source, path, fetchedAt }.
const _shipperCache = new Map();
const PATH_STORAGE_KEY = (team) => `ltl.shipperPath.${team}`;

async function _storedPath(team) {
  try {
    const got = await browser.storage.local.get(PATH_STORAGE_KEY(team));
    return got && got[PATH_STORAGE_KEY(team)] ? String(got[PATH_STORAGE_KEY(team)]) : null;
  } catch {
    return null;
  }
}
async function _storePath(team, path) {
  try {
    await browser.storage.local.set({ [PATH_STORAGE_KEY(team)]: path });
  } catch {
    /* best effort */
  }
}

/**
 * Try to read the shipper CSV from SharePoint. Returns { shippers, path } or
 * null if no candidate path works. Session expiry is re-thrown so the overlay
 * can prompt for sign-in instead of silently falling back.
 */
async function _shippersFromSharePointFile(team, src) {
  const tried = new Set();
  const candidates = [];
  const stored = await _storedPath(team);
  if (stored) candidates.push(stored);
  for (const p of src.paths || []) candidates.push(p);

  const attempt = async (path) => {
    if (!path || tried.has(path)) return null;
    tried.add(path);
    try {
      const text = await spGetFileText(path);
      const shippers = shippersFromCsv(text);
      if (!Object.keys(shippers).length) {
        log.warn("shippers", `${path}: parsed 0 valid shippers`);
        return null;
      }
      return { shippers, path };
    } catch (e) {
      if (e instanceof SpError && e.expired) throw e;
      log.debug("shippers", `${path}: ${e && e.message}`);
      return null;
    }
  };

  for (const p of candidates) {
    const hit = await attempt(p);
    if (hit) return hit;
  }
  // Last resort: ask SharePoint Search where the file lives.
  if (src.file) {
    for (const p of await spSearchFilePaths(src.file)) {
      const hit = await attempt(p);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Return the team's shippers:
 *   { shippers: { shipperid: {shipperid, shippername, shipper_group} },
 *     source: "file" | "list" | "none", path, count, fetchedAt }
 *
 * Order: SharePoint CSV file (Config.TEAMS[x].shipperSource, cached for
 * ttlMinutes) → the team's SharePoint list (manual import) → empty.
 * `force` bypasses the cache.
 */
export async function getShippers(team, { force = false } = {}) {
  const cfg = store.teamConfig(team);
  if (!cfg.shipperList && !cfg.shipperSource) {
    return { shippers: {}, source: "none", path: null, count: 0, fetchedAt: null };
  }

  const src = cfg.shipperSource;
  const cached = _shipperCache.get(cfg.key);
  const ttlMs = ((src && src.ttlMinutes) || 30) * 60_000;
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) return cached;

  let result = null;
  if (src) {
    const hit = await _shippersFromSharePointFile(cfg.key, src);
    if (hit) {
      await _storePath(cfg.key, hit.path);
      result = { shippers: hit.shippers, source: "file", path: hit.path };
      log.info("shippers", `${cfg.key}: ${Object.keys(hit.shippers).length} from ${hit.path}`);
    } else {
      log.warn("shippers", `${cfg.key}: shipper CSV not found in SharePoint — falling back to list`);
    }
  }

  if (!result && cfg.shipperList) {
    const rows = await store.loadShippers(cfg.key);
    const shippers = {};
    for (const r of rows) {
      const s = cleanShipper(r);
      if (s) shippers[s.shipperid] = s;
    }
    result = {
      shippers,
      source: Object.keys(shippers).length ? "list" : "none",
      path: cfg.shipperList,
    };
  }

  if (!result) result = { shippers: {}, source: "none", path: null };
  result.count = Object.keys(result.shippers).length;
  result.fetchedAt = Date.now();
  _shipperCache.set(cfg.key, result);
  return result;
}

/**
 * Replace the team's shipper list with `rows` ([{shipperid, shippername,
 * shipper_group}]). Junk rows are dropped; duplicates collapse (last wins).
 */
export async function importShippers(team, rows) {
  const cfg = store.teamConfig(team);
  if (!cfg.shipperList)
    return { status: "error", message: `Team ${cfg.key} has no shipper list` };
  const byId = new Map();
  for (const raw of rows || []) {
    const s = cleanShipper(raw);
    if (s) byId.set(s.shipperid, s);
  }
  if (!byId.size) return { status: "error", message: "No valid shipper rows found" };
  const result = await store.saveShippers(team, [...byId.values()]);
  _shipperCache.delete(store.teamConfig(team).key); // next getShippers re-reads
  return { status: "ok", ...result, fields: SHIPPER_FIELDS };
}
