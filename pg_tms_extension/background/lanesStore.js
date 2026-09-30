/**
 * Lane store — built-in contracted lanes (lanes.js) plus user-added ones kept
 * in storage.local["pg.customLanes"], editable in the overlay's Settings.
 *
 * Custom lanes override built-ins on the same "ORIGIN->DEST" key. Everything
 * that needs a lane goes through here so a lane added in Settings is picked up
 * by the draft builder and the alignment check alike.
 */
import { LANES as BUILTIN, laneDestinations as builtinDests } from "../lanes.js";

const KEY = "pg.customLanes";
let _cache = null; // merged map, invalidated on save

async function customMap() {
  const stored = (await browser.storage.local.get(KEY))[KEY] || {};
  return stored && typeof stored === "object" ? stored : {};
}

async function merged() {
  if (_cache) return _cache;
  _cache = { ...BUILTIN, ...(await customMap()) };
  return _cache;
}

export function invalidate() {
  _cache = null;
}

/** Lane for an origin→destination, or null. Custom wins over built-in. */
export async function findLane(origin, dest) {
  const m = await merged();
  return m[`${origin}->${dest}`] || null;
}

/** Destination node codes contracted from an origin (built-in + custom). */
export async function laneDestinations(origin) {
  const m = await merged();
  const prefix = origin + "->";
  const out = [];
  for (const key of Object.keys(m)) if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  return out;
}

/** Custom lanes only, for the Settings editor: [{ key, origin, dest, ...fields }]. */
export async function listCustom() {
  const c = await customMap();
  return Object.entries(c).map(([key, v]) => {
    const [origin, dest] = key.split("->");
    return { key, origin, dest, ...v };
  });
}

/**
 * Add or replace a custom lane.
 * @param {{origin,dest,price,currency,equipment,freightType,validFrom,validTo}} lane
 */
export async function saveCustom(lane) {
  const origin = String(lane.origin || "").trim();
  const dest = String(lane.dest || "").trim();
  if (!origin || !dest) throw new Error("Lane needs both an origin and a destination code.");
  const price = Number(lane.price);
  const c = await customMap();
  c[`${origin}->${dest}`] = {
    price: Number.isFinite(price) ? price : null,
    currency: (lane.currency || "EUR").toUpperCase(),
    equipment: lane.equipment || "Single Deck Trailer",
    freightType: lane.freightType || "TRUCKLOAD",
    loadingType: lane.loadingType || "LIVE_LOAD",
    deliveryLoadingType: lane.deliveryLoadingType || "LIVE_LOAD",
    validFrom: lane.validFrom || null,
    validTo: lane.validTo || null,
    maxPallets: lane.maxPallets != null ? Number(lane.maxPallets) : null,
    custom: true,
  };
  await browser.storage.local.set({ [KEY]: c });
  invalidate();
  return listCustom();
}

/** Remove a custom lane by "ORIGIN->DEST" key. */
export async function deleteCustom(key) {
  const c = await customMap();
  delete c[key];
  await browser.storage.local.set({ [KEY]: c });
  invalidate();
  return listCustom();
}
