/**
 * SMC draft builder — turns a TMS forecast row into the exact payload the SMC
 * create form sends to /shipper/order/createV3/ (captured 2026-09-29 from a
 * manual draft, order 8241426373), then posts it as status "DRAFT" so the user
 * reviews and submits inside SMC.
 *
 * Two entry points:
 *   prepare(input)  → { payload, resolved, warnings }   (no write; panel preview)
 *   create(payload) → { orderId, response }             (writes the DRAFT)
 *
 * `input` = TMS row fields + the user's edits from the Prepare panel:
 *   { loadId, po, site, weight, pallets, destNode, destAddress,
 *     pickupDate "YYYY-MM-DD", pickupFrom "HH:MM", pickupTo "HH:MM",
 *     deliveryDate "YYYY-MM-DD", deliveryTime "HH:MM", price, currency, shipperId }
 */
import { Config } from "../config.js";
import * as smcClient from "./smcClient.js";
import { findLane, laneDestinations } from "./lanesStore.js";
import * as portalClient from "./portalClient.js";
import { log } from "./debug.js";

const iso = (ms) => (ms == null ? "" : new Date(Number(ms)).toISOString());

// ── time zone maths (no libraries): site-local wall time → UTC ISO ──────────
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

export function localToUtcIso(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mi] = String(timeStr || "00:00").split(":").map(Number);
  if (!y || !m || !d) throw new Error(`Bad date "${dateStr}"`);
  const wall = Date.UTC(y, m - 1, d, hh || 0, mi || 0);
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - tzOffsetMs(utc, tz); // converge across DST edges
  return new Date(utc).toISOString(); // "…T07:30:00.000Z"
}

// ── stop resolution via SMC's own location search ───────────────────────────
const up = (s) => String(s ?? "").trim().toUpperCase();

/**
 * When the TMS destination is a street address (no node code), match it to one
 * of this origin's contracted-lane destinations. Asks SMC for each candidate
 * node's address and compares postcode (best) then city.
 * @returns {{node?:string, candidates?:{node,city,postcode,price}[]}}
 */
async function resolveDestByLane(originCode, postcode, city) {
  const dests = (await laneDestinations(originCode)).filter((d) => /^[A-Z]{2,4}\d?$/i.test(d)); // node-like only
  if (!dests.length) return { candidates: [] };
  const locs = await smcClient.lookupLocations(dests);
  const pc = String(postcode || "").replace(/\s+/g, "").toUpperCase();
  const cty = up(city);
  const cands = await Promise.all(
    dests.map(async (node) => {
      const l = (locs[up(node)] || [])[0] || {};
      const lane = await findLane(originCode, node);
      return { node, city: l.city || "", postcode: l.postalCode || "", price: lane ? lane.price : null, currency: lane ? lane.currency : "EUR" };
    })
  );
  // Exact postcode, then postcode prefix (first 2–3), then city contains.
  let hit = pc && cands.find((c) => c.postcode.replace(/\s+/g, "").toUpperCase() === pc);
  if (!hit && pc.length >= 4) hit = cands.find((c) => c.postcode.replace(/\s+/g, "").toUpperCase().startsWith(pc.slice(0, 3)));
  if (!hit && cty) hit = cands.find((c) => up(c.city) === cty || up(c.city).includes(cty) || cty.includes(up(c.city)));
  if (hit) return { node: hit.node };
  return { candidates: cands.filter((c) => c.city || c.postcode) };
}

function pickLocation(list, { wantType, shipperId }) {
  if (!Array.isArray(list) || !list.length) return null;
  if (wantType === "AMAZON") return list.find((l) => up(l.locationType) === "AMAZON") || list[0];
  // Shipper site: prefer the shipper's own location, then non-Amazon, then any.
  return (
    list.find((l) => shipperId && String(l.shipperId || "") === String(shipperId)) ||
    list.find((l) => up(l.locationType) !== "AMAZON") ||
    list[0]
  );
}

function addressFor(loc, role) {
  const a = loc.addresses || {};
  const pick = role === "PICKUP" ? a.PICKUP || a.GENERAL || a.DELIVERY : a.DELIVERY || a.GENERAL || a.PICKUP;
  const used = pick === a.PICKUP ? "PICKUP" : pick === a.DELIVERY ? "DELIVERY" : pick === a.GENERAL ? "GENERAL" : "";
  return pick ? { addressId: String(pick.addressId), marketplaceId: pick.marketplaceId || "", used } : null;
}

const nullContact = () => ({ phone: null, name: null, email: null });
const tzObj = (id) => ({ label: "", daylightSavings: "", utcOffset: "", id });

