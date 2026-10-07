/**
 * Vendor names — Procurement Portal lookup with a long-lived cache.
 *
 * Programme shipper accounts (e.g. WePay) give every run the same placeholder
 * shipper name, hiding the actual vendor. SMC puts a VENDOR_CODE on the order;
 * this turns that code into the vendor's name:
 *
 *   SMC order additionalReferenceIdList[type=VENDOR_CODE]   → the code
 *     → Portal /bp-api/vendor                               → code → name
 *       → buyingPortalVendorData[].vendorName               → shown in the table
 *
 * Vendor names don't change in practice, so resolved codes are cached in
 * browser.storage for Config.VENDOR_CACHE_DAYS. Each code then costs one Portal
 * call a month rather than one per order.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";
import { log } from "./debug.js";

const bridge = makeBridge({
  name: "vendor",
  tabMatch: Config.VENDOR_TAB_MATCH,
  tabUrl: Config.VENDOR_TAB_URL,
  script: "content/vendor-bridge.js",
});

const CACHE_KEY = "ltl.vendorNames";
const TTL_MS = (Number(Config.VENDOR_CACHE_DAYS) || 30) * 86_400_000;
// Keep requests modest — the Portal is asked for many codes at once otherwise.
const BATCH = 50;

async function readCache() {
  try {
    const got = await browser.storage.local.get(CACHE_KEY);
    return (got && got[CACHE_KEY]) || {};
  } catch {
    return {};
  }
}
async function writeCache(cache) {
  try {
    await browser.storage.local.set({ [CACHE_KEY]: cache });
  } catch {
    /* cache is an optimisation, never a hard requirement */
  }
}

/**
 * Resolve vendor codes to names.
 *
 * Best-effort by design: a Portal that's unreachable or signed out must not
 * break the load — unresolved codes simply come back absent, and the UI shows
 * the raw code so the row is still identifiable.
 *
 * @param {string[]} codes
 * @param {{force?: boolean}} [opts] force re-reads even cached codes
 * @returns {Promise<{names: Record<string,string>, resolved: number, missing: string[], error?: string}>}
 */
export async function lookupVendors(codes = [], { force = false } = {}) {
  const wanted = [...new Set(codes.map((c) => String(c ?? "").trim()).filter(Boolean))];
  if (!wanted.length) return { names: {}, resolved: 0, missing: [] };

  const cache = await readCache();
  const now = Date.now();
  const names = {};
  const todo = [];
  for (const code of wanted) {
    const hit = cache[code];
    if (!force && hit && hit.name && now - (hit.at || 0) < TTL_MS) names[code] = hit.name;
    else todo.push(code);
  }
  if (!todo.length) {
    log.debug("vendor", `all ${wanted.length} code(s) from cache`);
    return { names, resolved: wanted.length, missing: [] };
  }

  log.info("vendor", `${wanted.length} code(s): ${wanted.length - todo.length} cached, ${todo.length} to look up`);
  let error = null;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const resp = await bridge.call({ action: "vendor:lookup", codes: batch });
      for (const [code, name] of Object.entries(resp.names || {})) {
        names[code] = name;
        cache[code] = { name, at: now };
      }
    } catch (e) {
      // bridgeClient already reloads the tab and retries once on an expired
      // session, so reaching here means it genuinely couldn't resolve.
      error = String((e && e.message) || e);
      log.warn("vendor", `lookup failed for ${batch.length} code(s): ${error}`);
      break;
    }
  }
  await writeCache(cache);

  const missing = wanted.filter((c) => !names[c]);
  if (missing.length) log.warn("vendor", `unresolved: ${missing.slice(0, 10).join(", ")}`);
  return { names, resolved: wanted.length - missing.length, missing, ...(error ? { error } : {}) };
}

/** Throws (with .expired) when the Portal session is gone. */
export async function ping() {
  await bridge.call({ action: "vendor:ping" });
  return true;
}
