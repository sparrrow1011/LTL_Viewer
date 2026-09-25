/**
 * SMC client (background side). Routes through content/smc-bridge.js to pull
 * the team's (orderid, vrid) pairs for the sweep window.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "smc",
  tabMatch: Config.SMC_TAB_MATCH,
  tabUrl: Config.SMC_TAB_URL,
  script: "content/smc-bridge.js",
});

export async function ping() {
  await bridge.call({ action: "smc:ping" });
  return true;
}

/** Signed-in alias from an EXISTING SMC tab only (never opens one just for this). */
export async function getRequester() {
  const tab = await bridge.findTab();
  if (!tab) return null;
  const resp = await browser.tabs.sendMessage(tab.id, { action: "smc:requester" }).catch(() => null);
  return resp && resp.ok ? resp.requester : null;
}

/**
 * fetch_paragon_queries window: [today - daysBack, today + daysForward] as
 * whole UTC days.
 */
export function sweepWindow({ daysBack, daysForward } = Config.SWEEP_WINDOW) {
  const day = 86_400_000;
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const start = new Date(todayUtc.getTime() - daysBack * day);
  const end = new Date(todayUtc.getTime() + daysForward * day + day - 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * @param {object} team        Config.TEAMS[x]
 * @param {string[]} shipperIds  CST shipper allow-list (smc.py shipperIds)
 * @param {{start,end}} [win]
 * @returns {Promise<{pairs:object[], orders:number, total:number, truncated:boolean, window:{start,end}}>}
 *   pairs: one row per (orderid, vrid) — vrid "" when SMC has none yet
 */
export async function getPairs(team, shipperIds, win = sweepWindow()) {
  const resp = await bridge.call({ action: "smc:pairs", window: win, query: team.smcQuery, shipperIds });
  log.debug("smc", `${resp.orders}/${resp.total} orders → ${resp.pairs.length} rows (${win.start} → ${win.end})`);
  return {
    pairs: resp.pairs || [],
    orders: resp.orders || 0,
    total: resp.total || 0,
    truncated: !!resp.truncated,
    window: win,
  };
}