/** Resolve everything and build the createV3 payload. Never writes. */
export async function prepare(input) {
  const warnings = [];
  const d = Config.SMC_ORDER_DEFAULTS;
  const siteKey = Config.SITE_CODES[input.site];
  const site = Config.SITES[siteKey];
  if (!site) throw Object.assign(new Error(`Unknown site code "${input.site}" — add it to Config.SITE_CODES first.`), { config: true });
  const pickupQuery = site.smcPickupCode || site.smcPickup;
  if (!pickupQuery) throw Object.assign(new Error(`No SMC pickup location configured for ${site.name} (Config.SITES.${siteKey}.smcPickupCode).`), { config: true });
  const shipperId = String(input.shipperId || "").trim();
  if (!shipperId) throw Object.assign(new Error("No P&G shipper ID configured (Settings)."), { config: true });
  if (!input.loadId) throw new Error("Load ID missing.");
  if (!input.po) throw new Error("PO missing.");

  // Procurement Portal is the authoritative source for the delivery FC and the
  // PO delivery window (BOL == PO == poId). Best-effort: if the portal is
  // unreachable we fall back to the TMS-derived destination and window, but a
  // resolved PO WINS over the address/lane guess. A user-picked node still wins
  // over everything.
  let po = null;
  if (!input.destNodePicked) {
    try {
      const pos = await portalClient.lookupPos([input.po]);
      po = pos[String(input.po).trim()] || pos[input.po] || null;
      if (po && !po.found) po = null;
    } catch (e) {
      if (e.expired) warnings.push("Procurement Portal session expired — used the TMS destination/window instead. Sign in to verify.");
      else warnings.push(`Procurement Portal lookup failed (${e.message}) — used the TMS destination/window.`);
    }
  }

  // Destination node: PO fcId (authoritative) → TMS column code → resolve the
  // street address against this origin's lanes → user pick.
  let destNode = input.destNode;
  let destResolvedBy = destNode ? (input.destNodePicked ? "manual" : "tms") : "";
  if (po && po.fcId && !input.destNodePicked) {
    if (destNode && up(destNode) !== up(po.fcId)) {
      warnings.push(`TMS destination ${destNode} ≠ PO delivery FC ${po.fcId} — using the PO's ${po.fcId}.`);
    }
    destNode = po.fcId;
    destResolvedBy = "po";
  }
  if (!destNode) {
    const r = await resolveDestByLane(pickupQuery, input.destPostcode, input.destCity);
    if (r.node) {
      destNode = r.node;
      destResolvedBy = "lane";
    } else if (r.candidates && r.candidates.length) {
      const e = new Error(
        `Destination "${input.destAddress || ""}" is an address, not a node. Pick the Amazon node from this origin's lanes.`
      );
      e.pickNode = true;
      e.candidates = r.candidates; // [{node, city, postcode, price}]
      throw e;
    } else {
      throw new Error(`Could not resolve destination "${input.destAddress || ""}" to an Amazon node — enter the node manually.`);
    }
  }

  // Locations (pickup resolved by SMC location code where we have it)
  const locs = await smcClient.lookupLocations([pickupQuery, destNode]);
  const pickList = locs[up(pickupQuery)];
  const dropList = locs[up(destNode)];
  if (!Array.isArray(pickList) || !pickList.length) throw new Error(`SMC has no location "${pickupQuery}" for the pickup.`);
  if (!Array.isArray(dropList) || !dropList.length) throw new Error(`SMC has no location "${destNode}" for the delivery.`);
  const pickLoc = pickLocation(pickList, { shipperId });
  const dropLoc = pickLocation(dropList, { wantType: "AMAZON" });
  const pickAddr = addressFor(pickLoc, "PICKUP");
  const dropAddr = addressFor(dropLoc, "DELIVERY");
  if (!pickAddr) throw new Error(`Location "${pickLoc.locationName}" has no address id.`);
  if (!dropAddr) throw new Error(`Location "${dropLoc.locationName}" has no address id.`);
  // GENERAL is the normal single address; only flag a cross-role fallback.
  if (pickAddr.used === "DELIVERY") warnings.push(`Pickup uses the DELIVERY address of ${pickLoc.locationName} (no PICKUP/GENERAL address).`);
  if (dropAddr.used === "PICKUP") warnings.push(`Delivery uses the PICKUP address of ${dropLoc.locationName} (no DELIVERY/GENERAL address).`);

  // Times (site-local → UTC)
  const pickTz = site.tz;
  const dropTz = Config.COUNTRY_TZ[up(dropLoc.country)] || pickTz;
  const pickupStart = localToUtcIso(input.pickupDate, input.pickupFrom || d.pickupFrom, pickTz);
  const pickupEnd = localToUtcIso(input.pickupDate, input.pickupTo || input.pickupFrom || d.pickupTo, pickTz);
  const deliveryAt = localToUtcIso(input.deliveryDate || input.pickupDate, input.deliveryTime || d.deliveryTime, dropTz);
  if (pickupEnd < pickupStart) throw new Error("Pickup window ends before it starts.");
  if (deliveryAt <= pickupStart) warnings.push("Delivery time is not after the pickup start.");

  // Cross-check the delivery against the authoritative PO delivery window
  // (handOffStart..handOffEnd; end = "Latest Vendor Delivery Date"). Compare by
  // day so a time-of-day choice doesn't false-trip.
  if (po && po.windowStartMs != null && po.windowEndMs != null) {
    const day = (iso) => String(iso).slice(0, 10);
    const startDay = day(new Date(po.windowStartMs).toISOString());
    const endDay = day(new Date(po.windowEndMs).toISOString());
    const dDay = day(deliveryAt);
    if (dDay < startDay || dDay > endDay) {
      warnings.push(`Delivery ${dDay} is OUTSIDE the PO window ${startDay} → ${endDay} (Latest Vendor Delivery ${endDay}). Book inside the window, then push per RDD.`);
    }
  }

  // Numbers
  const weight = Math.round((Number(input.weight) || 0) * 10) / 10;
  const pallets = Math.round(Number(input.pallets) || 0);
  if (!weight) warnings.push("Weight is 0 — Shipment Weight was not read from TMS.");
  if (!pallets) warnings.push("Pallet count is 0 — Shipment Laden Length was not read from TMS.");
  // Contracted lane (origin code → destination node). Drives the default price
  // and equipment, and lets us warn when the load isn't on a contracted lane.
  const lane = await findLane(pickLoc.nodeCode || pickupQuery, dropLoc.nodeCode || destNode);
  const today = new Date().toISOString().slice(0, 10);
  if (!lane) {
    warnings.push(`No contracted lane ${pickLoc.nodeCode || pickupQuery} → ${dropLoc.nodeCode || destNode} — check the rate.`);
  } else if (lane.validTo && lane.validTo < today) {
    warnings.push(`The contracted lane expired ${lane.validTo} — check the current rate.`);
  } else if (lane.validFrom && lane.validFrom > today) {
    warnings.push(`The contracted lane doesn't start until ${lane.validFrom}.`);
  }

  // Price: user input wins; otherwise the contracted lane rate.
  const price = Number(input.price) || (lane && lane.price) || 0;
  const currency = (input.currency || (lane && lane.currency) || site.currency || "EUR").toUpperCase();
  if (!price) warnings.push("No shipper price (no lane rate and none entered) — the draft will have no LINE_HAUL price.");
  else if (!input.price && lane) warnings.push(`Using the contracted lane rate ${lane.price} ${lane.currency}.`);

  // Distance (best effort, like the form)
  let totalDistance = { unit: "KM", value: 0 };
  try {
    const m = await smcClient.mileage(
      { postalCode: pickLoc.postalCode, countryCode: pickLoc.country },
      { postalCode: dropLoc.postalCode, countryCode: dropLoc.country }
    );
    if (m && m.value) totalDistance = { unit: m.unit || "KM", value: m.value };
    else warnings.push("Distance could not be computed; sending 0 km.");
  } catch (e) {
    warnings.push(`Distance lookup failed (${e.message}); sending 0 km.`);
  }

  const pickupStop = {
    stopId: "1",
    stopName: pickLoc.locationName || site.smcPickup,
    stopLocationCode: pickLoc.nodeCode || "",
    addressIdentifier: { addressId: pickAddr.addressId, marketplaceId: pickAddr.marketplaceId },
    postalCode: "",
    stopReferenceId: { type: "STOP_REFERENCE_ID", id: String(input.loadId) },
    stopActionType: "PICKUP",
    loadingType: d.loadingType,
    instructions: "",
    appointmentType: "FIRST_COME_FIRST_SERVE",
    appointmentId: null,
    fasAppointmentId: null,
    stopAttributes: [
      ...(pickLoc.city ? [{ type: "CITY", value: pickLoc.city }] : []),
      ...(site.smcState || pickLoc.state ? [{ type: "STATE", value: site.smcState || pickLoc.state }] : []),
      ...(pickLoc.country ? [{ type: "COUNTRY_CODE", value: pickLoc.country }] : []),
    ],
    contacts: [nullContact()],
    sequence: 1,
    timeZone: tzObj(pickTz),
    startTime: pickupStart,
    endTime: pickupEnd,
    requestedTimeWindow: { start: pickupStart, end: pickupEnd },
  };
  const dropStop = {
    stopId: "2",
    stopName: dropLoc.locationName || destNode,
    stopLocationCode: dropLoc.nodeCode || destNode,
    addressIdentifier: { addressId: dropAddr.addressId, marketplaceId: dropAddr.marketplaceId },
    postalCode: "",
    stopReferenceId: null,
    stopActionType: "DROP_OFF",
    loadingType: d.loadingType,
    instructions: "",
    appointmentType: "APPOINTMENT",
    appointmentId: null,
    fasAppointmentId: null,
    stopAttributes: [],
    contacts: [nullContact(), nullContact()],
    sequence: 2,
    timeZone: tzObj(dropTz),
    startTime: deliveryAt,
    endTime: deliveryAt,
    requestedTimeWindow: { start: deliveryAt, end: deliveryAt },
  };

  const pricing = price
    ? [
        {
          price: { unit: currency, value: price },
          reasonCode: "ORIGINAL",
          pricingCode: "LINE_HAUL",
          pricingId: null,
          pricingComponentId: null,
          audit: null,
          invoiceNumber: null,
          chargeStatus: null,
          invoiceNote: null,
          authorizationNumber: null,
          chargeDocuments: [],
          taxComponents: [],
          itemized: [],
          pricingCalculation: null,
          type: "LINE_HAUL",
          description: "Line Haul",
        },
      ]
    : [];

  const payload = {
    executionAttributes: [],
    orderDetails: {
      shipperDetails: {
        shipperId,
        shipperName: input.shipperName || d.shipperName,
        shipperBusinessChannel: d.businessChannel,
      },
      shipperReferenceId: { type: "SHIPPER_REFERENCE_ID", id: String(input.loadId) },
      equipmentType: d.equipmentType,
      specialRequirements: [],
      invoicePreference: d.invoicePreference,
      totalWeight: { value: weight, unit: d.weightUnit },
      valuation: null,
      totalDistance,
      shipperPricingDistance: { value: 0, unit: "" },
      stops: [pickupStop, dropStop],
      commodities: [
        {
          commodityId: null,
          packageDetails: { unit: 1, type: "BOX" },
          handlingDetails: { unit: pallets, type: d.palletType },
          referenceId: null,
          referenceIds: [{ type: "PURCHASE_ORDER_ID", id: String(input.po) }],
          weight: { value: weight, unit: d.weightUnit },
          isInternalMovement: false,
          stackable: false,
          originStopLocationCode: pickupStop.stopLocationCode,
          destinationStopLocationCode: dropStop.stopLocationCode,
          originStopName: pickupStop.stopName,
          originStopId: "1",
          destinationStopName: dropStop.stopName,
          destinationStopId: "2",
          type: "Freight",
        },
      ],
      executionAttributes: [],
      unmatchedCommodities: [],
      shipperPricing: { pricing, type: "DETAILED" },
      carrierDetails: { carrierPricing: { pricing: [] } },
      documents: [],
      carrierOfferCount: 0,
      freightType: d.freightType,
      additionalReferenceIdList: [{ type: "BILL_OF_LADING_NUMBER", id: String(input.po) }],
      driverType: null,
      dangerousGoodsClassification: "NON_DANGEROUS",
    },
    status: "DRAFT",
  };

  const resolved = {
    pickup: { ...pickLoc, addressUsed: pickAddr, tz: pickTz, start: pickupStart, end: pickupEnd },
    delivery: { ...dropLoc, addressUsed: dropAddr, tz: dropTz, at: deliveryAt },
    distance: totalDistance,
    weight,
    pallets,
    price: price ? { value: price, currency, fromLane: !input.price && !!lane } : null,
    lane: lane ? { key: `${pickLoc.nodeCode || pickupQuery}->${dropLoc.nodeCode || destNode}`, price: lane.price, currency: lane.currency, validTo: lane.validTo } : null,
    destNode,
    destResolvedBy,
    po: po ? { poId: po.poId, fcId: po.fcId, windowStart: po.windowStart, windowEnd: po.windowEnd, vendor: po.vendor, condition: po.condition } : null,
    siteKey,
  };
  log.info("draft", `prepared ${input.loadId}: ${pickupStop.stopName} → ${dropStop.stopName}, ${pallets} plt, ${weight} kg, ${totalDistance.value} ${totalDistance.unit}`);
  return { payload, resolved, warnings };
}

/** POST the prepared payload as a DRAFT. Returns { orderId, response }. */
export async function create(payload) {
  if (!payload || payload.status !== "DRAFT") throw new Error("Refusing to create: payload is not a DRAFT.");
  const r = await smcClient.createOrder(payload);
  log.info("draft", `created DRAFT ${r.orderId || "(id not in response)"} for ${payload.orderDetails?.shipperReferenceId?.id}`);
  return r;
}
