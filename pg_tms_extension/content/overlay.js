/**
 * P&G TMS Viewer — in-page overlay.
 *
 * Runs in every TMS frame (manifest all_frames:true, after content/tms.js) but
 * only MOUNTS in the frame that holds the Shipment Leg list table. TMS is a
 * frameset whose top document is a <frameset> (no <body> to draw into), so the
 * overlay lives in the list frame itself and reads the table right there via
 * window.__pgTms.extract() — no background round-trip.
 *
 * What it adds on top of the raw list:
 *   • Check SMC   — asks the background (→ SMC bridge) which Load IDs already
 *                   have an SMC order (Load ID == SMC shipper reference). Rows
 *                   without one are the NEW forecast loads to create.
 *   • Copy new    — Load ID + PO (+ site, CRDD, pallets, window) as TSV for the
 *                   daily task sheet. Replaces the CSV/unified-portal/Excel
 *                   conditional-formatting dance from the SOP.
 *   • Site panel  — click a site to see docks, equipment, contacts and the
 *                   site-specific SOP notes (from Config.SITES via getConfig).
 *   • Settings    — P&G shipper ID(s) in SMC and the search window padding.
 *
 * Same shape as extension/content/overlay.js from LTL_Viewer. Mount id / class
 * prefix is `pg-` — keep it stable across versions.
 */
