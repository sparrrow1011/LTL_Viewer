/**
 * Background service worker — the message router.
 *
 * The content-script overlay never touches SharePoint directly; it sends a
 * message like { action: "getRows", filters } and the worker dispatches to the
 * ported service layer (runsService) / store. This mirrors the Flask split where
 * the browser called /api/* and services.py did the work.
 *
 * Every handler returns { ok: true, data } or { ok: false, error } so the
 * overlay has one consistent shape to unwrap.
 */

import { Config } from "../config.js";
import * as runsService from "./runsService.js";
import * as fmcClient from "./fmcClient.js";
import * as spClient from "./spClient.js";
import * as smcClient from "./smcClient.js";
import * as control from "./control.js";
import { log } from "./debug.js";

// ── remote control (control.json on the updates branch) ────────────────────
control.init({
  url: Config.CONTROL_URL,
  version: browser.runtime.getManifest().version,
  slug: "ms-viewer",
  refreshMinutes: Config.CONTROL_REFRESH_MINUTES,
  getAlias: () => smcClient.getRequester(),
  log,
});
const CONTROL_ALARM = "ms-viewer-control";
browser.alarms.create(CONTROL_ALARM, { periodInMinutes: Config.CONTROL_REFRESH_MINUTES });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === CONTROL_ALARM) control.refresh();
});

// Actions that stay available while remotely disabled (so the overlay can
// explain itself). Everything else is refused with controlBlocked:true.
const CONTROL_EXEMPT = new Set([
  "getTeams", "checkSessions", "controlStatus", "setDebug",
  "sp:bridge-ready", "fmc:bridge-ready", "smc:bridge-ready",
]);

// ── toolbar button → open (or focus) the MS Viewer page ───────────────────────
const UI_URL = browser.runtime.getURL("ui/app.html");
browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: UI_URL });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: UI_URL });
  }
});

// Resolve the team a message is scoped to (falls back to the default team so
// older callers keep working). Throws on an unknown team.
function teamOf(msg) {
  const key = String((msg && msg.team) || Config.DEFAULT_TEAM).toUpperCase();
  if (!Config.TEAMS[key]) throw new Error(`Unknown team: ${msg && msg.team}`);
  return key;
}

/**
 * Probe each requested service with a cheap authenticated call. Returns the
 * subset that are expired/unreachable, so the overlay can block the action and
 * prompt for re-auth BEFORE doing anything.
 * @param {string[]} services  e.g. ["SharePoint", "FMC"]
 */
async function checkSessions(services) {
  const expired = [];
  // Per-service failure detail so the overlay's blocker can show the REAL
  // reason (HTTP status / redirect / bridge unreachable) instead of a generic
  // "sign-in required" that may be a false positive.
  const reasons = {};
  const jobs = services.map(async (svc) => {
    try {
      if (svc === "SharePoint") await spClient.ping();
      else if (svc === "FMC") await fmcClient.ping();
      else if (svc === "SMC") await smcClient.ping();
    } catch (e) {
      const reason = String((e && e.message) || e);
      log.warn("preflight", `${svc} pre-flight failed:`, reason);
      expired.push(svc);
      reasons[svc] = {
        message: reason,
        status: e && e.status,
        // true only when the bridge positively saw a sign-in page / 401 / 403.
        // false = the check failed for some OTHER reason (bridge not reachable,
        // tab didn't load, network) — the session may well be fine.
        expired: !!(e && e.expired),
      };
    }
  });
  await Promise.all(jobs);
  return { expired, reasons };
}

