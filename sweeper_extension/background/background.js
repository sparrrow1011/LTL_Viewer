/**
 * Background — message router + scheduler + toolbar action.
 *
 * The UI page (ui/sweeper.html) sends { action, ... } messages; every handler
 * returns { ok:true, data } or { ok:false, error, expired } so the UI has one
 * shape to unwrap. The 30-minute loop paragon_scheduler.py ran in a thread is
 * a browser.alarms alarm here.
 */
import { Config } from "../config.js";
import * as store from "./store.js";
import * as sweeper from "./sweeper.js";
import * as shippers from "./shippers.js";
import * as smc from "./smcClient.js";
import * as control from "./control.js";
import * as usage from "./usage.js";
import { log } from "./debug.js";

const ALARM = "lobby-sweeper-cycle";
const CONTROL_ALARM = "lobby-sweeper-control";
const UI_URL = browser.runtime.getURL("ui/sweeper.html");

// ── remote control (control.json on the updates branch) ────────────────────
control.init({
  url: Config.CONTROL_URL,
  version: browser.runtime.getManifest().version,
  slug: "lobby-sweeper",
  refreshMinutes: Config.CONTROL_REFRESH_MINUTES,
  getAlias: () => smc.getRequester(),
  log,
});
browser.alarms.create(CONTROL_ALARM, { periodInMinutes: Config.CONTROL_REFRESH_MINUTES });

// ── usage roster (Extension_Installs list on SharePoint) ────────────────────
usage.init({
  slug: "lobby-sweeper",
  version: browser.runtime.getManifest().version,
  spRequest: (r) => shippers.spRequest(r),
  getAlias: () => smc.getRequester(),
  getInstallId: () => control.getInstallId(),
  log,
});
// First report shortly after start (gives the SharePoint tab a moment), then
// piggy-backs on the control alarm (throttled inside report()).
setTimeout(() => usage.report("startup"), 15_000);

// ── scheduler ──────────────────────────────────────────────────────────────

async function syncAlarm() {
  const s = await store.getSettings();
  const existing = await browser.alarms.get(ALARM);
  if (!s.scheduleEnabled) {
    if (existing) await browser.alarms.clear(ALARM);
    return { enabled: false };
  }
  if (!existing || Math.round(existing.periodInMinutes) !== s.scheduleMinutes) {
    const why = !existing ? "no alarm existed (fresh start / update / browser restart)" : `period changed ${existing.periodInMinutes} → ${s.scheduleMinutes}`;
    await browser.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: s.scheduleMinutes });
    log.info("pipeline", `⏰ scheduler armed: every ${s.scheduleMinutes} min, first run in ~6s — ${why}`);
    await noteScheduler({ armedAt: Date.now(), armedWhy: why });
  }
  const a = await browser.alarms.get(ALARM);
  const st = await store.getState();
  return { enabled: true, nextAt: a ? a.scheduledTime : null, periodMinutes: s.scheduleMinutes, ...(st.scheduler || {}) };
}

const RETRY_ALARM = "lobby-sweeper-retry";

async function noteScheduler(patch) {
  const st = await store.getState();
  await store.patchState({ scheduler: { ...(st.scheduler || {}), ...patch } });
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CONTROL_ALARM) {
    // Periodic re-read so a remote disable lands within CONTROL_REFRESH_MINUTES
    // even when nothing else is happening; badge reflects it.
    const v = await control.refresh();
    if (!v.allowed) await sweeper.updateBadge().catch(() => {});
    usage.report("tick"); // throttled to once an hour inside
    return;
  }
  if (alarm.name !== ALARM && alarm.name !== RETRY_ALARM) return;
  const firedAt = Date.now();
  log.info("pipeline", `⏰ scheduler alarm fired (${alarm.name === RETRY_ALARM ? "retry" : "periodic"})`);
  await noteScheduler({ lastFiredAt: firedAt, lastFiredKind: alarm.name === RETRY_ALARM ? "retry" : "periodic" });

  const settings = await store.getSettings();
  if (!settings.scheduleEnabled) {
    log.warn("scheduler", "alarm fired but scheduler is disabled — clearing");
    await browser.alarms.clear(ALARM);
    return;
  }
  const verdict = await control.check({ force: true });
  if (!verdict.allowed) {
    log.warn("pipeline", `⏰ scheduled cycle refused by remote control (${verdict.reason}): ${verdict.message}`);
    await noteScheduler({ lastOutcome: `blocked: ${verdict.message}`, lastOutcomeAt: firedAt });
    await store.patchState({ lastError: { at: firedAt, job: "cycle", message: verdict.message, controlBlocked: true } });
    return;
  }
  if (sweeper.isRunning()) {
    // Don't lose the cycle: try again in a minute instead of waiting a whole period.
    log.warn("pipeline", `scheduled cycle deferred — a ${sweeper.isRunning()} run is in progress; retrying in 1 min`);
    await noteScheduler({ lastOutcome: "deferred", lastOutcomeAt: firedAt });
    await browser.alarms.create(RETRY_ALARM, { delayInMinutes: 1 });
    return;
  }
  try {
    const out = await sweeper.runCycle("alarm");
    const outcome = out.errors.length ? `errors: ${out.errors.join(" · ")}` : "ok";
    log.info("pipeline", `⏰ scheduled cycle done — ${outcome}`);
    usage.report("scheduled run", { ran: true });
    await noteScheduler({ lastOutcome: outcome, lastOutcomeAt: Date.now(), lastRunStartedAt: firedAt });
  } catch (e) {
    log.error("scheduler", e);
    await noteScheduler({ lastOutcome: `failed: ${e.message}`, lastOutcomeAt: Date.now(), lastRunStartedAt: firedAt });
  } finally {
    // Firefox drops alarms on extension update/restart; make sure the periodic
    // one still exists even when no page is open to call getState().
    await syncAlarm().catch((e) => log.error("scheduler", e));
  }
});

