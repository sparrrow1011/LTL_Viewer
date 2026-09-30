/**
 * Background service worker — the message router (P&G TMS Viewer).
 *
 * The viewer is an OVERLAY drawn by content/overlay.js inside the TMS frame
 * that holds the Shipment Leg list, so the background is thin: the toolbar
 * button focuses (or opens) the TMS tab and asks that frame to open the panel.
 * The tms:* message handlers stay for console diagnostics and for the next
 * milestone (SMC auto-fill), which will need a background round-trip.
 * Mirrors extension/background/background.js from LTL_Viewer: one consistent
 * { ok:true, data } / { ok:false, error } envelope.
 */

import { Config } from "../config.js";
import * as tmsClient from "./tmsClient.js";
import * as smcClient from "./smcClient.js";
import * as recorder from "./recorder.js";
import * as draft from "./draft.js";
import * as lanesStore from "./lanesStore.js";
import * as control from "./control.js";
import { log } from "./debug.js";

// ── remote control (control.json on the updates branch) ────────────────────
// Global / per-alias / per-install kill switch + minVersion. Identity = SMC
// requester alias + a random install id. Shared background/control.js.
control.init({
  url: Config.CONTROL_URL,
  version: browser.runtime.getManifest().version,
  slug: "pg-tms-viewer",
  refreshMinutes: Config.CONTROL_REFRESH_MINUTES,
  getAlias: () => smcClient.getRequester(),
  log,
});
const CONTROL_ALARM = "pg-tms-viewer-control";
browser.alarms.create(CONTROL_ALARM, { periodInMinutes: Config.CONTROL_REFRESH_MINUTES });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === CONTROL_ALARM) control.refresh();
});

// Actions that stay available while remotely disabled, so the overlay can
// still open and explain itself. Everything else is refused with controlBlocked.
const CONTROL_EXEMPT = new Set([
  "getConfig", "getSettings", "saveSettings", "siteAccess", "setDebug",
  "controlStatus", "tmsToggle", "tmsPing", "tmsExtract",
  "tms:bridge-ready", "smc:bridge-ready",
]);

