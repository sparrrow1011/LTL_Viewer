/**
 * All Runs — background event page (message router).
 *
 * The page (ui/runs.html) talks only to us; we reach SMC / FMC / SharePoint
 * through content-script bridges on tabs of those origins. Every message
 * carries `team` (only "ALL" exists today).
 */

import { Config } from "../config.js";
import * as runsService from "./runsService.js";
import * as shippers from "./shippers.js";
import * as spClient from "./spClient.js";
import * as smcClient from "./smcClient.js";
import * as fmcClient from "./fmcClient.js";
import * as control from "./control.js";
import * as usage from "./usage.js";
import { log } from "./debug.js";

const SLUG = "all-runs";

// ── usage roster (Extension_Installs list on SharePoint) ────────────────────
usage.init({
  slug: SLUG,
  version: browser.runtime.getManifest().version,
  spRequest: (r) => spClient.spRequest(r),
  getAlias: () => smcClient.getRequester(),
  getInstallId: () => control.getInstallId(),
  log,
});
setTimeout(() => usage.report("startup"), 15_000);

// ── remote control (control.json on the updates branch) ─────────────────────
control.init({
  url: Config.CONTROL_URL,
  version: browser.runtime.getManifest().version,
  slug: SLUG,
  refreshMinutes: Config.CONTROL_REFRESH_MINUTES,
  getAlias: () => smcClient.getRequester(),
  log,
});
const CONTROL_ALARM = "runs-control";
browser.alarms.create(CONTROL_ALARM, { periodInMinutes: Config.CONTROL_REFRESH_MINUTES });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === CONTROL_ALARM) {
    control.refresh();
    usage.report("tick"); // throttled to once an hour inside
  }
});

// Actions that stay available while remotely disabled, so the page can explain
// itself. Everything else is refused with controlBlocked:true.
const CONTROL_EXEMPT = new Set([
  "getConfig", "checkSessions", "controlStatus", "setDebug", "loadCache",
  "sp:bridge-ready", "fmc:bridge-ready", "smc:bridge-ready",
]);

// ── toolbar button → open (or focus) the dashboard page ─────────────────────
const UI_URL = browser.runtime.getURL("ui/runs.html");
browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: UI_URL });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: UI_URL });
  }
});

function teamOf(msg) {
  const key = String((msg && msg.team) || Config.DEFAULT_TEAM).toUpperCase();
  if (!Config.TEAMS[key]) throw new Error(`Unknown team: ${msg && msg.team}`);
  return key;
}

/**
 * Probe each requested service with a cheap authenticated call, so the page can
 * block and prompt for re-auth BEFORE doing any work.
 */
async function checkSessions(services) {
  const expired = [];
  const reasons = {};
  await Promise.all(
    services.map(async (svc) => {
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
          expired: !!(e && e.expired),
          // Firefox refused to run on the tab: site access not granted.
          permission: !!(e && e.permission) || /Missing host permission|site access/i.test(reason),
        };
      }
    })
  );
  return { expired, reasons };
}

const HANDLERS = {
  // Everything the page needs from config (it can't import config.js).
  getConfig: (msg) => ({
    defaultTeam: Config.DEFAULT_TEAM,
    ...runsService.uiConfig(teamOf(msg), Config.HOST_ORIGINS),
  }),
  checkSessions: (msg) => checkSessions(msg.services || []),

  // ── CST shipper source of truth (tags runs; never scopes the query) ──
  getShippers: (msg) => shippers.getShippers(teamOf(msg), { force: !!msg.force }),

  // ── the load, step by step (the page loops these) ──
  runsWindow: (msg) => ({
    ...runsService.pickupWindow(teamOf(msg)),
    smcOptions: runsService.smcOptions(teamOf(msg)),
  }),
  smcRows: (msg) => smcClient.fetchSourcingRows(msg.win || {}, msg.opts || {}),
  fmcStatuses: (msg) => fmcClient.getFmcStatuses(msg.vrids || []),
  smcRequester: async () => ({ requester: await smcClient.getRequester() }),

  // ── last result cache ──
  loadCache: (msg) => runsService.loadCache(teamOf(msg)),
  saveCache: (msg) => {
    usage.report("load", { ran: true });
    return runsService.saveCache(teamOf(msg), msg.payload || null);
  },

  // ── remote control: identity + verdict; msg.refresh forces a re-read ──
  controlStatus: async (msg) => {
    if (msg.refresh) await control.refresh();
    return { ...(await control.status()), usage: await usage.local() };
  },

  setDebug: (msg) => {
    if (msg.enabled) log.enable();
    else log.disable();
    return { enabled: log.enabled };
  },

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
      log.error(`action:${action}`, err);
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        status: err && err.status,
        body: err && err.body,
        expired: !!(err && err.expired),
        permission: !!(err && err.permission),
        controlBlocked: !!(err && err.controlBlocked),
      };
    });
});

log.info("worker", `ready (debug=${log.enabled ? "on" : "off"})`);