// ── toolbar button → open (or focus) the sweeper page ──────────────────────

browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: UI_URL });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: UI_URL });
  }
});

// ── message handlers ───────────────────────────────────────────────────────

/**
 * Kick off a job without awaiting it. Rejections are recorded in
 * state.lastError (the job itself already stores its result on success).
 * Throws synchronously-ish if a job is already running so the page gets an
 * immediate "busy" answer.
 */
async function startJob(job, fn) {
  if (sweeper.isRunning()) throw new Error(`Already running: ${sweeper.isRunning()}`);
  await control.assertAllowed(job); // throws with .controlBlocked when remotely disabled
  const p = fn();
  p.then(() => usage.report("run", { ran: true }), () => {});
  p.catch(async (e) => {
    log.error(`job:${job}`, e);
    await store.patchState({
      lastError: {
        at: Date.now(),
        job,
        message: String(e && e.message ? e.message : e),
        expired: !!(e && e.expired),
        cancelled: !!(e && e.cancelled),
      },
    });
  });
  // Yield once so a synchronous "Already running" from withLock surfaces here.
  await new Promise((r) => setTimeout(r, 50));
  return { started: true, job };
}

const HANDLERS = {
  getConfig: () => ({
    defaultTeam: Config.DEFAULT_TEAM,
    teams: Config.TEAMS,
    lobbyStatuses: Config.LOBBY_STATUSES,
    sla: Config.SLA,
    sweepWindow: Config.SWEEP_WINDOW,
    paragonOrigin: Config.PARAGON_ORIGIN,
    caseUrlTemplate: Config.caseUrl("__ID__"),
    hostOrigins: Config.HOST_ORIGINS,
  }),

  getSettings: () => store.getSettings(),
  saveSettings: async (msg) => {
    const s = await store.saveSettings(msg.settings || {});
    if (s.debug) log.enable();
    else log.disable();
    const schedule = await syncAlarm();
    return { settings: s, schedule };
  },

  getState: async () => ({ ...(await store.getState()), schedule: await syncAlarm() }),

  checkSessions: (msg) => sweeper.checkSessions(msg.services || ["SharePoint", "SMC", "FMC", "Paragon"]),

  // Open (or re-point) a tab per expired service so the user can complete the
  // Midway sign-in. Navigating an existing tab to the site URL triggers the SSO
  // redirect just like a fresh tab; the first one is focused.
  openSites: async (msg) => {
    const SITES = {
      SharePoint: { url: Config.SP_TAB_URL, match: Config.SP_TAB_MATCH },
      SMC: { url: Config.SMC_TAB_URL, match: Config.SMC_TAB_MATCH },
      FMC: { url: Config.FMC_TAB_URL, match: Config.FMC_TAB_MATCH },
      Paragon: { url: Config.PARAGON_TAB_URL, match: Config.PARAGON_TAB_MATCH },
    };
    const opened = [];
    let first = true;
    for (const svc of msg.services || []) {
      const site = SITES[svc];
      if (!site) continue;
      const existing = (await browser.tabs.query({ url: site.match })).find((t) => !t.discarded);
      let tab;
      if (existing) tab = await browser.tabs.update(existing.id, { url: site.url, active: first });
      else tab = await browser.tabs.create({ url: site.url, active: first });
      if (first) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
      opened.push({ service: svc, tabId: tab.id, reused: !!existing });
      first = false;
    }
    log.info("sessions", `opened ${opened.length} site tab(s) for sign-in: ${opened.map((o) => o.service).join(", ")}`);
    return { opened };
  },

  // CST shipper IDs: status (source/count), force re-read, manual CSV import.
  getShippers: async (msg) => {
    const s = await shippers.getShipperIds({ force: !!msg.force });
    return { count: s.count, source: s.source, path: s.path, fetchedAt: s.fetchedAt, stale: !!s.stale, error: s.error || null, sample: s.ids.slice(0, 5) };
  },
  importShippers: (msg) => shippers.importCsv(msg.text || "", msg.name || "import.csv"),
  clearShipperImport: async () => {
    await shippers.clearImport();
    return { cleared: true };
  },

  // Run actions return as soon as the job has STARTED. The page follows
  // state.progress / state.running via storage.onChanged and reads the result
  // from state.lastSweep / lastLobby / lastError. (Awaiting a minutes-long
  // message would outlive the event page's idle limit.)
  runSweep: (msg) => startJob("sweep", async () => sweeper.runSweepLocked(msg.team || (await store.getSettings()).team)),
  runLobby: (msg) => startJob("lobby", async () => sweeper.runLobbyLocked(msg.team || (await store.getSettings()).team)),
  runCycle: () => startJob("cycle", () => sweeper.runCycle("manual")),
  // Stop the current run at the next batch boundary (manual or scheduled).
  cancelRun: () => sweeper.requestCancel(),

  // Remote control: identity + verdict for the Settings/banner; force re-read.
  controlStatus: async (msg) => {
    if (msg.refresh) await control.refresh();
    return { ...(await control.status()), usage: await usage.local() };
  },
  // Usage roster: force a report now (Settings button).
  usageReport: () => usage.report("manual", { force: true }),
  // Usage roster: all installs (both extensions) from the SharePoint list.
  // Admin-only (alias listed in control.json "admins").
  usageRoster: async () => {
    const st = await control.status();
    if (!st.admin) throw new Error(`The installs roster is admin-only (alias ${st.alias || "unknown"} is not in control.json "admins").`);
    return {
      rows: await usage.roster(),
      listUrl: `${Config.SP_ORIGIN}/sites/AmazonFreightOperations/Lists/Extension_Installs`,
    };
  },

  clearAlertLog: async () => {
    await store.patchState({ alertLog: {} });
    return { cleared: true };
  },

  // Debug log (ring buffer mirrored to storage) for the page's Log tab.
  getLog: () => ({ lines: log.getLines(), instance: log.startedAt, debug: log.enabled }),
  clearLog: async () => {
    await log.clear();
    return { cleared: true };
  },

  testSlack: async (msg) => {
    const s = await store.getSettings();
    const hook = msg.webhook || s.slackWebhook;
    if (!hook) throw new Error("No Slack webhook configured");
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: ":broom: Lobby Sweeper test message — webhook works." }),
    });
    if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
    return { sent: true };
  },

  openCase: async (msg) => {
    await browser.tabs.create({ url: Config.caseUrl(msg.id), active: true });
    return { opened: true };
  },

  setDebug: async (msg) => {
    if (msg.enabled) log.enable();
    else log.disable();
    await store.saveSettings({ debug: !!msg.enabled });
    return { enabled: log.enabled };
  },

  "paragon:bridge-ready": (msg) => {
    log.debug("paragon", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
  "smc:bridge-ready": (msg) => {
    log.debug("smc", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
  "fmc:bridge-ready": (msg) => {
    log.debug("fmc", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
  "sp:bridge-ready": (msg) => {
    log.debug("sharepoint", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
};

browser.runtime.onMessage.addListener((msg, sender) => {
  const action = msg && msg.action;
  // Bridge replies travel tab → background only via our own sendMessage; ignore
  // anything that isn't addressed to a known handler.
  const handler = HANDLERS[action];
  if (!handler) return; // let other listeners (none) handle it
  if (action !== "getLog" && action !== "getState") log.debug("router", `→ ${action}`);
  return Promise.resolve()
    .then(() => handler(msg, sender))
    .then((data) => ({ ok: true, data }))
    .catch((err) => {
      log.error(`action:${action}`, err);
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        status: err && err.status,
        expired: !!(err && err.expired),
        controlBlocked: !!(err && err.controlBlocked),
      };
    });
});

// Re-arm the alarm on startup/install (alarms persist, but keep them in sync
// with settings) and refresh the badge from the last stored results.
browser.runtime.onInstalled.addListener(() => syncAlarm().catch((e) => log.error("scheduler", e)));
browser.runtime.onStartup.addListener(() => syncAlarm().catch((e) => log.error("scheduler", e)));
syncAlarm().catch((e) => log.error("scheduler", e));
sweeper.recoverInterruptedRun().catch((e) => log.error("recover", e));
sweeper.updateBadge().catch(() => {});
store.getSettings().then((s) => {
  if (s.debug) log.enable();
});

log.info("worker", `ready (debug=${log.enabled ? "on" : "off"})`);
