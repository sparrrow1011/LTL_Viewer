/**
 * TMS client (background side).
 *
 * The standalone UI page (ui/app.html) can't read the TMS DOM itself, so the
 * background finds an open TMS tab (or opens one), then sends `tms:*` messages
 * to the content script. TMS is a frameset, so a tab can have several frames;
 * the extractor is injected into all of them. We broadcast to the whole tab and
 * pick the frame whose reply has the results table.
 *
 * Mirrors extension/background/smcClient.js from LTL_Viewer (find/open a tab,
 * message the bridge), adapted for a DOM-scrape source instead of a JSON API.
 */

import { Config } from "../config.js";
import { log } from "./debug.js";

const TAB_MATCH = Config.TMS_TAB_MATCH;
const LIST_HINT = Config.TMS_LIST_HINT;

// Find an already-open TMS tab. Prefer one whose URL is the Shipment Leg list.
async function findTmsTab() {
  const tabs = await browser.tabs.query({ url: TAB_MATCH });
  if (!tabs.length) return null;
  const onList = tabs.find((t) => (t.url || "").includes(LIST_HINT));
  return onList || tabs[0];
}

/**
 * Send a tms:* action to every frame of the TMS tab and collect the replies.
 * browser.tabs.sendMessage without a frameId is delivered to all frames; each
 * frame's listener resolves its own promise, but sendMessage returns only the
 * FIRST reply. So we enumerate frames via webNavigation-less approach: send to
 * each frameId we discover through scripting, falling back to a tab-level send.
 */
async function sendToAllFrames(tabId, message) {
  // Try to enumerate frames with the scripting/tabs frame API when available.
  let frameIds = [0];
  try {
    if (browser.webNavigation && browser.webNavigation.getAllFrames) {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      if (frames && frames.length) frameIds = frames.map((f) => f.frameId);
    }
  } catch (e) {
    log.debug("tms", "getAllFrames unavailable, using frame 0 only", e.message);
  }

  const replies = [];
  for (const frameId of frameIds) {
    try {
      const r = await browser.tabs.sendMessage(tabId, message, { frameId });
      if (r) replies.push(r);
    } catch (e) {
      // A frame with no content script (e.g. about:blank) just has no receiver.
      log.debug("tms", `frame ${frameId} no reply: ${e.message}`);
    }
  }
  return replies;
}

// Ensure we have a usable TMS tab, opening one if none exists.
async function ensureTab() {
  let tab = await findTmsTab();
  if (tab) return tab;
  log.info("tms", "no TMS tab open — opening one");
  tab = await browser.tabs.create({ url: Config.TMS_ORIGIN, active: true });
  // Give the frameset a moment to load its content script.
  await new Promise((res) => setTimeout(res, 2500));
  return tab;
}

/**
 * Toolbar-button entry point: bring the TMS tab to the front and tell the
 * frame that holds the Shipment Leg list to open the overlay. Frames without
 * the table ignore the message, so `mounted` is false when the user is not on
 * the list page yet (the overlay's own toggle button appears once they are).
 */
export async function toggleOverlay() {
  const tab = await ensureTab();
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  const replies = await sendToAllFrames(tab.id, { action: "tms:toggle" });
  const hit = replies.find((r) => r && r.ok && r.mounted);
  return { tabId: tab.id, mounted: !!hit, href: hit ? hit.href : null };
}

/** Cheap health check: is a TMS tab open and does any frame carry the table? */
export async function ping() {
  const tab = await findTmsTab();
  if (!tab) {
    const e = new Error("No TMS tab is open. Open the Shipment Leg list in TMS first.");
    e.expired = false;
    throw e;
  }
  const replies = await sendToAllFrames(tab.id, { action: "tms:ping" });
  const hasTable = replies.some((r) => r && r.ok && r.hasTable);
  return { tabId: tab.id, hasTable, frames: replies.length };
}

/**
 * Extract the current Shipment Leg list rows. Picks the frame that actually
 * holds the table. Returns { rows, count, href, tabId }.
 */
export async function extract() {
  const tab = await ensureTab();
  const replies = await sendToAllFrames(tab.id, { action: "tms:extract" });
  const withTable = replies.find((r) => r && r.ok && r.hasTable);
  if (!withTable) {
    // No frame had the table — either not on the list page or session lapsed.
    const anyOk = replies.some((r) => r && r.ok);
    const e = new Error(
      anyOk
        ? "TMS is open but no Shipment Leg list table was found. Navigate to the Shipment Leg list (List of Shipment Legs) and try again."
        : "Could not reach the TMS page. Make sure you are logged in to TMS and on the Shipment Leg list."
    );
    e.expired = !anyOk;
    throw e;
  }
  log.info("tms", `extracted ${withTable.count} row(s) from ${withTable.href}`);
  return { rows: withTable.rows, count: withTable.count, href: withTable.href, tabId: tab.id };
}
