/**
 * SharePoint client (background side) — used only by the usage roster.
 *
 * The background's own fetch to SharePoint doesn't carry the user's session
 * (write-auth via _api/contextinfo 403s), so every REST op is forwarded to
 * content/sp-bridge.js, which runs ON the SharePoint page and fetches
 * same-origin. We reach that bridge through the shared makeBridge() helper
 * (find/open a tab, inject-on-demand, reload as a last resort) rather than
 * hand-rolling tab logic.
 *
 * usage.js calls spRequest({method,path,body,etag}) and treats failures as
 * data, so this never throws — it unwraps makeBridge's error back into the
 * bridge's { ok, status, data, body, expired } envelope.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "sp",
  tabMatch: Config.SP_TAB_MATCH,
  tabUrl: Config.SP_TAB_URL,
  script: "content/sp-bridge.js",
});

/**
 * Non-throwing REST op (same shape usage.js expects and the MS Viewer's
 * spClient.spRequest returns): { ok, status, data, body, expired }.
 * @param {{method?:string, path:string, body?:any, etag?:string, raw?:boolean}} req
 */
export async function spRequest(req) {
  try {
    // makeBridge unwraps the reply: on ok it returns the whole { bridge, ok,
    // status, data, ... }; on a bridge-level failure it throws an Error with
    // .status / .expired copied across.
    const resp = await bridge.call({ action: "sp:req", ...req });
    return { ok: true, status: resp.status || 200, data: resp.data, body: resp.body || null, expired: false };
  } catch (e) {
    log.debug("sp", `spRequest ${req && req.method || "GET"} ${req && req.path} failed: ${e.message}`);
    return { ok: false, status: (e && e.status) || 0, body: String(e && e.message ? e.message : e), expired: !!(e && e.expired), data: null };
  }
}
