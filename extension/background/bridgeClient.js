/**
 * Generic "talk to a content-script bridge in a tab on origin X" helper.
 *
 * Finds an open tab matching `tabMatch`, or opens `tabUrl` in the background,
 * then sends the message. If the bridge isn't registered in that tab yet
 * ("Receiving end does not exist" — tab predates the extension load, or the
 * SPA URL didn't match the manifest pattern), inject `script` and retry once;
 * if that still fails, reload the tab and retry.
 *
 * Ported from the Lobby Sweeper extension (which lifted it from fmcClient.js).
 * Used for SMC now that the UI is a standalone page and can't fetch SMC itself.
 */
import { log } from "./debug.js";

export function makeBridge({ name, tabMatch, tabUrl, script }) {
  let opening = null;

  async function findTab() {
    const tabs = await browser.tabs.query({ url: tabMatch });
    // A discarded (unloaded) tab has no content script to talk to; prefer a
    // live, fully-loaded one.
    const live = tabs.filter((t) => !t.discarded);
    return live.find((t) => t.status === "complete") || live[0] || tabs[0] || null;
  }

  function waitForComplete(tabId, timeoutMs = 20_000) {
    return new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          browser.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      browser.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, timeoutMs);
    });
  }

  async function reloadTab(tabId) {
    log.info(name, `reloading tab ${tabId} to get a live bridge`);
    await browser.tabs.reload(tabId);
    await waitForComplete(tabId);
    await new Promise((r) => setTimeout(r, 1_000)); // let the manifest content script register
  }

  async function ensureTab() {
    let tab = await findTab();
    if (tab) return tab;

    if (!opening) {
      log.info(name, `no tab open — opening ${tabUrl} in the background`);
      opening = (async () => {
        const created = await browser.tabs.create({ url: tabUrl, active: false });
        await waitForComplete(created.id);
        await new Promise((r) => setTimeout(r, 800)); // let the bridge register
        return created;
      })();
    }
    try {
      await opening;
    } finally {
      opening = null;
    }
    return findTab();
  }

  const NO_LISTENER = /Receiving end does not exist|Could not establish connection/i;

  async function sendWithInject(tab, message) {
    const tabId = tab.id;
    const where = `${name} tab ${tabId} (${tab.url || tabUrl})`;
    try {
      return await browser.tabs.sendMessage(tabId, message);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (!NO_LISTENER.test(msg)) throw new Error(`${name} bridge call failed in ${where}: ${msg}`);
    }

    log.info(name, `no bridge listener in tab ${tabId} — injecting ${script}`);
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: [script] });
      await new Promise((r) => setTimeout(r, 300));
      return await browser.tabs.sendMessage(tabId, message);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/Missing host permission|cannot be scripted|not allowed/i.test(msg)) {
        throw new Error(
          `${name}: the extension isn't allowed to run on ${tab.url || tabUrl} (${msg}). ` +
            `Reload the add-on in about:debugging so the updated manifest permissions apply, then retry.`
        );
      }
      if (!NO_LISTENER.test(msg)) throw new Error(`${name} bridge call failed in ${where} after injecting: ${msg}`);
      log.warn(name, `injection didn't produce a listener in tab ${tabId} (${msg})`);
    }

    try {
      await reloadTab(tabId);
      return await browser.tabs.sendMessage(tabId, message);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      throw new Error(
        `${name} bridge unreachable in ${where} even after injecting and reloading it. ` +
          `Close that tab and retry (a fresh one will be opened). Underlying error: ${msg}`
      );
    }
  }

  /**
   * Send `message` to the bridge and unwrap its reply. Throws an Error with
   * `.status` / `.expired` copied from the bridge on failure.
   */
  async function call(message) {
    const tab = await ensureTab();
    if (!tab) {
      // We just opened tabUrl and it no longer matches tabMatch — almost always
      // a redirect to the Midway sign-in page, i.e. an expired session.
      const err = new Error(
        `No ${name} tab on its origin (it was probably redirected to Midway). Sign in at ${tabUrl} and retry.`
      );
      err.expired = true;
      err.status = 401;
      throw err;
    }
    if (tab.discarded) await reloadTab(tab.id);
    const t0 = Date.now();
    let resp = await sendWithInject(tab, message);
    if (resp && resp.bridge && !resp.ok && resp.expired && !message.__retried) {
      // A stale per-site cookie can come back as 401 while Midway itself is
      // still valid. Reloading the tab lets SSO re-issue it; retry once.
      log.warn(name, `session reported expired (${resp.error}) — reloading tab ${tab.id} and retrying once`);
      await reloadTab(tab.id);
      resp = await sendWithInject(tab, { ...message, __retried: true });
      if (resp && resp.ok) log.info(name, "session restored after tab reload");
    }
    if (!resp || !resp.bridge) throw new Error(`${name} bridge returned no response`);
    if (!resp.ok) {
      log.warn(name, `← ${message.action} failed after ${Date.now() - t0}ms: ${resp.error}`);
      const err = new Error(resp.error || `${name} bridge failed (HTTP ${resp.status})`);
      err.status = resp.status;
      err.expired = !!resp.expired;
      throw err;
    }
    log.debug(name, `← ${message.action} ok in ${Date.now() - t0}ms`);
    return resp;
  }

  return { call, findTab, ensureTab };
}