const HANDLERS = {
  // ── teams ──
  // The team map (content scripts can't import config.js). Returned as plain
  // JSON so the overlay can drive the picker, SMC query and toolbar defaults.
  getTeams: () => ({ defaultTeam: Config.DEFAULT_TEAM, teams: Config.TEAMS }),

  // ── reads (all team-scoped via msg.team) ──
  // SharePoint records ({ "orderid|vrid": {annotation fields} }) for the
  // overlay to merge onto the SMC rows.
  getRecords: (msg) => runsService.getRecords(teamOf(msg)),

  // Shipper source of truth: { shippers: {shipperid: {...}}, source, path, count }.
  // Read from the team's SharePoint CSV (CST_viewer's source_of_truth_crawler.csv),
  // falling back to the team's SharePoint list. msg.force bypasses the cache.
  getShippers: (msg) => runsService.getShippers(teamOf(msg), { force: !!msg.force }),
  // Replace the team's shipper list with msg.rows.
  importShippers: (msg) => runsService.importShippers(teamOf(msg), msg.rows || []),

  // Session pre-flight: check whether the given services are authenticated.
  // Returns { expired: string[] } listing any that need re-auth.
  checkSessions: (msg) => checkSessions(msg.services || []),

  // ── SMC (via the SMC-tab bridge) ──
  // Loads still needing sourcing for the window: { rows }.
  smcSourcingRows: (msg) => smcClient.fetchSourcingRows(msg.win || {}, msg.opts || {}),
  // Signed-in alias: { requester }.
  smcRequester: async () => ({ requester: await smcClient.getRequester() }),
  // Direct lookup of order IDs / VRIDs (not limited to "needs sourcing"): { rows, found, missing }.
  smcLookup: (msg) => smcClient.lookupByIds(msg.ids || [], msg.win || {}, msg.opts || {}),

  // Live FMC records ({ vrid: {status, carrier, tour, times, stop refs} }).
  fmcStatuses: (msg) => fmcClient.getFmcStatuses(msg.vrids || []),
  // FMC criteria search — the load-list SOURCE (accounts × carriers × window).
  fmcSearch: (msg) => fmcClient.searchFmc(msg.criteria || {}),
  // Lazy address resolution (EML time): [{vrid, orig, dest}] -> {vrid:{orig_address,dest_address}}.
  fmcAddresses: (msg) => fmcClient.getFmcAddresses(msg.items || []),

  // ── manual-source + email mutations (all keyed by orderid + vrid) ──
  toggleManualSource: (msg) => runsService.toggleManualSource(teamOf(msg), msg),
  toggleEmailSent: (msg) => runsService.toggleEmailSent(teamOf(msg), msg),
  markEmailsSent: (msg) => runsService.markEmailsSent(teamOf(msg), msg.keys || [], msg.user),
  markEmailsGenerated: (msg) =>
    runsService.markEmailsGenerated(teamOf(msg), msg.keys || [], msg.user),

  // ── outcome sweep: mark recent worked records "covered" once FMC shows a
  //    real carrier on the VRID. Best-effort (FMC unavailable → skipped). ──
  sweepOutcomes: (msg) => runsService.sweepOutcomes(teamOf(msg), { days: msg.days }),
  // Auto-track every run currently on the sourcing list (msg.rows =
  // [{orderid, vrid, ...snapshot}]) so RLB pickups show up as outcomes too.
  trackSeen: (msg) => runsService.trackSeen(teamOf(msg), msg.rows || []),

  // ── remote control: identity + verdict; msg.refresh forces a re-read ──
  controlStatus: async (msg) => {
    if (msg.refresh) await control.refresh();
    return control.status();
  },

  // ── debug toggle (propagated from the overlay's Debug button) ──
  setDebug: (msg) => {
    if (msg.enabled) log.enable();
    else log.disable();
    return { enabled: log.enabled };
  },

  // ── bridges announcing themselves ──
  "sp:bridge-ready": (msg) => {
    log.info("sp", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
  "fmc:bridge-ready": (msg) => {
    log.info("fmc", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
  "smc:bridge-ready": (msg) => {
    log.info("smc", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
};

browser.runtime.onMessage.addListener((msg) => {
  const action = msg && msg.action;
  const handler = HANDLERS[action];
  if (!handler) {
    log.warn("router", `unknown action: ${action}`);
    return Promise.resolve({ ok: false, error: `Unknown action: ${action}` });
  }
  log.info("router", `→ ${action}`, msg);
  // Return a promise so the overlay can await the response.
  return log
    .time(`action:${action}`, () =>
      Promise.resolve()
        .then(() => (CONTROL_EXEMPT.has(action) ? null : control.assertAllowed(action)))
        .then(() => handler(msg))
    )
    .then((data) => {
      log.debug("router", `✓ ${action}`, data);
      return { ok: true, data };
    })
    .catch((err) => {
      // Full detail (incl. SpError HTTP status + body) goes to the console;
      // a structured error goes back to the overlay so it can show specifics.
      log.error(`action:${action}`, err);
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        status: err && err.status,
        body: err && err.body,
        expired: !!(err && err.expired),
        controlBlocked: !!(err && err.controlBlocked),
      };
    });
});

log.info("worker", `ready (debug=${log.enabled ? "on" : "off"})`);
