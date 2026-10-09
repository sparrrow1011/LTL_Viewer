/**
 * SMC client — delegates to the SMC-origin bridge (content/smc.js).
 *
 * The UI is a standalone extension page, so it can't fetch SMC with the user's
 * session or read the page's CSRF token. A content script on an SMC tab does
 * the fetch same-origin and answers `smc:*` messages; this module finds (or
 * opens) that tab and forwards the call. Same pattern as SharePoint and FMC.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";

const bridge = makeBridge({
  name: "smc",
  tabMatch: Config.SMC_TAB_MATCH,
  tabUrl: Config.SMC_TAB_URL,
  script: "content/smc.js",
});

/**
 * Loads still needing sourcing for the window (one row per VRID).
 * @param {{start,end}} win   ISO bounds (see content/smc.js resolveWindow)
 * @param {object} opts       { query, shipperIds, sourcing, shipperMap } (team-scoped)
 * @returns {Promise<{ rows: object[] }>}
 */
export async function fetchSourcingRows(win, opts = {}) {
  const resp = await bridge.call({ action: "smc:sourcingRows", win, opts });
  // `meta` reports SMC's paging outcome ({total, fetched, pages, truncated});
  // callers that need the complete population must check `truncated`.
  return { rows: resp.rows || [], meta: resp.meta || null };
}

/**
 * Look up specific order IDs / VRIDs regardless of sourcing state.
 * @returns {Promise<{ rows, found: string[], missing: string[], source }>}
 */
export async function lookupByIds(ids, win, opts = {}) {
  const resp = await bridge.call({ action: "smc:lookup", ids, win, opts });
  return {
    rows: resp.rows || [],
    found: resp.found || [],
    missing: resp.missing || [],
    source: resp.source,
    outsideShippers: resp.outsideShippers || [],
  };
}

/**
 * Dry run for "why isn't this run on the sourcing list?". Replays the team's
 * real sourcing query and reports each gate instead of only the survivors.
 * @returns {Promise<object>} see diagnoseIds in content/smc.js
 */
export async function diagnose(ids, win, opts = {}) {
  const resp = await bridge.call({ action: "smc:diagnose", ids, win, opts });
  return resp.report || null;
}

/** Signed-in SMC alias (used for manual_source_by / email_sent_by). */
export async function getRequester() {
  const resp = await bridge.call({ action: "smc:requester" });
  return resp.requester || null;
}

/** Throws (with .expired) when the SMC session is gone. */
export async function ping() {
  await bridge.call({ action: "smc:ping" });
  return true;
}
