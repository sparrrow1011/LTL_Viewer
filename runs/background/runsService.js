/**
 * All Runs — the small amount of background logic the dashboard needs.
 *
 * The page orchestrates the load itself (sessions → shippers → SMC → FMC in
 * chunks) with one short message per step, so no single message keeps the
 * event page awaiting for ~30s. This module supplies: the pickup window, the
 * SMC options, the UI config, and the local cache of the last result so the
 * page can paint immediately on open.
 */

import { teamConfig } from "./shippers.js";

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Today ± the configured days, as local "YYYY-MM-DD" bounds. */
export function pickupWindow(team) {
  const cfg = teamConfig(team);
  const t = new Date();
  return {
    start: isoOf(addDays(t, -(cfg.runs.daysBack || 0))),
    end: isoOf(addDays(t, cfg.runs.daysForward || 0)),
    today: isoOf(t),
  };
}

/** Options forwarded to the SMC bridge: the "everything" query, no shipper scope. */
export function smcOptions(team) {
  const cfg = teamConfig(team);
  return {
    query: cfg.smcQuery,
    sourcing: { requireVrid: !!cfg.requireVrid, requireNoCarrier: false, excludeFreightTypes: [] },
    pageSize: cfg.smcPageSize || 200,
  };
}

/** What the page needs from config (it can't import config.js). */
export function uiConfig(team, hostOrigins) {
  const cfg = teamConfig(team);
  return {
    key: cfg.key,
    label: cfg.label,
    elexGroup: cfg.elexGroup,
    hostOrigins,
    ...cfg.runs,
  };
}

// ── last result cache (browser.storage.local) ────────────────────────────────
const CACHE_KEY = (team) => `runs.last.${team}`;

export async function loadCache(team) {
  const key = CACHE_KEY(teamConfig(team).key);
  const got = await browser.storage.local.get(key);
  return got && got[key] ? got[key] : null;
}

export async function saveCache(team, payload) {
  const key = CACHE_KEY(teamConfig(team).key);
  await browser.storage.local.set({ [key]: payload });
  return { saved: true, rows: (payload && payload.rows && payload.rows.length) || 0 };
}
