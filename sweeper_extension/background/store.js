/**
 * browser.storage.local wrapper: user settings + last results + alert log.
 *
 * Replaces the network-share CSV/xlsx paragon.py wrote: the UI reads the last
 * sweep/lobby results from here instead of a file.
 */
import { Config } from "../config.js";

const KEY_SETTINGS = "settings";
const KEY_STATE = "state";

export const DEFAULT_SETTINGS = {
  team: Config.DEFAULT_TEAM,
  // SMC order window on the origin date: [today - daysBack, today + daysForward].
  daysBack: Config.SWEEP_WINDOW.daysBack,
  daysForward: Config.SWEEP_WINDOW.daysForward,
  // Optional SharePoint path/URL of the shipper CSV (tried first).
  shipperPath: "",
  // Subject substrings (one per line) that drop a case from the sweep.
  excludeSubjects: (Config.TEAMS[Config.DEFAULT_TEAM].excludeSubjects || []).join("\n"),
  // Queue lists (one per line). Seeded from Config.TEAMS[team]; editable in
  // Settings. Empty = fall back to the team's config list.
  validQueues: (Config.TEAMS[Config.DEFAULT_TEAM].validQueues || []).join("\n"),
  lobbyQueues: (Config.TEAMS[Config.DEFAULT_TEAM].lobbyQueues || []).join("\n"),
  scheduleEnabled: false,
  scheduleMinutes: Config.SCHEDULE_MINUTES,
  // Which jobs the scheduled cycle runs.
  runSweep: true,
  runLobby: true,
  // Notifications.
  desktopNotifications: true,
  // Slack incoming-webhook URL. Empty = use Config.SLACK_WEBHOOK_DEFAULT (see
  // getSettings). Posting itself is controlled by slackAlerts/slackWrongQueue.
  slackWebhook: "",
  slackAlerts: true,
  slackWrongQueue: true,
  alertDedupeMinutes: Config.ALERT_DEDUPE_MINUTES,
  // Verbose bridge/HTTP logging in the Log tab (pipeline steps always show).
  debug: Config.DEBUG,
};

const DEFAULT_STATE = {
  running: null, // "sweep" | "lobby" | "cycle" | null
  lastSweep: null, // { at, team, pairCount, orders, rows, flaggedCount, failedBatches, batches, window, error }
  lastLobby: null, // { at, team, query, rows, alerts, error }
  alertLog: {}, // { "type|caseId": lastNotifiedMs }
  lastError: null,
  // Scheduler diagnostics: { armedAt, armedWhy, lastFiredAt, lastFiredKind, lastOutcome, lastOutcomeAt, lastRunStartedAt }
  scheduler: {},
};

export async function getSettings() {
  const got = await browser.storage.local.get(KEY_SETTINGS);
  const s = { ...DEFAULT_SETTINGS, ...(got[KEY_SETTINGS] || {}) };
  // An empty webhook field means "use the team default" (so existing installs
  // that saved "" before the default existed pick it up too).
  if (!String(s.slackWebhook || "").trim()) s.slackWebhook = Config.SLACK_WEBHOOK_DEFAULT || "";
  return s;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...(patch || {}) };
  if (!Config.TEAMS[next.team]) next.team = Config.DEFAULT_TEAM;
  next.scheduleMinutes = Math.max(5, Number(next.scheduleMinutes) || Config.SCHEDULE_MINUTES);
  const clampDays = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : dflt;
  };
  next.daysBack = clampDays(next.daysBack, Config.SWEEP_WINDOW.daysBack);
  next.daysForward = clampDays(next.daysForward, Config.SWEEP_WINDOW.daysForward);
  next.shipperPath = String(next.shipperPath || "").trim();
  next.excludeSubjects = String(next.excludeSubjects ?? "");
  next.validQueues = String(next.validQueues ?? "");
  next.lobbyQueues = String(next.lobbyQueues ?? "");
  await browser.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

export async function getState() {
  const got = await browser.storage.local.get(KEY_STATE);
  return { ...DEFAULT_STATE, ...(got[KEY_STATE] || {}) };
}

export async function patchState(patch) {
  const cur = await getState();
  const next = { ...cur, ...(patch || {}) };
  await browser.storage.local.set({ [KEY_STATE]: next });
  return next;
}

/** Drop alert-log entries older than the dedupe window (keeps storage small). */
export function pruneAlertLog(alertLog, dedupeMinutes, nowMs = Date.now()) {
  const cutoff = nowMs - dedupeMinutes * 60_000;
  const out = {};
  for (const [k, t] of Object.entries(alertLog || {})) if (t >= cutoff) out[k] = t;
  return out;
}