// ── settings (browser.storage.local) ──────────────────────────────────────────
async function getSettings() {
  const stored = await browser.storage.local.get(Config.SETTINGS_KEY);
  return { ...Config.DEFAULT_SETTINGS, ...(stored[Config.SETTINGS_KEY] || {}) };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...(patch || {}) };
  next.shipperIds = (Array.isArray(next.shipperIds) ? next.shipperIds : String(next.shipperIds || "").split(/[\s,;]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  next.windowPadDays = Math.max(0, Math.min(30, Number(next.windowPadDays) || 0));
  await browser.storage.local.set({ [Config.SETTINGS_KEY]: next });
  return next;
}

// ── site access ───────────────────────────────────────────────────────────────
// Firefox MV3 starts installed add-ons (and temporary ones reloaded after the
// manifest gained an origin) WITHOUT host access. permissions.request() only
// works from a user gesture, and the toolbar click is one — so ask there.
async function ensureSiteAccess() {
  const origins = Config.HOST_ORIGINS;
  if (await browser.permissions.contains({ origins })) return true;
  log.info("perm", `requesting site access: ${origins.join(", ")}`);
  const granted = await browser.permissions.request({ origins });
  log.info("perm", granted ? "site access granted" : "site access DENIED by the user");
  return granted;
}

// ── toolbar button → grant access if needed, focus TMS, open the overlay ──────
browser.action.onClicked.addListener(async () => {
  try {
    await ensureSiteAccess();
    const r = await tmsClient.toggleOverlay();
    if (!r.mounted) {
      log.warn("tms", "TMS tab focused but no frame has the Shipment Leg list yet");
    }
  } catch (e) {
    log.error("action", e);
  }
});

const HANDLERS = {
  // Config snapshot for the overlay (content scripts can't import config.js).
  getConfig: () => ({
    siteNames: Config.SITE_NAMES,
    siteCodes: Config.SITE_CODES,
    sites: Config.SITES,
    tmsOrigin: Config.TMS_ORIGIN,
    smcTabUrl: Config.SMC_TAB_URL,
    smcCreateUrl: Config.SMC_CREATE_URL("__SHIPPER__"),
    smcOrderUrl: Config.SMC_ORDER_URL("__ID__"),
    smcOrderDefaults: Config.SMC_ORDER_DEFAULTS,
    idcNodes: Config.IDC_NODES,
  }),

  getSettings: () => getSettings(),
  saveSettings: (msg) => saveSettings(msg.settings),

  // "Does each TMS load already have an SMC order?" → { matches, unmatched, ... }
  smcCheck: async (msg) => smcClient.checkLoads(msg.loads || [], await getSettings()),

  // SMC session probe (throws with .expired when signed out).
  smcPing: () => smcClient.ping(),

  // Stop name / node code → SMC locations with address IDs (for order prep).
  smcLocations: (msg) => smcClient.lookupLocations(msg.names || []),

  // Draft creation: prepare = resolve + build payload (no write); create = POST it.
  smcPrepareDraft: async (msg) => {
    const s = await getSettings();
    const input = { ...(msg.input || {}), shipperId: (msg.input && msg.input.shipperId) || s.shipperIds[0] };
    return draft.prepare(input);
  },
  smcCreateDraft: async (msg) => {
    const r = await draft.create(msg.payload);
    // Remember the price used for this site so the next draft defaults to it.
    if (msg.siteKey && msg.price) {
      const s = await getSettings();
      await saveSettings({ prices: { ...(s.prices || {}), [msg.siteKey]: Number(msg.price) } });
    }
    return r;
  },

  // Custom contracted lanes (Settings → merged on top of the built-in lanes).
  lanesList: () => lanesStore.listCustom(),
  lanesSave: (msg) => lanesStore.saveCustom(msg.lane || {}),
  lanesDelete: (msg) => lanesStore.deleteCustom(msg.key),

  // SMC request recorder (diagnostics to learn the create-order call).
  recStart: () => recorder.start(),
  recStop: () => recorder.stop(),
  recStatus: () => recorder.status(),
  recGet: () => recorder.get(),
  recClear: () => recorder.clear(),

  // Which of our origins the add-on may currently touch (for the UI hint).
  siteAccess: async () => {
    const missing = [];
    for (const o of Config.HOST_ORIGINS) {
      if (!(await browser.permissions.contains({ origins: [o] }))) missing.push(o);
    }
    return { missing, ok: missing.length === 0 };
  },

  // Is a TMS tab open and does a frame have the list table?
  tmsPing: () => tmsClient.ping(),

  // Extract the current Shipment Leg list → { rows, count, href }.
  tmsExtract: () => tmsClient.extract(),

  // Open the overlay in the list frame (same as the toolbar button).
  tmsToggle: () => tmsClient.toggleOverlay(),

  // Remote control: identity + verdict; msg.refresh forces a re-read.
  controlStatus: async (msg) => {
    if (msg && msg.refresh) await control.refresh();
    return control.status();
  },

  // Debug toggle from the UI.
  setDebug: (msg) => {
    if (msg.enabled) log.enable();
    else log.disable();
    return { enabled: log.enabled };
  },

  // Bridges announcing themselves (informational).
  "tms:bridge-ready": (msg) => {
    log.info("tms", `bridge ready: ${msg.href} (hasTable=${msg.hasTable})`);
    return { ack: true };
  },
  "smc:bridge-ready": (msg) => {
    log.info("smc", `bridge ready: ${msg.href}`);
    return { ack: true };
  },
};

const BRIDGE_PREFIX = /^(tms|smc):/;

browser.runtime.onMessage.addListener((msg) => {
  const action = msg && msg.action;
  // tms:* / smc:* requests are addressed to the content-script bridges, not the
  // router; only their ready announcements are ours.
  if (typeof action === "string" && BRIDGE_PREFIX.test(action) && !action.endsWith(":bridge-ready")) {
    return;
  }
  const handler = HANDLERS[action];
  if (!handler) {
    log.warn("router", `unknown action: ${action}`);
    return Promise.resolve({ ok: false, error: `Unknown action: ${action}` });
  }
  log.info("router", `→ ${action}`);
  return log
    .time(`action:${action}`, () =>
      Promise.resolve()
        // Remote kill switch: refuse everything except the exempt actions when
        // this install/alias is disabled (or below minVersion).
        .then(() => (CONTROL_EXEMPT.has(action) ? null : control.assertAllowed(action)))
        .then(() => handler(msg))
    )
    .then((data) => ({ ok: true, data }))
    .catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
      expired: !!(err && err.expired),
      permission: !!(err && err.permission),
      config: !!(err && err.config),
      pickNode: !!(err && err.pickNode),
      candidates: (err && err.candidates) || undefined,
      controlBlocked: !!(err && err.controlBlocked),
    }));
});

// Read control.json shortly after startup so the first overlay open has a
// fresh verdict (the alarm otherwise only fires every CONTROL_REFRESH_MINUTES).
setTimeout(() => control.refresh().catch(() => {}), 3_000);

log.info("worker", `ready (debug=${log.enabled ? "on" : "off"})`);
