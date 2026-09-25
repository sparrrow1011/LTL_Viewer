/**
 * FMC client (background side) — read-only execution-status enrichment.
 *
 * FMC is a different origin from the overlay, so we route the request through
 * content/fmc-bridge.js running on an FMC tab (same pattern as spClient.js →
 * sp-bridge.js). Finds an open FMC tab, or opens one in the background, then
 * forwards the VRIDs and returns a { vrid: executionStatus } map.
 */

import { Config } from "../config.js";
import { log } from "./debug.js";

let _openingPromise = null;

async function findFmcTab() {
  const tabs = await browser.tabs.query({ url: Config.FMC_TAB_MATCH });
  return tabs.find((t) => t.status === "complete") || tabs[0] || null;
}

async function ensureFmcTab() {
  let tab = await findFmcTab();
  if (tab) return tab;

  if (!_openingPromise) {
    log.info("fmc", `no FMC tab open — opening ${Config.FMC_TAB_URL}`);
    _openingPromise = (async () => {
      const created = await browser.tabs.create({ url: Config.FMC_TAB_URL, active: false });
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === created.id && info.status === "complete") {
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        browser.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 20_000);
      });
      await new Promise((r) => setTimeout(r, 800)); // let the bridge register
      return created;
    })();
  }
  try {
    await _openingPromise;
  } finally {
    _openingPromise = null;
  }
  return findFmcTab();
}

/**
 * Send a message to the tab's bridge. If the content script isn't there yet
 * ("Receiving end does not exist"), inject it programmatically and retry once.
 * This makes enrichment work even for FMC tabs that predate the extension
 * reload or whose SPA URL didn't match the manifest content-script pattern.
 */
async function sendWithInject(tabId, message) {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      throw new Error(`FMC bridge not reachable (tab ${tabId}): ${msg}`);
    }
    log.info("fmc", `bridge missing in tab ${tabId} — injecting fmc-bridge.js`);
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["content/fmc-bridge.js"],
      });
    } catch (injErr) {
      throw new Error(
        `Couldn't inject FMC bridge into tab ${tabId}: ${
          injErr && injErr.message ? injErr.message : injErr
        }`
      );
    }
    // Give the freshly-injected listener a moment to register.
    await new Promise((r) => setTimeout(r, 300));
    return browser.tabs.sendMessage(tabId, message);
  }
}

async function bridge(message) {
  const tab = await ensureFmcTab();
  if (!tab) throw new Error("No FMC tab available. Open the FMC site in a tab and retry.");
  const resp = await sendWithInject(tab.id, message);
  if (!resp || !resp.bridge) throw new Error("FMC bridge returned no response");
  if (!resp.ok) {
    // Carry the bridge's status + expired flag on the error so callers
    // (checkSessions) can tell a real sign-in problem from any other failure.
    const err = new Error(resp.error || `FMC bridge failed (HTTP ${resp.status})`);
    err.status = resp.status;
    err.expired = !!resp.expired;
    throw err;
  }
  return resp;
}

/**
 * Fetch live FMC records (status, carrier, tour, yard times, stop refs) for the
 * given VRIDs.
 * @param {string[]} vrids
 * @returns {Promise<{ records: Record<string, object> }>}  keyed by vrid
 */
export async function getFmcStatuses(vrids = []) {
  const clean = [...new Set(vrids.map((v) => String(v).trim()).filter(Boolean))];
  if (!clean.length) return { records: {} };
  const resp = await bridge({ action: "fmc:req", vrids: clean });
  const n = Object.keys(resp.records || {}).length;
  log.info("fmc", `got ${n} records for ${clean.length} vrids`);
  return { records: resp.records || {} };
}

/**
 * Search FMC by CRITERIA (shipper accounts × carriers × planned-dock window)
 * rather than by id. This is how FMC becomes the SOURCE of the load list —
 * it finds runs the extension has never seen (middle mile has no SMC order).
 * @param {{shipperAccounts:string[], carriers:string[], tenderStatuses?:string[], start:string, end:string}} criteria
 * @returns {Promise<{ records: Record<string, object> }>} keyed by vrid
 */
export async function searchFmc(criteria = {}) {
  const resp = await bridge({ action: "fmc:search", criteria });
  const n = Object.keys(resp.records || {}).length;
  log.info("fmc", `criteria search → ${n} records`, criteria);
  return { records: resp.records || {} };
}

/**
 * Resolve orig/dest addresses (lazy, at EML time) for the given stop refs.
 * @param {Array<{vrid:string, orig:object, dest:object}>} items
 * @returns {Promise<{ addresses: Record<string,{orig_address,dest_address}> }>}
 */
export async function getFmcAddresses(items = []) {
  if (!items.length) return { addresses: {} };
  const resp = await bridge({ action: "fmc:addresses", items });
  return { addresses: resp.addresses || {} };
}

/**
 * Lightweight authenticated probe. Throws if the FMC session is gone (so the
 * session pre-flight can block the action).
 */
export async function ping() {
  const resp = await bridge({ action: "fmc:ping" });
  // bridge() already throws when resp.ok is false; a 200 means authenticated.
  return true;
}
