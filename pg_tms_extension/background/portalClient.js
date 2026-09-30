/**
 * Procurement Portal client (background side).
 *
 * Delegates to content/portal.js on a portal tab (Midway cookie session), same
 * makeBridge pattern as SMC. Looks up POs (= BOLs = TMS Customer Purchase
 * Orders) to get the authoritative delivery FC (fcId) and PO delivery window
 * (handOffStart..handOffEnd, end = "Latest Vendor Delivery Date").
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";

const bridge = makeBridge({
  name: "portal",
  tabMatch: Config.PORTAL_TAB_MATCH,
  tabUrl: Config.PORTAL_TAB_URL,
  script: "content/portal.js",
});

/** Throws (with .expired) when the portal session is gone. */
export async function ping() {
  await bridge.call({ action: "portal:ping" });
  return true;
}

/**
 * Look up PO records. @returns {Record<string, {found, fcId, windowStart,
 * windowEnd, ...}>} keyed by poId.
 */
export async function lookupPos(poIds) {
  const ids = (poIds || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return {};
  const resp = await bridge.call({ action: "portal:po", poIds: ids });
  return resp.pos || {};
}