(function () {
  "use strict";

  const TABLE_ID = "ShipmentLegListSEARCH_RESULTSTableID";
  const ROOT_ID = "pg-overlay-root";
  const TOGGLE_ID = "pg-overlay-toggle";

  function dlog(...a) {
    if (window.__pgDebug) console.debug("[PG overlay]", ...a);
  }

  const hasTable = () => !!document.getElementById(TABLE_ID);

  // ── tiny DOM helpers ────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── background messaging ────────────────────────────────────────────────────
  async function call(action, extra = {}, timeoutMs = 20_000) {
    // A background that failed to start makes sendMessage hang forever in
    // Firefox; surface that as an error instead of a blank panel.
    let timer;
    const res = await Promise.race([
      browser.runtime.sendMessage({ action, ...extra }),
      new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`No answer from the extension background for "${action}" after ${timeoutMs / 1000}s — reload the add-on in about:debugging and check its console for errors.`)),
          timeoutMs
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || "No response from the background");
      err.expired = !!(res && res.expired);
      err.permission = !!(res && res.permission);
      err.config = !!(res && res.config);
      err.pickNode = !!(res && res.pickNode);
      err.candidates = (res && res.candidates) || null;
      throw err;
    }
    return res.data;
  }

  // ── state ───────────────────────────────────────────────────────────────────
  let root = null;
  let cfg = { siteNames: {}, siteCodes: {}, sites: {}, smcTabUrl: "", idcNodes: [] };
  const isIdc = (node) => !!node && (cfg.idcNodes || []).includes(String(node).toUpperCase());
  let settings = { shipperIds: [], windowPadDays: 2 };
  let lastRows = [];
  // SMC check result: { matches: {loadId: {orders:[...]}}, unmatched: [loadId], at: Date }
  let smc = null;
  let newOnly = false;
  let hideIdc = false; // hide IDC-destination rows, leave the rest
  let filterTerms = []; // toolbar filter: every term must match somewhere in the row
  let accessMissing = []; // origins the add-on can't touch yet (see siteAccess)
  let extractMeta = { mapping: "", missing: [] }; // how tms.js mapped the columns
  let configError = ""; // background unreachable / failed at open
  let controlState = null; // { alias, installId, verdict, notice, ... } from controlStatus

  const siteFor = (code) => cfg.sites[cfg.siteCodes[code]] || null;
  const siteName = (r) => (cfg.siteNames[r.site] || r.siteName || r.site || "");
  const smcFor = (r) => (smc && smc.matches[r.loadId]) || null;
  const isNew = (r) => !!smc && !smc.matches[r.loadId] && !!r.loadId;
  // PO data (Procurement Portal) attached to a row by Check, keyed by load.
  const poFor = (r) => (smc && smc.po && smc.po[r.loadId]) || null;
  // Destination (PP): the PO's delivery FC, else the TMS destination node/address.
  const destPP = (r) => {
    const p = poFor(r);
    return (p && p.found && p.fcId) || r.destNode || r.destAddress || "";
  };
  // The destination NODE code to judge IDC on: PO fcId (authoritative) first,
  // then the TMS node. A street-address row only has a node after Check pulls
  // the PO, so IDC on those rows appears once the PO is known.
  const destNodeOf = (r) => {
    const p = poFor(r);
    return (p && p.found && p.fcId) || r.destNode || "";
  };
  // The portal renders the Vendor Delivery Dates in a FIXED GMT+1 (not DST), so
  // e.g. 2026-10-06T00:00Z shows as "06/10/2026 01:00 GMT+1". Match that exactly
  // so the extension and the portal always read identically.
  const day = (v) => (v ? String(v).slice(0, 10) : "");
  function fmtPortal(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const t = new Date(d.getTime() + 3600_000); // UTC+1, fixed
    const p = (n) => String(n).padStart(2, "0");
    return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  }
  // PO Window (PP): Earliest → Latest Vendor Delivery Date (portal GMT+1), else
  // the TMS delivery window.
  const windowPP = (r) => {
    const p = poFor(r);
    if (p && p.found && (p.windowStart || p.windowEnd)) {
      return `${fmtPortal(p.windowStart)} → ${fmtPortal(p.windowEnd)} GMT+1`;
    }
    return r.poWindow || "";
  };

  // ── columns ─────────────────────────────────────────────────────────────────
  const VIEW_COLUMNS = [
    { key: "po", label: "PO / BOL" },
    { key: "site", label: "Site", render: renderSite },
    { key: "status", label: "Status", render: renderStatus },
    { key: "loadId", label: "Load ID" },
    { key: "smc", label: "SMC", render: renderSmc },
    { key: "smcDetails", label: "SMC order", render: renderSmcDetails, onlyAfterCheck: true },
    { key: "smcChecks", label: "SMC checks", render: renderSmcChecks, onlyAfterCheck: true },
    { key: "crdd", label: "CRDD (Pickup From)" },
    {
      key: "poWindow",
      label: "PO Window (PP)",
      render: (r) => {
        const p = poFor(r);
        if (p && p.found && (p.windowStart || p.windowEnd)) {
          return `${esc(fmtPortal(p.windowStart))} → ${esc(fmtPortal(p.windowEnd))} <span class="pg-muted">GMT+1</span> <span class="pg-pp">PP</span>`;
        }
        return esc(r.poWindow || "—"); // TMS window (already dd/mm/yyyy hh:mm)
      },
    },
    {
      key: "destPP",
      label: "Destination (PP)",
      render: (r) => {
        const p = poFor(r);
        const pp = p && p.found && p.fcId;
        const v = destPP(r);
        const idc = isIdc(destNodeOf(r)) ? ' <span class="pg-flag pg-idc">IDC</span>' : "";
        return `${esc(v || "—")}${idc}${pp ? ' <span class="pg-pp">PP</span>' : ""}`;
      },
    },
    { key: "appointment", label: "Appointment (ISA)" },
    // Pallets = Shipment Laden Length (M) rounded (what goes into SMC);
    // Theoretical Pallets stays in the tooltip / CSV.
    {
      key: "smcPallets",
      label: "Pallets",
      render: (r) =>
        `<span title="Laden length ${esc(r.ladenLength || "—")} · Theoretical pallets ${esc(r.pallets || "—")}">${esc(
          r.smcPallets !== "" && r.smcPallets != null ? r.smcPallets : r.pallets
        )}</span>`,
    },
    {
      key: "weight",
      label: "Weight (kg)",
      render: (r) => (r.weight === "" || r.weight == null ? `<span class="pg-muted" title="Shipment Weight column not found on the list">—</span>` : esc(r.weight)),
    },
    { key: "originCity", label: "Origin City" },
    { key: "flags", label: "Checks", render: renderFlags },
  ];

  const CSV_COLUMNS = [
    ["po", "PO / BOL"],
    ["site", "Site Code"],
    ["siteName", "Site"],
    ["status", "Status"],
    ["loadId", "Load ID"],
    ["smcState", "In SMC"],
    ["smcOrderIds", "SMC Order"],
    ["smcExecution", "SMC Status"],
    ["smcOrigin", "SMC Pickup Stop"],
    ["smcPickup", "SMC Pickup Time"],
    ["smcIsa", "SMC ISA"],
    ["smcBol", "SMC BOL"],
    ["smcCarrier", "SMC Carrier"],
    ["smcVrid", "SMC VRID"],
    ["smcChecks", "SMC Checks"],
    ["crdd", "CRDD"],
    ["deliveryFrom", "Delivery From"],
    ["deliveryTo", "Delivery To"],
    ["poWindowPP", "PO Window (PP)"],
    ["destinationPP", "Destination (PP)"],
    ["appointment", "Appointment ISA"],
    ["smcPallets", "Pallets (SMC)"],
    ["weight", "Weight (kg)"],
    ["pallets", "Theoretical Pallets"],
    ["ladenLength", "Laden Length (M)"],
    ["originCity", "Origin City"],
    ["destAddress", "Destination"],
    ["idc", "IDC"],
    ["shipmentId", "Shipment ID"],
    ["customerName", "Customer"],
  ];

  // What goes on the daily task sheet for each NEW load.
  const TASK_COLUMNS = [
    ["loadId", "Load ID"],
    ["po", "PO"],
    ["siteName", "Site"],
    ["crdd", "CRDD"],
    ["poWindow", "PO Window"],
    ["smcPallets", "Pallets"],
    ["weight", "Weight (kg)"],
    ["idc", "IDC"],
    ["status", "TMS Status"],
  ];

  function renderSite(r) {
    const name = siteName(r);
    const known = !!siteFor(r.site);
    return `<button type="button" class="pg-link pg-site-btn${known ? "" : " pg-site-unknown"}" data-site="${esc(r.site)}" title="${
      known ? "Site rules, docks and contacts" : "No site rules configured for this Origin Location ID"
    }">${esc(name)}</button>`;
  }

  function renderStatus(r) {
    const cls = r.isTenderAccepted ? "pg-accepted" : "pg-open";
    return `<span class="pg-pill ${cls}">${esc(r.status || "—")}</span>`;
  }

  function createUrl() {
    const sid = settings.shipperIds[0];
    return sid && cfg.smcCreateUrl ? cfg.smcCreateUrl.replace("__SHIPPER__", encodeURIComponent(sid)) : "";
  }

  function renderSmc(r) {
    if (!smc) return `<span class="pg-muted">not checked</span>`;
    const hit = smcFor(r);
    if (!hit) {
      return (
        `<span class="pg-pill pg-new">NEW</span>` +
        `<br><button type="button" class="pg-link pg-small pg-prepare" data-load="${esc(
          r.loadId
        )}" title="Resolve everything the SMC new-order form needs for this load">Prepare SMC order</button>`
      );
    }
    return hit.orders
      .map(
        (o) =>
          `<a class="pg-link" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.orderid)}</a>` +
          ` <span class="pg-muted pg-small">${esc(o.order_status || "")}${
            o.execution_status && o.execution_status !== o.order_status ? " / " + esc(o.execution_status) : ""
          }</span>`
      )
      .join("<br>");
  }

  // ISO UTC → "DD/MM/YYYY HH:MM" in the stop's own time zone (falls back to the
  // browser's), so it reads like the TMS columns next to it.
  function fmtTime(iso, tz) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d
        .toLocaleString("en-GB", { timeZone: tz || undefined, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
        .replace(",", "");
    } catch {
      return d.toLocaleString("en-GB").replace(",", "");
    }
  }

  // What the SMC order says: pickup stop + time, ISA, carrier, VRID, BOL.
  function renderSmcDetails(r) {
    const hit = smcFor(r);
    if (!smc || !hit) return "";
    return hit.orders
      .map((o) => {
        const bits = [];
        bits.push(`<b>${esc(o.origin || o.origin_code || "?")}</b> ${esc(fmtTime(o.pickup_time, o.pickup_tz))}`);
        bits.push(`→ ${esc(o.dest || o.dest_code || "?")} ${esc(fmtTime(o.delivery_time, null))}`);
        bits.push(`ISA ${o.isa ? esc(o.isa) : '<span class="pg-flag pg-warn">none</span>'}`);
        if (o.bol !== null) bits.push(`BOL ${o.bol ? esc(o.bol) : '<span class="pg-flag pg-warn">none</span>'}`);
        if (o.carrier) bits.push(`Carrier ${esc(o.carrier)}`);
        if (o.vrids && o.vrids.length) bits.push(`VRID ${esc(o.vrids.join(", "))}`);
        if (o.pallets) bits.push(`${esc(o.pallets)} plt`);
        return `<div class="pg-smc-details">${bits.join(" · ")}</div>`;
      })
      .join("");
  }

  // Alignment flags from the background (BOL = PO, origin site, ISA present).
  function renderSmcChecks(r) {
    const hit = smcFor(r);
    if (!smc || !hit) return "";
    const flags = hit.orders.flatMap((o) => o.checks || []);
    if (!flags.length) return `<span class="pg-flag pg-ok">✓ SMC aligned</span>`;
    return (
      `<div class="pg-flags">` +
      flags.map((f) => `<span class="pg-flag pg-${f.level}">• ${esc(f.msg)}</span>`).join("") +
      `</div>`
    );
  }

  function renderFlags(r) {
    const flags = (r.flags || []).slice();
    const dnode = destNodeOf(r);
    if (isIdc(dnode)) flags.push({ level: "idc", msg: `IDC site (${esc(dnode)})` });
    if (!flags.length) return `<span class="pg-flag pg-ok">✓ No issues</span>`;
    return (
      `<div class="pg-flags">` +
      flags.map((f) => `<span class="pg-flag pg-${f.level}">• ${esc(f.msg)}</span>`).join("") +
      `</div>`
    );
  }

  // A one-line admin notice ("new version out", etc.) shown while enabled.
  function renderControlBanner() {
    const el = $("#pg-notice", root);
    if (!el) return;
    const notice = controlState && controlState.verdict && controlState.verdict.notice;
    if (notice) {
      el.textContent = notice;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  // ── rendering ───────────────────────────────────────────────────────────────
  function setStatus(html, kind) {
    const s = $("#pg-status", root);
    s.className = "pg-status" + (kind ? " pg-" + kind : "");
    s.innerHTML = html;
  }

  // Text a row exposes to the filter (all the columns a user would search).
  function rowHaystack(r) {
    return [
      r.po, r.loadId, r.site, siteName(r), r.status, r.originCity, r.destAddress,
      r.destNode, r.crdd, r.poWindow, windowPP(r), destPP(r), r.smcOrderIds,
      r.smcExecution, r.smcOrigin, r.smcCarrier, r.smcVrid, r.smcBol, r.idc,
      r.customerName, r.shipmentId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function visibleRows() {
    let rows = newOnly && smc ? lastRows.filter(isNew) : lastRows;
    if (hideIdc) rows = rows.filter((r) => !isIdc(destNodeOf(r)));
    if (filterTerms.length) {
      // OR across terms: paste several IDs (space/comma-separated) and see every
      // row matching ANY of them.
      rows = rows.filter((r) => {
        const hay = rowHaystack(r);
        return filterTerms.some((t) => hay.includes(t));
      });
    }
    return rows;
  }

  function renderTable() {
    const out = $("#pg-results", root);
    const rows = visibleRows();
    if (!rows.length) {
      out.innerHTML = lastRows.length
        ? `<div class="pg-empty">No new loads — every Load ID on the list already has an SMC order.</div>`
        : "";
      return;
    }
    const cols = VIEW_COLUMNS.filter((c) => !c.onlyAfterCheck || smc);
    const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
    const body = rows
      .map((r) => {
        const tds = cols.map((c) => {
          const val = c.render ? c.render(r) : esc(r[c.key] ?? "");
          return `<td>${val}</td>`;
        }).join("");
        return `<tr class="${isNew(r) ? "pg-row-new" : ""}">${tds}</tr>`;
      })
      .join("");
    out.innerHTML = `<table class="pg-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    out.querySelectorAll(".pg-site-btn").forEach((b) => b.addEventListener("click", () => openSite(b.dataset.site)));
    out.querySelectorAll(".pg-prepare").forEach((b) =>
      b.addEventListener("click", () => {
        const r = lastRows.find((x) => x.loadId === b.dataset.load);
        if (r) openPrepare(r);
      })
    );
  }

  // ── "Prepare SMC order" → "Create draft in SMC" ─────────────────────────────
  // The background resolves stops through SMC's own location search, converts
  // the site-local times to UTC and builds the exact createV3 payload the SMC
  // form sends (see background/draft.js). The panel shows the result, lets the
  // user edit times / price, and only then POSTs it as a DRAFT — which the user
  // reviews and submits inside SMC.
  const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const timeOf = (iso) => (iso && String(iso).length >= 16 ? String(iso).slice(11, 16) : "");

  async function openPrepare(r) {
    const site = siteFor(r.site);
    const siteKey = cfg.siteCodes[r.site] || "";
    const d = cfg.smcOrderDefaults || {};
    const lastPrice = (settings.prices || {})[siteKey];
    // Delivery anchors to the PO window (PP) end = Latest Vendor Delivery Date;
    // else the TMS delivery window. Pickup is then derived from transit time
    // once we fetch it (pickup end = delivery − T, 2-hour pickup window).
    const po = poFor(r);
    const poEndDate = po && po.found ? dateOf(po.windowEnd) : "";
    const poEndTime = po && po.found ? timeOf(po.windowEnd) : "";
    const pickupDate = dateOf(r.crddIso) || new Date().toISOString().slice(0, 10);
    const deliveryDate = poEndDate || dateOf(r.deliveryFromIso) || pickupDate;
    const deliveryTimeDefault = (poEndTime && poEndTime !== "00:00" ? poEndTime : "") || d.deliveryTime || "12:00";
    const inputsHtml = `
      <table class="pg-kv">
        <tr><th>Shipper reference</th><td><b>${esc(r.loadId)}</b> <span class="pg-muted pg-small">Load ID</span></td></tr>
        <tr><th>BOL = PO</th><td><b>${esc(r.po)}</b></td></tr>
        <tr><th>Pickup site</th><td><b>${esc(siteName(r))}</b> <span class="pg-muted pg-small">${
          site && site.smcPickup ? "SMC location “" + esc(site.smcPickup) + "”" : "no SMC location name configured for this site"
        }</span></td></tr>
        <tr><th>Delivery</th><td><b>${esc(destNodeOf(r) || r.destNode || "?")}</b>${isIdc(destNodeOf(r)) ? ' <span class="pg-flag pg-idc">IDC</span>' : ""} <span class="pg-muted pg-small">from “${esc(r.destAddress)}”</span></td></tr>
        <tr><th>Pallets / weight</th><td><b>${esc(r.smcPallets || 0)}</b> ${esc(d.palletType || "")} · <b>${esc(r.weight === "" ? 0 : r.weight)}</b> kg</td></tr>
        <tr><th>PO window</th><td>${esc(r.poWindow || "—")}</td></tr>
      </table>
      <h4>Times (site local)</h4>
      <div class="pg-grid2">
        <label class="pg-field">Delivery date<input type="date" id="pg-d-ddate" value="${esc(deliveryDate)}"></label>
        <label class="pg-field">Delivery time<input type="time" id="pg-d-dtime" value="${esc(deliveryTimeDefault)}"></label>
        <label class="pg-field">Pickup date<input type="date" id="pg-d-pdate" value="${esc(pickupDate)}"></label>
        <label class="pg-field">Pickup from<input type="time" id="pg-d-pfrom" value="07:00"></label>
        <label class="pg-field">Pickup to (<span class="pg-muted">+2h, auto</span>)<input type="time" id="pg-d-pto" value="09:00" readonly></label>
        <label class="pg-field">Shipper price (${esc((site && site.currency) || "EUR")})<input type="number" id="pg-d-price" min="0" step="1" value="${esc(lastPrice || "")}" placeholder="LINE_HAUL"></label>
      </div>
      <div id="pg-d-transit" class="pg-small pg-muted">Transit time: …</div>
      <div class="pg-panel-actions">
        <button type="button" id="pg-d-preview">Preview</button>
        <button type="button" id="pg-d-create" class="pg-primary" disabled>Create draft in SMC</button>
        <button type="button" id="pg-d-copy" disabled>Copy payload</button>
      </div>
      <div id="pg-d-out" class="pg-small"></div>`;
    showPanel(`SMC draft · ${r.loadId}`, inputsHtml);

    let prepared = null;
    let chosenNode = ""; // set when the user picks a destination node
    const out = () => $("#pg-d-out", root);
    const readInputs = () => ({
      loadId: r.loadId,
      po: r.po,
      site: r.site,
      weight: r.weight === "" ? 0 : r.weight,
      pallets: r.smcPallets || 0,
      destNode: chosenNode || r.destNode,
      destNodePicked: !!chosenNode,
      destPostcode: r.destPostcode,
      destCity: r.destCity,
      destAddress: r.destAddress,
      pickupDate: $("#pg-d-pdate", root).value,
      pickupFrom: $("#pg-d-pfrom", root).value,
      pickupTo: $("#pg-d-pto", root).value,
      deliveryDate: $("#pg-d-ddate", root).value,
      deliveryTime: $("#pg-d-dtime", root).value,
      price: $("#pg-d-price", root).value,
      currency: (site && site.currency) || "EUR",
    });

    const renderPrepared = (p) => {
      const R = p.resolved;
      const addr = (l) => esc([l.addressLine, l.postalCode, l.city, l.country].filter(Boolean).join(", "));
      const w = p.warnings.length
        ? `<ul class="pg-warnlist">${p.warnings.map((x) => `<li class="pg-flag pg-warn">${esc(x)}</li>`).join("")}</ul>`
        : `<div class="pg-flag pg-ok">✓ Nothing to flag.</div>`;
      return `
        <h4>Resolved</h4>
        <div><b>Pickup</b> ${esc(R.pickup.locationName)} <span class="pg-muted">(${esc(R.pickup.nodeCode)}, address ${esc(R.pickup.addressUsed.addressId)} · ${esc(R.pickup.addressUsed.used)})</span><br>${addr(R.pickup)}<br>${esc(fmtTime(R.pickup.start, R.pickup.tz))} → ${esc(fmtTime(R.pickup.end, R.pickup.tz))} <span class="pg-muted">${esc(R.pickup.tz)}</span></div>
        <div style="margin-top:6px"><b>Delivery</b> ${esc(R.delivery.locationName)}${isIdc(R.destNode) ? ' <span class="pg-flag pg-idc">IDC</span>' : ""} <span class="pg-muted">(${esc(R.delivery.locationType)}, address ${esc(R.delivery.addressUsed.addressId)} · ${esc(R.delivery.addressUsed.used)}${R.destResolvedBy === "po" ? " · from the PO" : R.destResolvedBy === "lane" ? " · matched from the address via lanes" : R.destResolvedBy === "manual" ? " · you picked this" : ""})</span>${R.destResolvedBy === "po" ? ' <span class="pg-pp">PP</span>' : ""}<br>${addr(R.delivery)}<br>${esc(fmtTime(R.delivery.at, R.delivery.tz))} <span class="pg-muted">${esc(R.delivery.tz)}</span></div>
        <div style="margin-top:6px">${esc(R.pallets)} ${esc(d.palletType || "")} · ${esc(R.weight)} kg · ${esc(R.distance.value)} ${esc(R.distance.unit)} · ${R.price ? esc(R.price.value + " " + R.price.currency) + (R.price.fromLane ? " <span class=\"pg-muted\">(lane rate)</span>" : "") : '<span class="pg-flag pg-warn">no price</span>'} · ${esc(d.equipmentType || "")}</div>
        ${R.lane ? `<div class="pg-muted pg-small">Contracted lane ${esc(R.lane.key)} — ${esc(R.lane.price)} ${esc(R.lane.currency)}${R.lane.validTo ? ", valid to " + esc(R.lane.validTo) : ""}</div>` : `<div class="pg-flag pg-warn">Not on a contracted lane</div>`}
        ${
          R.po
            ? `<div class="pg-small" style="margin-top:6px"><b>Procurement Portal (PP)</b> PO ${esc(R.po.poId)} · FC <b>${esc(R.po.fcId || "?")}</b> <span class="pg-pp">PP</span> · window ${esc((R.po.windowStart || "").slice(0, 10))} → ${esc((R.po.windowEnd || "").slice(0, 10))} <span class="pg-pp">PP</span> <span class="pg-muted">(Latest Vendor Delivery ${esc((R.po.windowEnd || "").slice(0, 10))})</span></div>`
            : `<div class="pg-small pg-muted" style="margin-top:6px">No Procurement Portal PO matched — destination/window from TMS.</div>`
        }
        <h4>Checks</h4>${w}
        <p class="pg-muted pg-small">Creating makes a <b>DRAFT</b> in SMC under shipper ${esc(settings.shipperIds[0] || "?")}. Review and submit it in SMC.</p>`;
    };

    const doPreview = async () => {
      prepared = null;
      $("#pg-d-create", root).disabled = true;
      $("#pg-d-copy", root).disabled = true;
      out().innerHTML = `<span class="pg-muted">Resolving stops in SMC…</span>`;
      try {
        prepared = await call("smcPrepareDraft", { input: readInputs() });
        out().innerHTML = renderPrepared(prepared);
        $("#pg-d-create", root).disabled = false;
        $("#pg-d-copy", root).disabled = false;
      } catch (e) {
        if (e.pickNode && e.candidates && e.candidates.length) {
          const opts = e.candidates
            .map((c) => `<option value="${esc(c.node)}">${esc(c.node)} — ${esc(c.city || "?")}${c.postcode ? " " + esc(c.postcode) : ""}${c.price ? " · " + esc(c.price) + " EUR" : ""}</option>`)
            .join("");
          out().innerHTML =
            `<div class="pg-flag pg-warn">${esc(e.message)}</div>` +
            `<label class="pg-field">Delivery node<select id="pg-d-node"><option value="">— pick —</option>${opts}</select></label>`;
          $("#pg-d-node", root).addEventListener("change", (ev) => {
            chosenNode = ev.target.value;
            if (chosenNode) doPreview();
          });
          return;
        }
        out().innerHTML = `<span class="pg-flag pg-error">${esc(e.message)}</span>` +
          (e.expired ? ` <a class="pg-link" href="${esc(cfg.smcTabUrl)}" target="_blank" rel="noopener">Open SMC to sign in</a>` : "");
      }
    };

    const doCreate = async () => {
      if (!prepared) return;
      const btn = $("#pg-d-create", root);
      btn.disabled = true;
      btn.textContent = "Creating…";
      try {
        const res = await call("smcCreateDraft", {
          payload: prepared.payload,
          siteKey: prepared.resolved.siteKey,
          price: prepared.resolved.price ? prepared.resolved.price.value : 0,
        });
        settings = await call("getSettings").catch(() => settings);
        const link = res.orderId
          ? `<a class="pg-link" href="${esc(cfg.smcOrderUrl.replace("__ID__", encodeURIComponent(res.orderId)))}" target="_blank" rel="noopener">Open draft ${esc(res.orderId)} in SMC ↗</a>`
          : `<span class="pg-muted">SMC did not return an order id — check your drafts in SMC.</span>`;
        out().innerHTML = `<div class="pg-flag pg-ok">✓ Draft created for Load ID ${esc(r.loadId)}.</div><div style="margin-top:6px">${link}</div>` +
          (res.response && !res.orderId ? `<pre class="pg-pre">${esc(JSON.stringify(res.response, null, 1).slice(0, 1500))}</pre>` : "");
        btn.textContent = "Created";
        setStatus(`Draft created in SMC for Load ID <b>${esc(r.loadId)}</b>${res.orderId ? " (order " + esc(res.orderId) + ")" : ""}. Re-running the SMC check…`, "ok");
        doSmcCheck();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Create draft in SMC";
        out().innerHTML += `<div class="pg-flag pg-error" style="margin-top:8px">Create failed: ${esc(e.message)}</div>`;
      }
    };

    // ── transit-time alignment ───────────────────────────────────────────────
    // Delivery anchors to the PO window; pickup must satisfy
    //   delivery == pickup_end + transit   (±2h)
    // Pickup window is fixed at 2h (pickup_to = pickup_from + 2h). Any edit to
    // pickup/delivery re-fetches transit (cached per node pair) and re-checks;
    // misaligned → transit line red + Create disabled.
    const TOL_MS = 2 * 3600_000;
    let transitSecs = null; // cached transit for the current node pair
    let transitKey = ""; // "<origin>-><dest>" the cache is for
    let aligned = true;

    const el = (id) => $("#" + id, root);
    const localMs = (dateVal, timeVal) => {
      // Interpret the date+time inputs as a wall clock (comparison only; both
      // sides use the same frame, so the absolute zone doesn't matter here).
      if (!dateVal || !timeVal) return NaN;
      const [y, m, dd] = dateVal.split("-").map(Number);
      const [hh, mi] = timeVal.split(":").map(Number);
      return Date.UTC(y, (m || 1) - 1, dd || 1, hh || 0, mi || 0);
    };
    const addToTime = (timeVal, hours) => {
      const [hh, mi] = String(timeVal || "0:0").split(":").map(Number);
      const t = ((hh || 0) * 60 + (mi || 0) + hours * 60 + 1440) % 1440;
      return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    };

    // Keep pickup-to = pickup-from + 2h (always a 2-hour window).
    const syncPickupWindow = () => {
      el("pg-d-pto").value = addToTime(el("pg-d-pfrom").value, 2);
    };

    async function ensureTransit() {
      const origin = (site && site.smcPickupCode) || (site && site.smcPickup) || "";
      const dest = (chosenNode || destNodeOf(r) || r.destNode || "").toUpperCase();
      if (!origin || !dest) return null;
      const key = `${origin}->${dest}`;
      if (key === transitKey && transitSecs != null) return transitSecs;
      $("#pg-d-transit", root).className = "pg-small pg-muted";
      $("#pg-d-transit", root).textContent = "Transit time: …";
      try {
        const res = await call("smcTransit", { originCode: origin, destCode: dest });
        transitSecs = res && res.seconds != null ? res.seconds : null;
        transitKey = key;
      } catch (e) {
        transitSecs = null;
        transitKey = "";
      }
      return transitSecs;
    }

    const fmtDur = (secs) => {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return m ? `${h}h ${m}m` : `${h}h`;
    };

    // Compare pickup_end + T against delivery; paint the transit line; gate Create.
    function checkAlignment() {
      const t = $("#pg-d-transit", root);
      if (transitSecs == null) {
        t.className = "pg-small pg-warn";
        t.textContent = "Transit time unavailable (SMC) — alignment not enforced.";
        aligned = true; // don't block when SMC can't tell us
        return;
      }
      const pickEndMs = localMs(el("pg-d-pdate").value, el("pg-d-pto").value);
      const delMs = localMs(el("pg-d-ddate").value, el("pg-d-dtime").value);
      if (Number.isNaN(pickEndMs) || Number.isNaN(delMs)) {
        aligned = false;
        t.className = "pg-small pg-err-txt";
        t.textContent = "Enter pickup and delivery times.";
        return;
      }
      const expectedDel = pickEndMs + transitSecs * 1000;
      const diffMs = delMs - expectedDel;
      const suggestedPickEnd = new Date(delMs - transitSecs * 1000);
      const sp = (n) => String(n).padStart(2, "0");
      const suggestStr = `${sp(suggestedPickEnd.getUTCHours())}:${sp(suggestedPickEnd.getUTCMinutes())} on ${sp(suggestedPickEnd.getUTCDate())}/${sp(suggestedPickEnd.getUTCMonth() + 1)}`;
      aligned = Math.abs(diffMs) <= TOL_MS;
      if (aligned) {
        t.className = "pg-small pg-ok-txt";
        t.textContent = `Transit ${fmtDur(transitSecs)} · pickup end + transit = delivery ✓ (within ±2h)`;
      } else {
        const off = Math.round(Math.abs(diffMs) / 3600_000 * 10) / 10;
        t.className = "pg-small pg-err-txt";
        t.innerHTML = `Transit ${esc(fmtDur(transitSecs))} · misaligned by ${esc(off)}h — pickup end should be about <b>${esc(suggestStr)}</b> for a delivery of ${esc(el("pg-d-dtime").value)}. ` +
          `<button type="button" class="pg-link" id="pg-d-snap">Snap pickup to suggested</button>`;
        const snap = $("#pg-d-snap", root);
        if (snap) snap.addEventListener("click", () => {
          el("pg-d-pdate").value = `${suggestedPickEnd.getUTCFullYear()}-${sp(suggestedPickEnd.getUTCMonth() + 1)}-${sp(suggestedPickEnd.getUTCDate())}`;
          el("pg-d-pfrom").value = addToTime(`${sp(suggestedPickEnd.getUTCHours())}:${sp(suggestedPickEnd.getUTCMinutes())}`, -2);
          syncPickupWindow();
          onEdit();
        });
      }
    }

    // Set the delivery → derive pickup end = delivery − T, pickup window 2h.
    function alignPickupToDelivery() {
      if (transitSecs == null) return;
      const delMs = localMs(el("pg-d-ddate").value, el("pg-d-dtime").value);
      if (Number.isNaN(delMs)) return;
      const pickEnd = new Date(delMs - transitSecs * 1000);
      const sp = (n) => String(n).padStart(2, "0");
      el("pg-d-pdate").value = `${pickEnd.getUTCFullYear()}-${sp(pickEnd.getUTCMonth() + 1)}-${sp(pickEnd.getUTCDate())}`;
      const endHHMM = `${sp(pickEnd.getUTCHours())}:${sp(pickEnd.getUTCMinutes())}`;
      el("pg-d-pfrom").value = addToTime(endHHMM, -2); // from = end − 2h
      syncPickupWindow();
    }

    function refreshCreateEnabled() {
      // Create requires a successful Preview AND alignment.
      $("#pg-d-create", root).disabled = !prepared || !aligned;
    }

    // Any change invalidates the preview and re-checks alignment.
    const onEdit = async () => {
      prepared = null;
      $("#pg-d-create", root).disabled = true;
      out().innerHTML = `<span class="pg-muted">Inputs changed — click Preview to rebuild.</span>`;
      syncPickupWindow();
      await ensureTransit();
      checkAlignment();
      refreshCreateEnabled();
    };

    const doPreviewGated = async () => {
      await ensureTransit();
      checkAlignment();
      if (!aligned) {
        out().innerHTML = `<div class="pg-flag pg-error">Pickup and delivery aren't aligned to the transit time — fix the times above (or Snap) before previewing.</div>`;
        $("#pg-d-create", root).disabled = true;
        return;
      }
      await doPreview();
      refreshCreateEnabled();
    };

    $("#pg-d-preview", root).addEventListener("click", doPreviewGated);
    $("#pg-d-create", root).addEventListener("click", doCreate);
    $("#pg-d-copy", root).addEventListener("click", () => {
      if (prepared) copyText(JSON.stringify(prepared.payload, null, 2), "Copied the createV3 payload (JSON).");
    });
    // Editing delivery re-anchors pickup; editing pickup just re-checks.
    for (const id of ["pg-d-ddate", "pg-d-dtime"]) {
      el(id).addEventListener("change", async () => {
        await ensureTransit();
        alignPickupToDelivery();
        onEdit();
      });
    }
    for (const id of ["pg-d-pdate", "pg-d-pfrom"]) {
      el(id).addEventListener("change", onEdit);
    }
    el("pg-d-price").addEventListener("change", () => {
      prepared = null;
      $("#pg-d-create", root).disabled = true;
      out().innerHTML = `<span class="pg-muted">Price changed — click Preview to rebuild.</span>`;
    });

    // Initial: fetch transit, align pickup to the PO-window delivery, check.
    (async () => {
      await ensureTransit();
      alignPickupToDelivery();
      checkAlignment();
      await doPreview();
      refreshCreateEnabled();
    })();
  }

  function setButtons() {
    const none = lastRows.length === 0;
    $("#pg-btn-copy", root).disabled = none;
    $("#pg-btn-csv", root).disabled = none;
    $("#pg-btn-smc", root).disabled = none;
    $("#pg-btn-new", root).disabled = !smc || !smc.unmatched.length;
    const chk = $("#pg-new-only", root);
    chk.disabled = !smc;
    chk.checked = newOnly && !!smc;
    const idcChk = $("#pg-idc-hide", root);
    idcChk.disabled = none;
    idcChk.checked = hideIdc;
  }

  function summary() {
    const n = lastRows.length;
    const issues = lastRows.filter((r) => (r.flags || []).some((f) => f.level === "error")).length;
    let html = `<b>${n}</b> load(s) read from the list.`;
    if (issues) html += ` <span class="pg-flag pg-error">${issues} with window issues.</span>`;
    if (extractMeta.mapping === "positional") {
      html += ` <span class="pg-flag pg-warn" title="The header row wasn't recognised, so columns were read by position; Weight and other newer columns are unavailable.">Columns read by position — Weight unavailable.</span>`;
    } else if (extractMeta.missing.includes("weight")) {
      html += ` <span class="pg-flag pg-warn">Shipment Weight is not a column on this list — add it via List Customization.</span>`;
    }
    if (smc) {
      const nNew = smc.unmatched.length;
      const misaligned = lastRows.filter((r) => {
        const hit = smcFor(r);
        return hit && hit.orders.some((o) => (o.checks || []).some((f) => f.level === "error"));
      }).length;
      html += ` SMC check: <b class="${nNew ? "pg-new-txt" : ""}">${nNew} new</b>`;
      if (nNew) {
        // Per-site breakdown of the new loads — what goes on the task sheet.
        const bySite = new Map();
        for (const r of lastRows.filter(isNew)) {
          const k = siteName(r) || "?";
          bySite.set(k, (bySite.get(k) || 0) + 1);
        }
        const parts = [...bySite.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${esc(k)}`);
        html += ` <span class="pg-muted">(${parts.join(", ")})</span>`;
      }
      html += `, ${n - nNew} already in SMC`;
      if (misaligned) html += `, <span class="pg-flag pg-error">${misaligned} misaligned with SMC</span>`;
      if (smc.detailEndpoint === null && smc.detailNeeded) {
        html += ` <span class="pg-flag pg-warn">BOL could not be read from SMC (no detail endpoint answered)</span>`;
      }
      html += ` <span class="pg-muted pg-small">(${smc.smcOrders} SMC order(s) in window${smc.truncated ? ", TRUNCATED — widen the pad" : ""})</span>`;
    }
    if (accessMissing.some((o) => /smc-eu-dub/.test(o))) {
      html += ` <span class="pg-flag pg-warn">SMC site access not granted — click the P&amp;G TMS Viewer toolbar icon and accept the prompt before Check.</span>`;
    }
    if (configError) {
      html += ` <span class="pg-flag pg-error">Background unreachable: ${esc(configError)}</span>`;
    }
    const vis = visibleRows().length;
    if (vis !== n) {
      const bits = [];
      if (newOnly) bits.push("new only");
      if (hideIdc) bits.push("IDC hidden");
      if (filterTerms.length) bits.push(`filter: ${esc(filterTerms.join(" "))}`);
      html += ` <span class="pg-muted">· showing ${vis} of ${n}${bits.length ? " (" + bits.join(", ") + ")" : ""}</span>`;
    }
    return html;
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  function doExtract() {
    const api = window.__pgTms;
    smc = null; // the list changed → the check is stale
    newOnly = false;
    hideIdc = false;
    if (!api || !hasTable()) {
      lastRows = [];
      renderTable();
      setButtons();
      setStatus("The Shipment Leg list is not on this page any more. Run a search in TMS and refresh.", "error");
      return;
    }
    const data = api.extract();
    lastRows = data.rows || [];
    extractMeta = { mapping: data.mapping || "positional", missing: data.missingColumns || [] };
    for (const r of lastRows) {
      r.siteName = siteName(r);
      r.idc = isIdc(destNodeOf(r)) ? "IDC" : "";
    }
    renderTable();
    setButtons();
    if (!lastRows.length) {
      setStatus("The Shipment Leg list has no rows.", "ok");
      return;
    }
    setStatus(summary(), lastRows.some((r) => (r.flags || []).some((f) => f.level === "error")) ? "" : "ok");
  }

  async function doSmcCheck() {
    if (!lastRows.length) return;
    if (!settings.shipperIds.length) {
      setStatus("Enter the P&G SMC shipper ID(s) in Settings before checking SMC.", "error");
      openSettings();
      return;
    }
    const btn = $("#pg-btn-smc", root);
    btn.disabled = true;
    setStatus(`Checking ${lastRows.length} Load ID(s) against SMC…`);
    try {
      const loads = lastRows.map((r) => ({ loadId: r.loadId, crddIso: r.crddIso, po: r.po, site: r.site }));
      const res = await call("smcCheck", { loads }, 120_000);
      const matches = res.matches || {};
      smc = {
        po: {}, // load.loadId → PO record (Procurement Portal), filled below
        matches,
        unmatched: res.unmatched || [],
        smcOrders: res.smcOrders || 0,
        truncated: !!(res.meta && res.meta.truncated),
        window: res.window,
        detailEndpoint: res.detailEndpoint === undefined ? null : res.detailEndpoint,
        // true when at least one matched order still has an unknown BOL
        detailNeeded: Object.values(matches).some((m) => m.orders.some((o) => o.bol === null)),
        at: new Date(),
      };
      // The new loads are what the user came for: show only them by default
      // (they can untick "New only" to see the matched rows and their checks).
      newOnly = smc.unmatched.length > 0;
      for (const r of lastRows) {
        const hit = smcFor(r);
        const orders = hit ? hit.orders : [];
        r.smcState = !r.loadId ? "" : hit ? "yes" : "NEW";
        r.smcOrderIds = orders.map((o) => o.orderid).join(" ");
        r.smcExecution = orders.map((o) => o.order_status || o.execution_status || "").join(" ");
        r.smcOrigin = orders.map((o) => o.origin || o.origin_code || "").join(" ");
        r.smcPickup = orders.map((o) => fmtTime(o.pickup_time, o.pickup_tz)).join(" ");
        r.smcIsa = orders.map((o) => o.isa || "").join(" ");
        r.smcBol = orders.map((o) => (o.bol === null ? "n/a" : o.bol || "")).join(" ");
        r.smcCarrier = orders.map((o) => o.carrier || "").join(" ");
        r.smcVrid = orders.flatMap((o) => o.vrids || []).join(" ");
        r.smcChecks = orders
          .flatMap((o) => o.checks || [])
          .filter((f) => f.level !== "info")
          .map((f) => f.msg)
          .join("; ");
      }
      renderTable();
      setStatus(summary(), smc.truncated ? "error" : "ok");

      // Procurement Portal cross-check — NEW rows only (be very sure of the
      // destination FC + PO window before creating). Best-effort: a portal
      // failure just leaves those rows on their TMS destination/window.
      const newLoads = lastRows.filter(isNew);
      const poIds = [...new Set(newLoads.map((r) => r.po).filter(Boolean))];
      if (poIds.length) {
        setStatus(summary() + ` <span class="pg-muted pg-small">· checking ${poIds.length} PO(s) in the portal…</span>`, "ok");
        try {
          const pos = await call("poLookup", { poIds }, 120_000);
          for (const r of newLoads) {
            const p = pos[r.po] || pos[String(r.po).toUpperCase()];
            if (p) smc.po[r.loadId] = p;
          }
          // Flatten for CSV/filter (windowPP/destPP read smc.po) and refresh
          // IDC now that the PO may have given a node for street-address rows.
          for (const r of lastRows) {
            r.poWindowPP = windowPP(r);
            r.destinationPP = destPP(r);
            r.idc = isIdc(destNodeOf(r)) ? "IDC" : "";
          }
          renderTable();
          setStatus(summary(), "ok");
        } catch (e) {
          // Portal down/expired — keep the SMC result, just note it.
          const note = e.expired
            ? `Portal not checked (session expired) — Destination/PO Window are from TMS. <a class="pg-link" href="${esc(cfg.portalTabUrl || "https://procurementportal-eu.corp.amazon.com/")}" target="_blank" rel="noopener">Open the portal</a>`
            : `Portal not checked (${esc(e.message)}) — Destination/PO Window are from TMS.`;
          setStatus(summary() + ` <span class="pg-flag pg-warn">${note}</span>`, "");
        }
      }
    } catch (e) {
      let html = esc(e.message);
      if (e.expired) {
        html += ` <a class="pg-link" href="${esc(cfg.smcTabUrl)}" target="_blank" rel="noopener">Open SMC to sign in</a>, then retry.`;
      } else if (e.config) {
        openSettings();
      } else if (e.permission) {
        loadConfig(); // refresh the access hint
      }
      setStatus(html, "error");
    } finally {
      setButtons();
    }
  }

  function toDelimited(rows, columns, delim) {
    const q =
      delim === ","
        ? (v) => {
            const s = String(v == null ? "" : v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          }
        : (v) => String(v == null ? "" : v).replace(/[\t\n]/g, " ");
    const header = columns.map(([, label]) => q(label)).join(delim);
    const lines = rows.map((r) => columns.map(([key]) => q(r[key])).join(delim));
    return [header, ...lines].join(delim === "," ? "\r\n" : "\n");
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMsg, "ok");
    } catch (e) {
      setStatus("Copy failed: " + esc(e.message), "error");
    }
  }

  const doCopy = () =>
    copyText(
      toDelimited(visibleRows(), CSV_COLUMNS, "\t"),
      `Copied ${visibleRows().length} row(s) to the clipboard (tab-separated — paste into Excel).`
    );

  function doCopyNew() {
    if (!smc) return;
    const rows = lastRows.filter(isNew);
    copyText(
      toDelimited(rows, TASK_COLUMNS, "\t"),
      `Copied ${rows.length} NEW load(s) (Load ID, PO, site, CRDD, window, pallets, weight) for the daily task sheet.`
    );
  }

  function doCsv() {
    const blob = new Blob([toDelimited(visibleRows(), CSV_COLUMNS, ",")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `pg-tms-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── side panel (site rules / settings) ──────────────────────────────────────
  function showPanel(title, bodyHtml) {
    const p = $("#pg-panel", root);
    $("#pg-panel-title", root).textContent = title;
    $("#pg-panel-body", root).innerHTML = bodyHtml;
    p.classList.add("pg-panel-open");
  }
  function hidePanel() {
    $("#pg-panel", root).classList.remove("pg-panel-open");
  }

  function openSite(code) {
    const site = siteFor(code);
    if (!site) {
      showPanel(
        `Site ${code || "?"}`,
        `<p>No rules configured for Origin Location ID <b>${esc(code)}</b>.</p>
         <p class="pg-muted">Add it to <code>Config.SITE_CODES</code> / <code>Config.SITES</code> in <code>config.js</code> once you know which P&G site it is.</p>`
      );
      return;
    }
    const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const mailto = (c) =>
      /@/.test(c) ? `<a class="pg-link" href="mailto:${esc(c)}">${esc(c)}</a>` : esc(c);
    showPanel(
      `${site.name} · ${code}`,
      `<h4>Docks</h4><p>${esc(site.docks || "—")}</p>` +
        (site.equipment ? `<h4>Equipment</h4><p>${esc(site.equipment)}</p>` : "") +
        `<h4>Contacts</h4><ul>${(site.contacts || []).map((c) => `<li>${mailto(c)}</li>`).join("")}</ul>` +
        `<h4>SOP notes</h4><ul>${li(site.notes)}</ul>` +
        `<p class="pg-muted pg-small">Always: BOL = PO, CRDD inside the PO window, edit the ISA (never cancel), one active ISA per PO.</p>`
    );
  }

  function controlLine() {
    if (!controlState) return "";
    const v = controlState.verdict || {};
    const state = v.allowed === false ? `<span class="pg-flag pg-error">disabled — ${esc(v.message || v.reason || "")}</span>` : `<span class="pg-ok-txt">active</span>`;
    return `<div class="pg-small pg-muted" style="margin-bottom:10px">Identity: <b>${esc(controlState.alias || "unknown")}</b> · install <code>${esc(controlState.installId || "?")}</code> · v${esc(browser.runtime.getManifest().version)} · ${state}</div>`;
  }

  function openSettings() {
    showPanel(
      "Settings",
      controlLine() +
      `<label class="pg-field">P&amp;G shipper ID(s) in SMC
         <textarea id="pg-set-shippers" rows="3" placeholder="one per line or comma-separated">${esc(
           settings.shipperIds.join("\n")
         )}</textarea>
         <span class="pg-muted pg-small">Required for the SMC check. Find it on any P&amp;G order in SMC (shipper account ID).</span>
       </label>
       <label class="pg-field">Search window padding (days)
         <input id="pg-set-pad" type="number" min="0" max="30" value="${esc(settings.windowPadDays)}">
         <span class="pg-muted pg-small">SMC is searched from the earliest CRDD minus this to the latest CRDD plus this.</span>
       </label>
       <div class="pg-panel-actions">
         <button type="button" id="pg-set-save" class="pg-primary">Save</button>
         <button type="button" id="pg-set-ping">Test SMC session</button>
       </div>
       <div id="pg-set-msg" class="pg-small"></div>

       <details class="pg-details">
         <summary>Custom lanes</summary>
         <p class="pg-small pg-muted">Extra contracted lanes on top of the built-in list. Used for the draft price/equipment and the lane checks. Origin/destination are SMC location codes (e.g. <code>BIG_BOX_80000_398</code> → <code>CDG7</code>).</p>
         <div id="pg-lane-list" class="pg-small"></div>
         <div class="pg-grid2">
           <label class="pg-field">Origin code<input id="pg-lane-origin" placeholder="PROCTER__53881_118"></label>
           <label class="pg-field">Destination code<input id="pg-lane-dest" placeholder="CDG7"></label>
           <label class="pg-field">Price<input id="pg-lane-price" type="number" min="0" step="1"></label>
           <label class="pg-field">Currency<input id="pg-lane-cur" value="EUR"></label>
           <label class="pg-field">Valid from<input id="pg-lane-from" type="date"></label>
           <label class="pg-field">Valid to<input id="pg-lane-to" type="date"></label>
         </div>
         <div class="pg-panel-actions">
           <button type="button" id="pg-lane-add" class="pg-primary">Add / update lane</button>
         </div>
         <div id="pg-lane-msg" class="pg-small pg-muted"></div>
       </details>

       <details class="pg-details">
         <summary>Record SMC requests (one-off, for building "Create draft")</summary>
         <p class="pg-small pg-muted">Turn this on, create ONE order draft by hand in SMC as you normally would, then come back and copy the capture. It records what the SMC page sends (URL + body) so the extension can learn how to create the draft itself. Stops by itself after 30 min.</p>
         <div class="pg-panel-actions">
           <button type="button" id="pg-rec-toggle">Start recording</button>
           <button type="button" id="pg-rec-copy" disabled>Copy capture</button>
           <button type="button" id="pg-rec-clear" disabled>Clear</button>
         </div>
         <div id="pg-rec-msg" class="pg-small pg-muted"></div>
       </details>`
    );
    wireRecorder();
    wireLanes();
    $("#pg-set-save", root).addEventListener("click", async () => {
      const msgEl = $("#pg-set-msg", root);
      try {
        settings = await call("saveSettings", {
          settings: {
            shipperIds: $("#pg-set-shippers", root).value,
            windowPadDays: $("#pg-set-pad", root).value,
          },
        });
        msgEl.textContent = `Saved: ${settings.shipperIds.length} shipper ID(s), pad ${settings.windowPadDays} day(s).`;
        msgEl.className = "pg-small pg-ok-txt";
      } catch (e) {
        msgEl.textContent = e.message;
        msgEl.className = "pg-small pg-err-txt";
      }
    });
    $("#pg-set-ping", root).addEventListener("click", async () => {
      const msgEl = $("#pg-set-msg", root);
      msgEl.textContent = "Checking SMC session…";
      msgEl.className = "pg-small";
      try {
        await call("smcPing");
        msgEl.textContent = "SMC session OK.";
        msgEl.className = "pg-small pg-ok-txt";
      } catch (e) {
        msgEl.textContent = e.message;
        msgEl.className = "pg-small pg-err-txt";
      }
    });
  }

  // ── custom-lane editor (Settings panel) ─────────────────────────────────────
  async function wireLanes() {
    const listEl = $("#pg-lane-list", root);
    const msg = $("#pg-lane-msg", root);
    if (!listEl) return;
    const refresh = async () => {
      try {
        const lanes = await call("lanesList");
        listEl.innerHTML = lanes.length
          ? `<table class="pg-lane-tbl">${lanes
              .map(
                (l) =>
                  `<tr><td><b>${esc(l.origin)}</b> → <b>${esc(l.dest)}</b></td><td>${esc(l.price ?? "—")} ${esc(l.currency || "")}</td><td>${esc(l.validTo || "")}</td><td><button type="button" class="pg-link pg-lane-del" data-key="${esc(l.key)}">remove</button></td></tr>`
              )
              .join("")}</table>`
          : `<span class="pg-muted">No custom lanes. The built-in list still applies.</span>`;
        listEl.querySelectorAll(".pg-lane-del").forEach((b) =>
          b.addEventListener("click", async () => {
            await call("lanesDelete", { key: b.dataset.key });
            refresh();
          })
        );
      } catch (e) {
        listEl.innerHTML = `<span class="pg-flag pg-error">${esc(e.message)}</span>`;
      }
    };
    $("#pg-lane-add", root).addEventListener("click", async () => {
      const lane = {
        origin: $("#pg-lane-origin", root).value.trim(),
        dest: $("#pg-lane-dest", root).value.trim(),
        price: $("#pg-lane-price", root).value,
        currency: $("#pg-lane-cur", root).value.trim() || "EUR",
        validFrom: $("#pg-lane-from", root).value || null,
        validTo: $("#pg-lane-to", root).value || null,
      };
      try {
        await call("lanesSave", { lane });
        msg.textContent = `Saved ${lane.origin} → ${lane.dest}.`;
        msg.className = "pg-small pg-ok-txt";
        $("#pg-lane-origin", root).value = "";
        $("#pg-lane-dest", root).value = "";
        $("#pg-lane-price", root).value = "";
        refresh();
      } catch (e) {
        msg.textContent = e.message;
        msg.className = "pg-small pg-err-txt";
      }
    });
    await refresh();
  }

  // ── SMC request recorder controls (Settings panel) ──────────────────────────
  async function wireRecorder() {
    const tgl = $("#pg-rec-toggle", root);
    const cpy = $("#pg-rec-copy", root);
    const clr = $("#pg-rec-clear", root);
    const msg = $("#pg-rec-msg", root);
    if (!tgl) return;
    const show = (st) => {
      tgl.textContent = st.on ? "Stop recording" : "Start recording";
      tgl.classList.toggle("pg-primary", !!st.on);
      cpy.disabled = clr.disabled = !st.count;
      msg.textContent = `${st.on ? "Recording…" : "Not recording."} ${st.count} request(s) captured.`;
    };
    const refresh = async () => {
      try {
        show(await call("recStatus"));
      } catch (e) {
        msg.textContent = e.message;
      }
    };
    tgl.addEventListener("click", async () => {
      try {
        const st = await call("recStatus");
        show(await call(st.on ? "recStop" : "recStart"));
      } catch (e) {
        msg.textContent = e.message;
      }
    });
    cpy.addEventListener("click", async () => {
      try {
        const { entries } = await call("recGet");
        const text = entries
          .map((e, i) => `#${i + 1} ${e.at} ${e.method} ${e.url} → ${e.status}${e.error ? " " + e.error : ""}\n${e.body || "(no body)"}`)
          .join("\n\n" + "─".repeat(60) + "\n\n");
        await navigator.clipboard.writeText(text);
        msg.textContent = `Copied ${entries.length} request(s) — paste them to Kiro.`;
      } catch (e) {
        msg.textContent = "Copy failed: " + e.message;
      }
    });
    clr.addEventListener("click", async () => {
      try {
        show(await call("recClear"));
      } catch (e) {
        msg.textContent = e.message;
      }
    });
    await refresh();
    // Keep the count live while the panel is open.
    const iv = setInterval(() => {
      if (!$("#pg-rec-toggle", root)) return clearInterval(iv);
      refresh();
    }, 3000);
  }

  // ── open / close ────────────────────────────────────────────────────────────
  function isOpen() {
    return !!root && root.style.display === "flex";
  }
  async function open() {
    if (!root) mount();
    root.style.display = "flex";
    try {
      setStatus("Reading the list…");
      await loadConfig();
      renderControlBanner();
      if (controlState && controlState.verdict && !controlState.verdict.allowed) {
        // Remotely disabled: show the message, don't read the list. Settings
        // stays reachable so the user can see their identity to report it.
        lastRows = [];
        renderTable();
        setButtons();
        setStatus(
          `<b>Disabled.</b> ${esc(controlState.verdict.message || "This add-on is currently turned off.")}` +
            `<br><span class="pg-small pg-muted">You: ${esc(controlState.alias || "unknown")} · install ${esc(controlState.installId || "?")}</span>`,
          "error"
        );
        return;
      }
      doExtract();
    } catch (e) {
      console.error("[PG overlay] open failed", e);
      setStatus(`The viewer hit an error: ${esc(e && e.message ? e.message : e)}<br><span class="pg-small">${esc((e && e.stack) || "").split("\n").slice(0, 3).join(" · ")}</span>`, "error");
    }
  }
  function close() {
    if (root) root.style.display = "none";
  }
  function toggle() {
    if (isOpen()) close();
    else open();
  }

  async function loadConfig() {
    try {
      const [c, s, a, ctl] = await Promise.all([
        call("getConfig"),
        call("getSettings"),
        call("siteAccess"),
        call("controlStatus").catch(() => null),
      ]);
      cfg = { ...cfg, ...c };
      settings = { ...settings, ...s };
      accessMissing = a.missing || [];
      controlState = ctl;
    } catch (e) {
      // Not fatal for reading the list; say so and carry on with defaults.
      console.warn("[PG overlay] config load failed", e);
      configError = e.message;
    }
  }

  // ── mount ───────────────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById(ROOT_ID)) {
      root = document.getElementById(ROOT_ID);
      return;
    }
    const version = browser.runtime.getManifest().version;

    const btn = document.createElement("button");
    btn.id = TOGGLE_ID;
    btn.type = "button";
    btn.textContent = "P&G Viewer";
    btn.title = "Open P&G TMS Viewer";
    btn.addEventListener("click", toggle);
    document.body.appendChild(btn);

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "P&G TMS Viewer");
    root.innerHTML = `
      <header class="pg-topbar">
        <div class="pg-brand">P&amp;G TMS Viewer <span class="pg-version">v${esc(version)}</span></div>
        <div class="pg-actions">
          <input type="search" id="pg-filter" class="pg-filter" placeholder="Filter / search IDs (space-separated = any)" title="Filter the loaded rows across all columns. Paste several IDs separated by spaces (or commas) to see every row matching ANY of them." />
          <button type="button" id="pg-btn-refresh" title="Re-read the list">Refresh</button>
          <button type="button" id="pg-btn-smc" class="pg-primary" disabled title="Check SMC + Procurement Portal for every row">Check</button>
          <label class="pg-check" title="Show only loads without an SMC order"><input type="checkbox" id="pg-new-only" disabled> New only</label>
          <label class="pg-check" title="Hide IDC-site loads (destination is a 1DC node), leaving the rest"><input type="checkbox" id="pg-idc-hide"> Hide IDC</label>
          <button type="button" id="pg-btn-new" disabled title="Load ID + PO of the new loads, tab-separated">Copy new loads</button>
          <button type="button" id="pg-btn-copy" disabled>Copy table</button>
          <button type="button" id="pg-btn-csv" disabled>Export CSV</button>
          <button type="button" id="pg-btn-settings" title="Settings" aria-label="Settings">⚙</button>
          <button type="button" id="pg-btn-close" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
      </header>
      <div id="pg-notice" class="pg-notice" style="display:none"></div>
      <div id="pg-status" class="pg-status" role="status" aria-live="polite"></div>
      <div class="pg-body">
        <main id="pg-results" class="pg-results"></main>
        <aside id="pg-panel" class="pg-panel" aria-live="polite">
          <div class="pg-panel-head">
            <span id="pg-panel-title"></span>
            <button type="button" id="pg-panel-close" aria-label="Close panel">✕</button>
          </div>
          <div id="pg-panel-body" class="pg-panel-body"></div>
        </aside>
      </div>
    `;
    document.body.appendChild(root);

    $("#pg-btn-refresh", root).addEventListener("click", doExtract);
    $("#pg-btn-smc", root).addEventListener("click", doSmcCheck);
    $("#pg-filter", root).addEventListener("input", (e) => {
      filterTerms = e.target.value.trim().toLowerCase().split(/[\s,;]+/).filter(Boolean);
      renderTable();
      if (lastRows.length) setStatus(summary(), "");
    });
    $("#pg-btn-new", root).addEventListener("click", doCopyNew);
    $("#pg-btn-copy", root).addEventListener("click", doCopy);
    $("#pg-btn-csv", root).addEventListener("click", doCsv);
    $("#pg-btn-settings", root).addEventListener("click", openSettings);
    $("#pg-btn-close", root).addEventListener("click", close);
    $("#pg-panel-close", root).addEventListener("click", hidePanel);
    $("#pg-new-only", root).addEventListener("change", (e) => {
      newOnly = e.target.checked;
      renderTable();
      if (lastRows.length) setStatus(summary(), "");
    });
    $("#pg-idc-hide", root).addEventListener("change", (e) => {
      hideIdc = e.target.checked;
      renderTable();
      if (lastRows.length) setStatus(summary(), "");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !isOpen()) return;
      if ($("#pg-panel", root).classList.contains("pg-panel-open")) hidePanel();
      else close();
    });
    dlog("mounted in", location.href);
  }

  // ── boot: mount only in the frame that carries the table ───────────────────
  // TMS may render the results after document_idle; watch briefly for the table.
  function boot() {
    if (hasTable()) {
      mount();
      return;
    }
    const mo = new MutationObserver(() => {
      if (hasTable()) {
        mo.disconnect();
        mount();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 60_000); // give up after a minute
  }

  // Toolbar button → background → "tms:toggle" to every frame. Only the frame
  // that mounted answers; the others stay silent so the background can tell.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== "tms:toggle") return;
    if (!hasTable()) return;
    if (!root) mount();
    open();
    return Promise.resolve({ bridge: true, ok: true, mounted: true, href: location.href });
  });

  boot();
  window.__pgOverlay = {
    open, close, toggle, extract: doExtract, check: doSmcCheck,
    setFilter: (s) => {
      filterTerms = String(s || "").trim().toLowerCase().split(/[\s,;]+/).filter(Boolean);
      renderTable();
      if (lastRows.length) setStatus(summary(), "");
      return visibleRows().length;
    },
    setHideIdc: (v) => {
      hideIdc = !!v;
      const chk = $("#pg-idc-hide", root);
      if (chk) chk.checked = hideIdc;
      renderTable();
      if (lastRows.length) setStatus(summary(), "");
      return visibleRows().length;
    },
    prepare: (loadId) => {
      const r = lastRows.find((x) => x.loadId === loadId);
      if (r) openPrepare(r);
    },
  };
})();
