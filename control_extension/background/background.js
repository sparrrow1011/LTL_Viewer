/**
 * Extension Control — background event page (message router).
 *
 * The page (ui/control.html) talks only to us. We reach GitHub directly (the
 * repo is public to read; a stored token authorises writes) and SharePoint via
 * the content-script bridge on a SharePoint tab (for the install roster).
 *
 * This add-on is the editor, not the channel: the controlled add-ons keep
 * reading <slug>/control.json from the updates branch every 15 minutes.
 */

import { Config } from "../config.js";
import * as gh from "./github.js";
import * as controlFiles from "./controlFiles.js";
import * as roster from "./roster.js";
import * as spClient from "./spClient.js";
import { log } from "./debug.js";

// ── toolbar button → open (or focus) the console page ───────────────────────
const UI_URL = browser.runtime.getURL("ui/control.html");
browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: UI_URL });
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: UI_URL });
  }
});

/** Cheap authenticated probe so the page can prompt for sign-in before doing work. */
async function checkSessions(services) {
  const expired = [];
  const reasons = {};
  await Promise.all(
    services.map(async (svc) => {
      try {
        if (svc === "SharePoint") await spClient.ping();
        else if (svc === "GitHub") await gh.whoami();
      } catch (e) {
        const reason = String((e && e.message) || e);
        log.warn("preflight", `${svc} pre-flight failed:`, reason);
        expired.push(svc);
        reasons[svc] = {
          message: reason,
          status: e && e.status,
          expired: !!(e && e.expired),
          permission: !!(e && e.permission) || /Missing host permission|site access/i.test(reason),
        };
      }
    })
  );
  return { expired, reasons };
}

const HANDLERS = {
  getConfig: () => ({
    owner: Config.OWNER,
    repo: Config.REPO,
    branch: Config.BRANCH,
    exts: Config.EXTS,
    spOrigin: Config.SP_ORIGIN,
    controlPage: Config.CONTROL_PAGE,
    version: browser.runtime.getManifest().version,
  }),
  checkSessions: (msg) => checkSessions(msg.services || []),

  // ── GitHub token ──
  "gh:whoami": () => gh.whoami(),
  "gh:setToken": (msg) => gh.setToken(msg.token),
  "gh:hasToken": async () => ({ hasToken: !!(await gh.getToken()) }),

  // ── control.json documents ──
  "ctl:loadAll": () => controlFiles.loadAll(),
  "ctl:load": (msg) => controlFiles.load(msg.slug),
  "ctl:save": (msg) => controlFiles.save(msg.slug, msg.doc, msg.summary),

  // ── install roster (SharePoint) ──
  "roster:list": () => roster.roster(),
  "roster:remove": (msg) => roster.removeRow(Number(msg.id)),

  setDebug: (msg) => {
    if (msg.enabled) log.enable();
    else log.disable();
    return { enabled: log.enabled };
  },
  "sp:bridge-ready": (msg) => {
    log.info("sp", `bridge ready: ${msg.href}`);
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
  log.info("router", `→ ${action}`);
  return log
    .time(`action:${action}`, () => Promise.resolve().then(() => handler(msg)))
    .then((data) => ({ ok: true, data }))
    .catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
      status: err && err.status,
      body: err && err.body,
      expired: !!(err && err.expired),
      permission: !!(err && err.permission),
    }));
});

log.info("worker", `ready (debug=${log.enabled ? "on" : "off"})`);
