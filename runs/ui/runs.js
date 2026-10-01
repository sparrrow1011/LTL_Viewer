/**
 * All Runs — dashboard page (ui/runs.html).
 *
 * Port of the QuickSight "All CST Runs → Summary" sheet, fed live from SMC +
 * FMC instead of the af_cst_runs_merge dataset. Read-only.
 *
 * The page orchestrates the load itself, one short message per step, so the
 * background event page never awaits a single message for ~30s (Firefox kills
 * an idle event page mid-await):
 *   controlStatus → checkSessions → getShippers → runsWindow → smcRows →
 *   N × fmcStatuses (chunked) → normalise → saveCache → render
 *
 * Field definitions (agreed 2026-09-28):
 *   pickup date     = local day of the planned yard check-in at the FIRST stop
 *                     (FMC firstYardArrival, else SMC stops[0].startTime)
 *   delivery date   = local day of the planned yard check-in at the LAST stop
 *   Same Day        = pickup date == delivery date, else Different Day
 *   status          = FMC executionStatus per VRID (SMC's order-level status
 *                     when the VRID isn't in FMC)
 *   destination type= INBOUND when the destination node looks like an Amazon
 *                     node code (cfg.amazonNodePattern), else OFF-AMAZON
 *   group           = CST / ELEX (shipper in the CST source of truth; ELEX when
 *                     its shipper_group is cfg.elexGroup) / FTL otherwise
 *   D-1             = runs whose delivery date is the chosen "Delivery date"
 *                     (default yesterday): COMPLETED when the status is in
 *                     cfg.completedStatuses, else PENDING
 */
(() => {
  "use strict";

  const TEAM = "ALL";
  const LINKS = {
    orderid: (v) => `https://smc-eu-dub.dub.proxy.amazon.com/order/${encodeURIComponent(v)}`,
    vrid: (v) => `https://trans-logistics-eu.amazon.com/fmc/execution/search/${encodeURIComponent(v)}`,
  };
  const SVC_URL = {
    SMC: "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1",
    FMC: "https://trans-logistics-eu.amazon.com/fmc/execution",
    SharePoint: "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations",
  };
  const svcUrl = (svc) => SVC_URL[svc] || SVC_URL.SMC;

  // ── tiny DOM helpers ───────────────────────────────────────────────────────
  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, String(v));
    }
    for (const c of [].concat(kids)) if (c) n.appendChild(c);
    return n;
  }
  const NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs = {}) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
    return n;
  }
  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00`);
    return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  };
  // "Today" is the UTC day: runs are bucketed by the UTC date of their planned
  // yard check-in, matching the HC Calculator.
  const today = () => new Date().toISOString().slice(0, 10);
  const str = (v) => (v == null ? "" : String(v));
  function fmtTime(ms) {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return "";
    }
  }
  // Planned times are shown in UTC — the same clock the day buckets use (and
  // the one FMC / the HC Calculator report in).
  function fmtStamp(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function toast(text, kind = "info") {
    const t = el("div", { class: `runs-toast runs-toast-${kind}`, text, role: "status" });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ── messaging ──────────────────────────────────────────────────────────────
  const dbg = { enabled: false };
  const dlog = (...a) => dbg.enabled && console.debug("[RUNS page]", ...a);
  window.__runsPageDebug = {
    enable() { dbg.enabled = true; },
    disable() { dbg.enabled = false; },
  };

  async function msg(action, extra = {}) {
    dlog(`→ ${action}`, extra);
    const resp = await browser.runtime.sendMessage({ action, team: TEAM, ...extra });
    if (!resp || !resp.ok) {
      const bits = [(resp && resp.error) || `${action} failed`];
      if (resp && resp.status) bits.push(`(HTTP ${resp.status})`);
      if (resp && resp.body) console.error(`[RUNS page] ${action} body:`, resp.body);
      const err = new Error(bits.join(" "));
      err.expired = !!(resp && resp.expired);
      err.permission = !!(resp && resp.permission);
      err.controlBlocked = !!(resp && resp.controlBlocked);
      throw err;
    }
    dlog(`✓ ${action}`, resp.data);
    return resp.data;
  }

  // ── pipeline card ──────────────────────────────────────────────────────────
  const Pipeline = (() => {
    let steps = [];
    let startedAt = 0;
    let timer = null;
    let title = "Working…";
    let metaPrefix = "";
    const fmtElapsed = () => {
      const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    };
    function render() {
      const list = $("#runs-pipe-steps");
      if (!list) return;
      list.innerHTML = "";
      steps.forEach((st, i) => {
        const li = el("li", { class: `runs-pipe-step runs-pipe-${st.state}` });
        const dot = el("span", { class: "runs-pipe-dot", "aria-hidden": "true" });
        dot.textContent = st.state === "done" ? "✓" : st.state === "failed" ? "✕" : "";
        const body = el("div", { class: "runs-pipe-body" }, [
          el("div", { class: "runs-pipe-label", text: st.state === "failed" ? `${st.label} — failed` : st.label }),
        ]);
        const sub = st.detail || st.hint || "";
        if (sub) body.appendChild(el("div", { class: st.state === "failed" ? "runs-pipe-error" : "runs-pipe-hint", text: sub }));
        li.appendChild(dot);
        li.appendChild(body);
        if (i < steps.length - 1) li.appendChild(el("span", { class: "runs-pipe-rail", "aria-hidden": "true" }));
        list.appendChild(li);
      });
      const done = steps.filter((s) => s.state === "done").length;
      const failedIdx = steps.findIndex((s) => s.state === "failed");
      const activeIdx = steps.findIndex((s) => s.state === "active");
      const cur = failedIdx >= 0 ? failedIdx + 1 : activeIdx >= 0 ? activeIdx + 1 : done;
      const pct = steps.length ? Math.round(((failedIdx >= 0 ? failedIdx : done) / steps.length) * 100) : 0;
      const fill = $("#runs-pipe-fill");
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle("runs-pipe-fill-failed", failedIdx >= 0);
      }
      const stepno = $("#runs-pipe-stepno");
      if (stepno) stepno.textContent = failedIdx >= 0 ? `failed at step ${failedIdx + 1} of ${steps.length}` : `step ${cur} of ${steps.length}`;
      const t = $("#runs-pipe-title");
      if (t) t.textContent = failedIdx >= 0 ? "Stopped" : title;
      $("#runs-pipe-card")?.classList.toggle("runs-pipe-failed", failedIdx >= 0);
      const foot = $("#runs-pipe-foot");
      if (foot) foot.style.display = failedIdx >= 0 ? "none" : "";
    }
    function tick() {
      const meta = $("#runs-pipe-meta");
      if (meta) meta.textContent = `${metaPrefix}${metaPrefix ? " · " : ""}elapsed ${fmtElapsed()}`;
    }
    return {
      begin(runTitle, stepDefs, meta = "", { quiet = false } = {}) {
        title = runTitle;
        metaPrefix = meta;
        steps = stepDefs.map((s) => ({ ...s, state: "pending", detail: "" }));
        startedAt = Date.now();
        const actions = $("#runs-pipe-actions");
        if (actions) actions.innerHTML = "";
        $("#runs-loading")?.classList.toggle("runs-quiet", quiet);
        this.show();
        render();
        tick();
        clearInterval(timer);
        timer = setInterval(tick, 1000);
      },
      start(key, detail) {
        for (const s of steps) if (s.state === "active") s.state = "done";
        const st = steps.find((s) => s.key === key);
        if (st) {
          st.state = "active";
          if (detail != null) st.detail = detail;
        }
        render();
      },
      note(detail) {
        const st = steps.find((s) => s.state === "active");
        if (st) {
          st.detail = detail;
          render();
        }
      },
      done(key, detail) {
        const st = steps.find((s) => s.key === key);
        if (st) {
          st.state = "done";
          if (detail != null) st.detail = detail;
        }
        render();
      },
      fail(key, message, { services = [], onRetry, onGrant } = {}) {
        // A failure must be seen: undock a quiet (background) refresh.
        $("#runs-loading")?.classList.remove("runs-quiet");
        const st = steps.find((s) => s.key === key) || steps.find((s) => s.state === "active");
        if (st) {
          st.state = "failed";
          st.detail = message || "failed";
        }
        clearInterval(timer);
        timer = null;
        tick();
        render();
        const actions = $("#runs-pipe-actions");
        if (!actions) return;
        actions.innerHTML = "";
        if (typeof onGrant === "function") {
          actions.appendChild(el("button", { type: "button", class: "runs-btn", text: "Grant site access", onclick: () => onGrant() }));
        }
        for (const svc of services) {
          actions.appendChild(el("button", { type: "button", class: "runs-btn runs-gray", text: `Open ${svc}`, onclick: () => window.open(svcUrl(svc), "_blank", "noopener") }));
        }
        if (typeof onRetry === "function") actions.appendChild(el("button", { type: "button", class: "runs-btn runs-green", text: "Retry", onclick: () => onRetry() }));
        actions.appendChild(el("button", { type: "button", class: "runs-btn runs-gray", text: "Dismiss", onclick: () => Pipeline.hide() }));
      },
      finish() {
        for (const s of steps) if (s.state === "active") s.state = "done";
        clearInterval(timer);
        timer = null;
        render();
      },
      show() { $("#runs-loading")?.classList.add("runs-show"); },
      hide() {
        clearInterval(timer);
        timer = null;
        $("#runs-loading")?.classList.remove("runs-show", "runs-quiet");
        steps = [];
        const list = $("#runs-pipe-steps");
        if (list) list.innerHTML = "";
        const actions = $("#runs-pipe-actions");
        if (actions) actions.innerHTML = "";
      },
      isFailed() { return steps.some((s) => s.state === "failed"); },
    };
  })();

  // ── state ──────────────────────────────────────────────────────────────────
  let _cfg = null; // getConfig
  let _shippers = null; // getShippers result
  let _rows = []; // normalised runs (whole window)
  let _meta = null; // {window, smc, fmcFound, fmcAsked, truncated}
  let _fetchedAt = 0;
  let _busy = false;
  let _blocked = false; // remote control
  let _tab = "summary";
  let _sort = { key: "pickup_ms", dir: 1 };

  // Filters. Multi-selects hold the EXCLUDED values so a value that first
  // appears after a refresh is included by default (the way QuickSight's
  // "select all" behaves).
  const _f = {
    pickupFrom: today(),
    pickupTo: today(),
    deliveryDate: addDays(today(), -1),
    excl: {
      group: new Set(),
      orig_country: new Set(),
      dest_country: new Set(),
      shippername: new Set(),
      status: new Set(["CANCELLED"]),
      dest_type: new Set(),
      cancellation_reason: new Set(),
    },
  };

  // Auto-refresh (page-side timer; only while the tab is open).
  const AUTO_KEY = "runs.autoRefreshMin";
  const AUTO_TICK_MS = 5_000;
  let _autoMin = 15;
  let _nextAutoAt = 0;
  // How many days ahead of today to pull from SMC (header select, 1..maxDaysForward).
  const FWD_KEY = "runs.daysForward";
  let _daysForward = 1;

  // ── normalisation ──────────────────────────────────────────────────────────
  const FMC_FIELDS = [
    "vehicle_execution_status", "vehicle_carrier", "carrier_name", "tour_id",
    "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
    "orig_node", "dest_node", "orig_country", "dest_country", "lane", "equipment_type",
    "orig_planned_epoch", "dest_planned_epoch", "cancellation_reason", "tender_status", "orig_load_type",
  ];

  function toMs(epoch, isoText) {
    if (epoch != null && epoch !== "") {
      const n = Number(epoch);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (isoText) {
      // FMC's "YYYY-MM-DD HH:MM:SS" is UTC; SMC's ISO string carries its own zone.
      let s = String(isoText).trim();
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = `${s.replace(" ", "T")}Z`;
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }

  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  function normalise(rows, shipperMap, cfg) {
    const nodeRe = new RegExp(cfg.amazonNodePattern || "^[A-Z][A-Z0-9]{2,4}$");
    const elex = String(cfg.elexGroup || "").trim().toLowerCase();
    const out = [];
    for (const r of rows) {
      const vrid = str(r.vrid).trim();
      if (!vrid) continue;
      const sid = str(r.shipperid).trim();
      const sot = shipperMap[sid];
      const group = !sot ? "FTL" : str(sot.shipper_group).trim().toLowerCase() === elex ? "ELEX" : "CST";
      const pickupMs = toMs(r.orig_planned_epoch, r.orig_planned_yard_checkin_time);
      const deliveryMs = toMs(r.dest_planned_epoch, r.dest_planned_yard_checkin_time);
      // UTC day, like the HC Calculator (and the source timestamps).
      const pickupDate = pickupMs ? utcDay(pickupMs) : "";
      const deliveryDate = deliveryMs ? utcDay(deliveryMs) : "";
      const destNode = str(r.dest_node || r.dest_code).trim();
      // FMC's per-VRID status; but an order SMC has cancelled or left in draft
      // is out of scope whatever FMC still says (same rule as the HC Calculator).
      const orderStatus = str(r.order_status || r.status).trim().toUpperCase();
      const fmcStatus = str(r.vehicle_execution_status || r.execution_status).trim().toUpperCase();
      const status = orderStatus === "CANCELLED" || orderStatus === "DRAFT" ? "CANCELLED" : fmcStatus || orderStatus || "(none)";
      out.push({
        vrid,
        orderid: str(r.orderid),
        tour_id: str(r.tour_id),
        shipperid: sid,
        shippername: str(r.shippername || (sot && sot.shippername)).trim() || "(unknown)",
        shipper_group_raw: sot ? str(sot.shipper_group) : "",
        group,
        status,
        cancellation_reason: str(r.cancellation_reason).trim() || (status === "CANCELLED" ? "(not given)" : "(n/a)"),
        carrier: str(r.carrier_name || r.vehicle_carrier).trim(),
        scac: str(r.vehicle_carrier).trim().toUpperCase() || "(none)",
        load_type: str(r.orig_load_type).trim().toUpperCase() || "",
        orig_node: str(r.orig_node || r.origin_code).trim(),
        dest_node: destNode,
        orig_country: str(r.orig_country).trim().toUpperCase() || "(none)",
        dest_country: str(r.dest_country).trim().toUpperCase() || "(none)",
        dest_type: destNode && nodeRe.test(destNode) ? "INBOUND" : "OFF-AMAZON",
        pickup_ms: pickupMs,
        pickup_date: pickupDate,
        pickup_hour: pickupMs ? `${pad(new Date(pickupMs).getUTCHours())}:00` : "",
        order_status: orderStatus,
        delivery_ms: deliveryMs,
        delivery_date: deliveryDate,
        delivery_kind: pickupDate && deliveryDate ? (pickupDate === deliveryDate ? "Same Day Delivery" : "Different Day Delivery") : "(unknown)",
        freight_type: str(r.freight_type),
        equipment_type: str(r.equipment_type),
        in_fmc: !!r._in_fmc,
      });
    }
    return out;
  }

  // ── filtering / aggregation ────────────────────────────────────────────────
  const FILTER_KEYS = ["group", "orig_country", "dest_country", "shippername", "status", "dest_type", "cancellation_reason"];

  function baseRows() {
    return _rows.filter((r) => FILTER_KEYS.every((k) => !_f.excl[k].has(r[k])));
  }
  const inPickupRange = (r) => r.pickup_date >= _f.pickupFrom && r.pickup_date <= _f.pickupTo;
  const dayRows = () => baseRows().filter(inPickupRange);
  const d1Rows = () => baseRows().filter((r) => r.delivery_date === _f.deliveryDate);

  function countBy(rows, key) {
    const m = new Map();
    for (const r of rows) {
      const k = str(r[key]) || "(none)";
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }
  function pivot(rows, keys) {
    const m = new Map();
    for (const r of rows) {
      const parts = keys.map((k) => str(r[k]));
      const id = parts.join("\u0001");
      const e = m.get(id) || { cells: parts, n: 0 };
      e.n += 1;
      m.set(id, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.cells.join().localeCompare(b.cells.join()));
  }
  const isDone = (r) => (_cfg.completedStatuses || []).includes(r.status);

  // ── CSV export ─────────────────────────────────────────────────────────────
  function csvCell(v) {
    const s = str(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadCsv(name, headers, rows) {
    const lines = [headers.map(csvCell).join(",")];
    for (const r of rows) lines.push(r.map(csvCell).join(","));
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  const csvBtn = (name, headers, rowsFn) =>
    el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "⬇ CSV", onclick: () => downloadCsv(name, headers, rowsFn()) });

  // ── charts ─────────────────────────────────────────────────────────────────
  const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#f59e0b", "#64748b", "#0f766e", "#9333ea"];

  function barChart(data, { height = 200, colors = PALETTE, slot = 110, maxWidth = 520 } = {}) {
    const padd = { l: 8, r: 8, t: 22, b: 36 };
    const width = Math.min(maxWidth, padd.l + padd.r + Math.max(1, data.length) * slot);
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "runs-chart", role: "img" });
    if (!data.length) return svg;
    const cw = width - padd.l - padd.r;
    const ch = height - padd.t - padd.b;
    const max = Math.max(1, ...data.map((d) => d.value));
    const bw = cw / data.length;
    const barW = Math.min(64, bw * 0.62);
    data.forEach((d, i) => {
      const x = padd.l + i * bw + (bw - barW) / 2;
      const h = Math.round((d.value / max) * ch);
      const y = padd.t + (ch - h);
      svg.appendChild(svgEl("rect", { x, y, width: barW, height: h, rx: 4, fill: colors[i % colors.length] }));
      const val = svgEl("text", { x: x + barW / 2, y: y - 6, "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "#334155" });
      val.textContent = d.value;
      svg.appendChild(val);
      const lab = svgEl("text", { x: x + barW / 2, y: height - 14, "text-anchor": "middle", "font-size": 11, fill: "#64748b" });
      lab.textContent = d.label;
      svg.appendChild(lab);
    });
    return svg;
  }

  function pieChart(data, { size = 200 } = {}) {
    const wrap = el("div", { class: "runs-pie-wrap" });
    const total = data.reduce((s, d) => s + d.value, 0);
    const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: "runs-chart", role: "img" });
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 4;
    if (!total) return wrap;
    if (data.length === 1) {
      svg.appendChild(svgEl("circle", { cx, cy, r: R, fill: PALETTE[0] }));
    } else {
      let a0 = -Math.PI / 2;
      data.forEach((d, i) => {
        const a1 = a0 + (d.value / total) * Math.PI * 2;
        const x0 = cx + R * Math.cos(a0);
        const y0 = cy + R * Math.sin(a0);
        const x1 = cx + R * Math.cos(a1);
        const y1 = cy + R * Math.sin(a1);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const path = svgEl("path", {
          d: `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
          fill: PALETTE[i % PALETTE.length],
          stroke: "#fff",
          "stroke-width": 1,
        });
        const title = svgEl("title");
        title.textContent = `${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`;
        path.appendChild(title);
        svg.appendChild(path);
        // label inside the slice when it is big enough
        if (d.value / total >= 0.06) {
          const mid = (a0 + a1) / 2;
          const lx = cx + R * 0.62 * Math.cos(mid);
          const ly = cy + R * 0.62 * Math.sin(mid);
          const t = svgEl("text", { x: lx.toFixed(1), y: ly.toFixed(1), "text-anchor": "middle", "dominant-baseline": "middle", "font-size": 11, "font-weight": 700, fill: "#fff" });
          t.textContent = `${d.label} ${d.value}`;
          svg.appendChild(t);
        }
        a0 = a1;
      });
    }
    wrap.appendChild(svg);
    const legend = el("ul", { class: "runs-legend" });
    data.forEach((d, i) => {
      legend.appendChild(
        el("li", {}, [
          el("span", { class: "runs-swatch", style: `background:${PALETTE[i % PALETTE.length]}` }),
          el("span", { text: d.label }),
          el("span", { class: "runs-legend-n", text: `${d.value} · ${Math.round((d.value / total) * 100)}%` }),
        ])
      );
    });
    legend.appendChild(el("li", {}, [el("span", { class: "runs-swatch", style: "background:transparent" }), el("b", { text: "Total" }), el("span", { class: "runs-legend-n", text: String(total) })]));
    wrap.appendChild(legend);
    return wrap;
  }

  // ── UI pieces ──────────────────────────────────────────────────────────────
  function panel(title, body, { wide = false, half = false, tools = [], note } = {}) {
    return el("div", { class: `runs-panel${wide ? " runs-panel-wide" : ""}${half ? " runs-panel-half" : ""}` }, [
      el("div", { class: "runs-panel-head" }, [el("h2", { class: "runs-title", text: title }), ...tools]),
      note ? el("p", { class: "runs-note", text: note }) : null,
      body,
    ]);
  }

  function table(headers, rows, { numericLast = true } = {}) {
    if (!rows.length) return el("div", { class: "runs-empty", text: "Nothing matches the current filters." });
    const thead = el("thead", {}, [el("tr", {}, headers.map((h, i) => el("th", { text: h, class: numericLast && i === headers.length - 1 ? "runs-num" : "" })))]);
    const tbody = el("tbody");
    for (const r of rows) {
      tbody.appendChild(el("tr", {}, r.map((c, i) => el("td", { class: numericLast && i === r.length - 1 ? "runs-num" : "" }, [c instanceof Node ? c : document.createTextNode(str(c))]))));
    }
    return el("div", { class: "runs-scroll" }, [el("table", { class: "runs-table" }, [thead, tbody])]);
  }

  // Collapsible pivot (QuickSight style): one header row per group carrying the
  // group's totals, click to reveal its child rows. Expansion survives
  // re-renders (filters, refresh) via _expanded[key].
  //   groups: [{ label, totals: number[], children: cell[][] }]
  //   Child rows have one cell FEWER than the header (the first column holds the
  //   group label / child label); numeric totals cells align under the header
  //   columns after the first.
  const _expanded = { orig: new Set(), dest: new Set(), tbd: new Set() };
  const _expandAll = { orig: false, dest: false, tbd: false };
  const isOpen = (key, label) => _expandAll[key] ? !_expanded[key].has(label) : _expanded[key].has(label);

  function treeTable(key, headers, groups, { grandTotal = null, blankCell = (n) => String(n) } = {}) {
    if (!groups.length) return el("div", { class: "runs-empty", text: "Nothing matches the current filters." });
    const numeric = (i) => i >= 1;
    // Totals sit under the LAST header columns; pad the gap after the label.
    const spacers = new Array(Math.max(0, headers.length - 1 - groups[0].totals.length)).fill(0);
    const thead = el("thead", {}, [el("tr", {}, headers.map((h, i) => el("th", { text: h, class: numeric(i) && i >= headers.length - groups[0].totals.length ? "runs-num" : "" })))]);
    const tbody = el("tbody");
    for (const g of groups) {
      const open = isOpen(key, g.label);
      const toggle = () => {
        if (_expandAll[key]) {
          if (_expanded[key].has(g.label)) _expanded[key].delete(g.label);
          else _expanded[key].add(g.label);
        } else if (_expanded[key].has(g.label)) _expanded[key].delete(g.label);
        else _expanded[key].add(g.label);
        renderView();
      };
      const head = el("tr", { class: `runs-tree-group${open ? " runs-tree-open" : ""}`, tabindex: "0", role: "button", "aria-expanded": open ? "true" : "false", onclick: toggle, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } }, [
        el("td", {}, [el("span", { class: "runs-tree-chev", "aria-hidden": "true", text: open ? "−" : "+" }), el("b", { text: g.label })]),
        ...spacers.map(() => el("td")),
        ...g.totals.map((n) => el("td", { class: "runs-num" }, [el("b", { text: blankCell(n) })])),
      ]);
      tbody.appendChild(head);
      if (open) {
        for (const c of g.children) {
          tbody.appendChild(el("tr", { class: "runs-tree-child" }, c.map((v, i) => el("td", { class: numeric(i) && i >= c.length - g.totals.length ? "runs-num" : v instanceof Node ? "runs-wrap" : "" }, [v instanceof Node ? v : document.createTextNode(str(v))]))));
        }
      }
    }
    if (grandTotal) {
      tbody.appendChild(el("tr", { class: "runs-tree-total" }, [
        el("td", {}, [el("b", { text: "Total" })]),
        ...spacers.map(() => el("td")),
        ...grandTotal.map((n) => el("td", { class: "runs-num" }, [el("b", { text: String(n) })])),
      ]));
    }
    return el("div", { class: "runs-scroll" }, [el("table", { class: "runs-table runs-tree" }, [thead, tbody])]);
  }

  function treeTools(key) {
    const set = (all) => { _expandAll[key] = all; _expanded[key].clear(); renderView(); };
    return [
      el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: _expandAll[key] ? "Collapse all" : "Expand all", onclick: () => set(!_expandAll[key]) }),
    ];
  }

  const pill = (text, cls) => el("span", { class: `runs-pill ${cls}`, text });
  const groupPill = (g) => pill(g, g === "CST" ? "runs-pill-cst" : g === "ELEX" ? "runs-pill-elex" : "runs-pill-other");
  const statusPill = (r) => pill(r.status, isDone(r) ? "runs-pill-ok" : r.status === "CANCELLED" ? "runs-pill-cancel" : "runs-pill-pending");
  const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener", text });

  // Multi-select dropdown over the values present in the data.
  //   mode "exclude": `set` holds EXCLUDED values — "All" clears it, so a value
  //                   that first appears after a refresh is included (default
  //                   for the Summary filters).
  //   mode "include": `set` holds the SELECTED values — new values stay out
  //                   (the To-be-delivered Status filter: IN_TRANSIT + PLANNED).
  function multiSelect(label, key, counts, { set = _f.excl[key], mode = "exclude", onChange = onFilterChange } = {}) {
    const values = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    const isSel = (v) => (mode === "exclude" ? !set.has(v) : set.has(v));
    const selected = values.filter(isSel).length;
    const all = mode === "exclude" ? set.size === 0 : selected === values.length;
    const summaryText = () => (all ? `${label}: all` : `${label}: ${selected} of ${values.length}`);
    const details = el("details", { class: "runs-ms", "data-key": key });
    const summary = el("summary", { text: summaryText() });
    const pop = el("div", { class: "runs-ms-pop" });
    const search = el("input", { type: "search", placeholder: "filter…", "aria-label": `Search ${label}` });
    const selectAll = () => { set.clear(); if (mode === "include") for (const v of values) set.add(v); onChange(); };
    const selectNone = () => { set.clear(); if (mode === "exclude") for (const v of values) set.add(v); onChange(); };
    const tools = el("div", { class: "runs-ms-tools" }, [
      search,
      el("button", { type: "button", class: "runs-btn runs-sm", text: "All", onclick: selectAll }),
      el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "None", onclick: selectNone }),
    ]);
    pop.appendChild(tools);
    const opts = values.map((v) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = isSel(v);
      cb.addEventListener("change", () => {
        const on = cb.checked;
        if (mode === "exclude" ? !on : on) set.add(v);
        else set.delete(v);
        onChange({ keepOpen: details });
      });
      return el("label", { class: "runs-ms-opt", "data-v": v.toLowerCase() }, [cb, el("span", { text: v }), el("span", { class: "runs-ms-n", text: String(counts.get(v)) })]);
    });
    for (const o of opts) pop.appendChild(o);
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const o of opts) o.classList.toggle("runs-ms-hidden", !!q && !o.getAttribute("data-v").includes(q));
    });
    details.appendChild(summary);
    details.appendChild(pop);
    return el("div", { class: "runs-field" }, [el("span", { class: "runs-lbl", text: label }), details]);
  }

  // Pick-up date range (shared by every tab). Bounded by the fetched window.
  function pickupRangeFields() {
    const win = (_meta && _meta.window) || {};
    const input = (value, onchange, label) =>
      el("input", { type: "date", value, min: win.start || null, max: win.end || null, "aria-label": label, onchange });
    const setRange = (from, to) => {
      _f.pickupFrom = from || today();
      _f.pickupTo = to || _f.pickupFrom;
      if (_f.pickupTo < _f.pickupFrom) [_f.pickupFrom, _f.pickupTo] = [_f.pickupTo, _f.pickupFrom];
      renderView();
    };
    return el("div", { class: "runs-field" }, [
      el("span", { class: "runs-lbl", text: `Pick up date, UTC (from → to)${win.start ? ` · data ${win.start} → ${win.end}` : ""}` }),
      el("div", { class: "runs-range" }, [
        input(_f.pickupFrom, (e) => setRange(e.target.value, _f.pickupTo), "Pick up date from"),
        el("span", { text: "→", "aria-hidden": "true" }),
        input(_f.pickupTo, (e) => setRange(_f.pickupFrom, e.target.value), "Pick up date to"),
        el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "Today", onclick: () => setRange(today(), today()) }),
        win.start ? el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "All", title: "The whole fetched window", onclick: () => setRange(win.start, win.end) }) : null,
      ]),
    ]);
  }
  const fmtRange = () => (_f.pickupFrom === _f.pickupTo ? fmtDay(_f.pickupFrom) : `${fmtDay(_f.pickupFrom)} → ${fmtDay(_f.pickupTo)}`);
  const rangeTag = () => (_f.pickupFrom === _f.pickupTo ? _f.pickupFrom : `${_f.pickupFrom}_${_f.pickupTo}`);

  function resetMainFilters() {
    _f.pickupFrom = today();
    _f.pickupTo = today();
    _f.deliveryDate = addDays(today(), -1);
    for (const k of FILTER_KEYS) _f.excl[k].clear();
    for (const s of (_cfg && _cfg.defaultExcludedStatuses) || []) _f.excl.status.add(s);
  }

  let _openFilter = null; // key of the dropdown to re-open after a re-render
  function onFilterChange({ keepOpen } = {}) {
    _openFilter = keepOpen ? keepOpen.getAttribute("data-key") : null;
    renderView();
  }

  function renderFilters() {
    const bar = el("div", { class: "runs-filters", role: "group", "aria-label": "Filters" });
    const dateField = (label, value, onchange) =>
      el("div", { class: "runs-field" }, [el("span", { class: "runs-lbl", text: label }), el("input", { type: "date", value, onchange })]);
    bar.appendChild(pickupRangeFields());
    const defs = [
      ["Group", "group"],
      ["Origin country", "orig_country"],
      ["Destination country", "dest_country"],
      ["Shipper", "shippername"],
      ["Status", "status"],
      ["Destination type", "dest_type"],
      ["Cancellation reason", "cancellation_reason"],
    ];
    for (const [label, key] of defs) {
      const ms = multiSelect(label, key, countBy(_rows, key));
      if (_openFilter === key) ms.querySelector("details").open = true;
      bar.appendChild(ms);
    }
    bar.appendChild(dateField("Delivery date (D-1)", _f.deliveryDate, (e) => { _f.deliveryDate = e.target.value || addDays(today(), -1); renderView(); }));
    bar.appendChild(el("span", { class: "runs-spacer" }));
    bar.appendChild(
      el("button", {
        type: "button", class: "runs-btn runs-gray runs-sm", text: "Reset filters",
        onclick: () => { resetMainFilters(); renderView(); },
      })
    );
    _openFilter = null;
    return bar;
  }

  // ── Summary tab ────────────────────────────────────────────────────────────
  // Layout mirrors the QuickSight sheet:
  //   row 1: KPI block │ To be delivered today │ Origin country pie │ Top ranked │ Count of delivery
  //   row 2: Origin node pivot │ Destination node pivot (ELEX / CST / FTL columns)
  //   row 3: D-1 delivery outcome
  const GROUPS = ["ELEX", "CST", "FTL"];

  function kpi(label, value, sub, cls) {
    return el("div", { class: `runs-kpi ${cls || ""}` }, [
      el("div", { class: "runs-kpi-lbl", text: label }),
      el("div", { class: "runs-kpi-val", text: String(value) }),
      sub ? el("div", { class: "runs-kpi-sub", text: sub }) : null,
    ]);
  }
  const fmtDay = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  function renderSummary(view) {
    const day = dayRows();
    const d1 = d1Rows();
    const byGroup = countBy(day, "group");
    const cst = byGroup.get("CST") || 0;
    const elex = byGroup.get("ELEX") || 0;
    const other = byGroup.get("FTL") || 0;
    const byKind = countBy(day, "delivery_kind");
    const same = byKind.get("Same Day Delivery") || 0;
    const diff = byKind.get("Different Day Delivery") || 0;
    const done = d1.filter(isDone).length;
    const pending = d1.length - done;
    const pickDay = fmtRange();
    const empty = () => el("div", { class: "runs-empty", text: "Nothing matches the current filters." });

    // ── row 1 ────────────────────────────────────────────────────────────────
    const row1 = el("div", { class: "runs-row1" });
    view.appendChild(row1);

    row1.appendChild(
      el("div", { class: "runs-kpis" }, [
        kpi("Total", day.length, pickDay, "runs-kpi-total"),
        kpi("CST count", cst, pickDay, "runs-kpi-cst"),
        kpi("Elex", elex, pickDay, "runs-kpi-elex"),
        kpi("FTL", other, pickDay, "runs-kpi-ftl"),
        kpi("D-1 Delivery", d1.length, fmtDay(_f.deliveryDate), "runs-kpi-d1"),
        kpi("D-1 pending", pending, `${done} completed`, pending ? "runs-kpi-warn" : "runs-kpi-ok"),
      ])
    );

    const kinds = [
      { label: "Different Day", value: diff },
      { label: "Same Day", value: same },
    ];
    if (byKind.get("(unknown)")) kinds.push({ label: "(unknown)", value: byKind.get("(unknown)") });
    row1.appendChild(panel("To be delivered today", day.length ? barChart(kinds, { colors: ["#f59e0b", "#0ea5e9", "#64748b"], height: 230, slot: 90, maxWidth: 300 }) : empty(), { note: pickDay }));

    const countries = [...countBy(day, "orig_country").entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    row1.appendChild(
      panel("Count of records by origin country", countries.length ? pieChart(countries, { size: 210 }) : empty(), {
        tools: [csvBtn(`origin-country-${rangeTag()}.csv`, ["Origin country", "Runs"], () => countries.map((c) => [c.label, c.value]))],
      })
    );

    const topShippers = [...countBy(day, "shippername").entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    row1.appendChild(
      panel(
        "Top ranked",
        topShippers.length
          ? el("div", {}, [
              el("p", { class: "runs-note", text: "Top 3 shipper names for total count of records are:" }),
              el("ul", { class: "runs-rank" }, topShippers.map(([name, n]) => el("li", {}, [el("b", { text: name }), document.createTextNode(` with ${n}`)]))),
            ])
          : empty()
      )
    );

    row1.appendChild(
      panel("Count of delivery by delivery", table(["Rows", "Delivery"], [["Different Day Delivery", diff], ["Same Day Delivery", same], ["Total", day.length]]), {
        tools: [csvBtn(`delivery-kind-${rangeTag()}.csv`, ["Delivery", "Count"], () => [["Different Day Delivery", diff], ["Same Day Delivery", same]])],
      })
    );

    // ── row 2: the two node pivots ───────────────────────────────────────────
    const pivots = el("div", { class: "runs-pivots" });
    view.appendChild(pivots);

    // Origin node: shipper (collapsed, with its total) → origin node × hour.
    // Shippers by volume (most VRIDs first); inside a shipper by planned hour.
    const origPivot = pivot(day, ["shippername", "orig_node", "pickup_hour"]).sort((a, b) => a.cells[0].localeCompare(b.cells[0]) || a.cells[2].localeCompare(b.cells[2]) || a.cells[1].localeCompare(b.cells[1]));
    const origNodes = new Set(day.map((r) => r.orig_node)).size;
    const origGroups = [];
    for (const p of origPivot) {
      let g = origGroups[origGroups.length - 1];
      if (!g || g.label !== p.cells[0]) {
        g = { label: p.cells[0], totals: [0], children: [] };
        origGroups.push(g);
      }
      g.totals[0] += p.n;
      g.children.push([p.cells[1], p.cells[2], p.n]);
    }
    origGroups.sort((a, b) => b.totals[0] - a.totals[0] || a.label.localeCompare(b.label));
    pivots.appendChild(
      panel(
        "Origin node",
        treeTable("orig", ["Shipper / Origin node", "Planned yard check-in (hour, UTC)", "VRIDs"], origGroups, { grandTotal: [day.length] }),
        {
          half: true,
          note: `Including shipper name · ${origGroups.length} shipper${origGroups.length === 1 ? "" : "s"}, ${origPivot.length} row${origPivot.length === 1 ? "" : "s"} across ${origNodes} origin node${origNodes === 1 ? "" : "s"}.`,
          tools: [...treeTools("orig", origGroups), csvBtn(`origin-node-${rangeTag()}.csv`, ["Shipper", "Origin node", "Hour", "VRIDs"], () => origPivot.map((p) => [...p.cells, p.n]))],
        }
      )
    );

    // Destination node: shipper (collapsed) → destination node, one column per
    // shipper group + total.
    const destMap = new Map();
    for (const r of day) {
      const k = `${r.shippername}\u0001${r.dest_node}`;
      const e = destMap.get(k) || { shipper: r.shippername, node: r.dest_node, ELEX: 0, CST: 0, FTL: 0, total: 0 };
      e[r.group] = (e[r.group] || 0) + 1;
      e.total += 1;
      destMap.set(k, e);
    }
    const destRows = [...destMap.values()].sort((a, b) => a.shipper.localeCompare(b.shipper) || b.total - a.total || a.node.localeCompare(b.node));
    const groupsUsed = GROUPS.filter((g) => destRows.some((r) => r[g]));
    const cellOf = (n) => (n ? String(n) : "");
    const destByShipper = new Map();
    for (const r of destRows) {
      const g = destByShipper.get(r.shipper) || { label: r.shipper, totals: [...groupsUsed.map(() => 0), 0], children: [] };
      groupsUsed.forEach((grp, i) => (g.totals[i] += r[grp] || 0));
      g.totals[g.totals.length - 1] += r.total;
      g.children.push([r.node, ...groupsUsed.map((grp) => cellOf(r[grp])), r.total]);
      destByShipper.set(r.shipper, g);
    }
    const destGroups = [...destByShipper.values()].sort((a, b) => b.totals[b.totals.length - 1] - a.totals[a.totals.length - 1] || a.label.localeCompare(b.label));
    const destTotals = [...groupsUsed.map((g) => destRows.reduce((s, r) => s + (r[g] || 0), 0)), day.length];
    pivots.appendChild(
      panel(
        "Destination node",
        treeTable("dest", ["Shipper / Destination node", ...groupsUsed, "Total"], destGroups, { grandTotal: destTotals, blankCell: cellOf }),
        {
          half: true,
          note: `Including shipper name · VRIDs per shipper group · ${destGroups.length} shipper${destGroups.length === 1 ? "" : "s"}, ${destRows.length} row${destRows.length === 1 ? "" : "s"}.`,
          tools: [...treeTools("dest", destGroups), csvBtn(`destination-node-${rangeTag()}.csv`, ["Shipper", "Destination node", ...groupsUsed, "Total"], () => destRows.map((r) => [r.shipper, r.node, ...groupsUsed.map((g) => r[g] || 0), r.total]))],
        }
      )
    );

    // ── row 3: D-1 delivery outcome ──────────────────────────────────────────
    const pendingRows = d1.filter((r) => !isDone(r)).sort((a, b) => (a.delivery_ms || 0) - (b.delivery_ms || 0));
    view.appendChild(
      el("div", { class: "runs-grid", style: "margin-top:14px" }, [
        panel(
          "Eventually delivered / pending to complete",
          el("div", {}, [
            table(["Delivery status (D-1)", "Count"], [["COMPLETED", done], ["PENDING", pending]]),
            pendingRows.length
              ? el("details", { style: "margin-top:8px" }, [
                  el("summary", { text: `Pending runs (${pendingRows.length})`, style: "cursor:pointer;font-size:12px;color:var(--text-2)" }),
                  table(["VRID", "Shipper", "Group", "Status", "Dest node", "Planned delivery"], pendingRows.map((r) => [link(LINKS.vrid(r.vrid), r.vrid), r.shippername, groupPill(r.group), statusPill(r), r.dest_node, fmtStamp(r.delivery_ms)]), { numericLast: false }),
                ])
              : null,
          ]),
          {
            wide: true,
            note: `Runs whose planned delivery is ${_f.deliveryDate}. COMPLETED = FMC status in ${(_cfg.completedStatuses || []).join(" / ")}.`,
            tools: [csvBtn(`d1-delivery-${_f.deliveryDate}.csv`, ["VRID", "Order", "Shipper", "Group", "Status", "Delivered", "Dest node", "Planned delivery"], () => d1.map((r) => [r.vrid, r.orderid, r.shippername, r.group, r.status, isDone(r) ? "COMPLETED" : "PENDING", r.dest_node, fmtStamp(r.delivery_ms)]))],
          }
        ),
      ])
    );
  }

  // ── To be delivered tab ────────────────────────────────────────────────────
  // Per shipper (collapsed) → origin node → destination node: how many VRIDs
  // are still to be delivered. This tab has ITS OWN filters (shipper, origin
  // node, destination node, status), independent of the Summary filters, with
  // Status defaulting to IN_TRANSIT + PLANNED. The Summary's pick-up date still
  // sets the day (or tick "whole window").
  const TBD_DEFAULT_STATUSES = ["IN_TRANSIT", "PLANNED"];
  const _tf = {
    excl: { group: new Set(), shippername: new Set(), orig_node: new Set(), dest_node: new Set(), dest_country: new Set() },
    status: new Set(TBD_DEFAULT_STATUSES), // include-mode
  };

  function tbdRows() {
    const scope = _rows.filter(inPickupRange);
    return scope.filter((r) => _tf.status.has(r.status) && Object.keys(_tf.excl).every((k) => !_tf.excl[k].has(r[k] || "(none)")));
  }
  function resetTbdFilters() {
    for (const s of Object.values(_tf.excl)) s.clear();
    _tf.status = new Set(TBD_DEFAULT_STATUSES);
  }

  function renderToBeDelivered(view) {
    const scope = _rows.filter(inPickupRange);
    const rows = tbdRows();
    const onChange = ({ keepOpen } = {}) => { _openFilter = keepOpen ? keepOpen.getAttribute("data-key") : null; renderView(); };
    const ms = (label, key, opts) => {
      const node = multiSelect(label, key, countBy(scope, key), { onChange, ...opts });
      if (_openFilter === key) node.querySelector("details").open = true;
      return node;
    };
    view.appendChild(
      el("div", { class: "runs-filters", role: "group", "aria-label": "To be delivered filters" }, [
        ms("Group", "group", { set: _tf.excl.group }),
        ms("Shipper", "shippername", { set: _tf.excl.shippername }),
        ms("Origin node", "orig_node", { set: _tf.excl.orig_node }),
        ms("Destination node", "dest_node", { set: _tf.excl.dest_node }),
        ms("Destination country", "dest_country", { set: _tf.excl.dest_country }),
        ms("Status", "status", { set: _tf.status, mode: "include" }),
        pickupRangeFields(),
        el("span", { class: "runs-spacer" }),
        el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "Reset filters", onclick: () => { resetTbdFilters(); renderView(); } }),
      ])
    );
    _openFilter = null;

    // shipper → (origin, destination) lane → count
    const byShipper = new Map();
    for (const r of rows) {
      const s = byShipper.get(r.shippername) || { label: r.shippername, lanes: new Map(), n: 0, vrids: [] };
      const k = `${r.orig_node || "(none)"}\u0001${r.dest_node || "(none)"}`;
      const lane = s.lanes.get(k) || { orig: r.orig_node || "(none)", dest: r.dest_node || "(none)", n: 0, vrids: [] };
      lane.n += 1;
      lane.vrids.push(r);
      s.n += 1;
      s.vrids.push(r);
      s.lanes.set(k, lane);
      byShipper.set(r.shippername, s);
    }
    const shippers = [...byShipper.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    const groups = shippers.map((s) => ({
      label: s.label,
      totals: [s.n],
      children: [...s.lanes.values()]
        .sort((a, b) => b.n - a.n || a.orig.localeCompare(b.orig) || a.dest.localeCompare(b.dest))
        .map((l) => [l.orig, l.dest, vridLinks(l.vrids), l.n]),
    }));
    const lanes = groups.reduce((n, g) => n + g.children.length, 0);
    const destNodes = new Set(rows.map((r) => r.dest_node || "(none)")).size;

    view.appendChild(
      el("div", { class: "runs-kpis runs-kpis-row" }, [
        kpi("Yet to be delivered", rows.length, `${[..._tf.status].join(" + ") || "no status selected"}`, rows.length ? "runs-kpi-warn" : "runs-kpi-ok"),
        kpi("Shippers", shippers.length, fmtRange(), "runs-kpi-total"),
        kpi("Destination nodes", destNodes, `${lanes} lane${lanes === 1 ? "" : "s"}`, "runs-kpi-cst"),
      ])
    );

    const flat = () => groups.flatMap((g) => g.children.map((c) => [g.label, ...c]));
    const vridList = () => shippers.flatMap((s) => s.vrids.map((r) => [r.vrid, r.orderid, s.label, r.group, r.status, r.orig_node, r.dest_node, fmtStamp(r.pickup_ms), fmtStamp(r.delivery_ms)]));
    view.appendChild(
      el("div", { class: "runs-grid", style: "margin-top:14px" }, [
        panel(
          "Yet to be delivered — by shipper, origin node and destination node",
          treeTable("tbd", ["Shipper / Origin node", "Destination node", "VRIDs (open in FMC)", "Count"], groups, { grandTotal: [rows.length] }),
          {
            wide: true,
            note: "Click a shipper to see its origin → destination lanes and the VRIDs on each. Hover a VRID for its status and planned delivery.",
            tools: [
              ...treeTools("tbd"),
              csvBtn(`to-be-delivered-${rangeTag()}.csv`, ["Shipper", "Origin node", "Destination node", "VRIDs"], flat),
              csvBtn(`to-be-delivered-vrids-${rangeTag()}.csv`, ["VRID", "Order", "Shipper", "Group", "Status", "Origin node", "Destination node", "Pickup (planned)", "Delivery (planned)"], vridList),
            ],
          }
        ),
      ])
    );
  }

  /** The VRIDs on a lane as FMC links, status + planned delivery in the tooltip. */
  function vridLinks(list) {
    const wrap = el("span", { class: "runs-vrids" });
    [...list]
      .sort((a, b) => (a.delivery_ms || 0) - (b.delivery_ms || 0))
      .forEach((r) => {
        wrap.appendChild(
          el("a", {
            href: LINKS.vrid(r.vrid), target: "_blank", rel: "noopener", text: r.vrid,
            class: `runs-vrid ${isDone(r) ? "runs-vrid-ok" : r.status === "CANCELLED" ? "runs-vrid-cancel" : ""}`,
            title: `${r.status}${r.delivery_ms ? ` · delivery ${fmtStamp(r.delivery_ms)}` : ""}${r.carrier ? ` · ${r.carrier}` : ""}`,
          })
        );
      });
    return wrap;
  }

  // ── RLB tab ────────────────────────────────────────────────────────────────
  // Runs still on a placeholder carrier (SCAC RLB1 / DUMMY / AZNG = no real
  // carrier yet), i.e. what still needs sourcing. Own filters: SCAC
  // (include-mode, default = the placeholder carriers), execution status,
  // shipper, origin country, destination country; the shared pick-up range.
  const _rf = {
    scac: new Set(), // include-mode; filled from cfg on first use / reset
    excl: { group: new Set(), status: new Set(), shippername: new Set(), orig_country: new Set(), dest_country: new Set() },
  };
  function resetRlbFilters() {
    _rf.scac = new Set((_cfg && _cfg.placeholderCarriers) || ["RLB1", "DUMMY", "AZNG"]);
    for (const s of Object.values(_rf.excl)) s.clear();
  }
  let _rlbInit = false;
  function rlbRows(scope) {
    return scope.filter((r) => _rf.scac.has(r.scac) && Object.keys(_rf.excl).every((k) => !_rf.excl[k].has(r[k] || "(none)")));
  }
  const fmtPickup = (ms) => {
    if (!ms) return "";
    const d = new Date(ms);
    return `${fmtDay(d.toISOString().slice(0, 10))} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  };

  function renderRlb(view) {
    if (!_rlbInit) {
      resetRlbFilters();
      _rlbInit = true;
    }
    const scope = _rows.filter(inPickupRange);
    const rows = rlbRows(scope).sort((a, b) => (a.pickup_ms || 0) - (b.pickup_ms || 0) || a.shippername.localeCompare(b.shippername));
    const onChange = ({ keepOpen } = {}) => { _openFilter = keepOpen ? keepOpen.getAttribute("data-key") : null; renderView(); };
    const ms = (label, key, opts) => {
      const node = multiSelect(label, key, countBy(scope, key), { onChange, ...opts });
      if (_openFilter === key) node.querySelector("details").open = true;
      return node;
    };
    // SCAC options: the placeholders always listed (even at 0), plus whatever else is in scope.
    const scacCounts = countBy(scope, "scac");
    for (const p of (_cfg && _cfg.placeholderCarriers) || []) if (!scacCounts.has(p)) scacCounts.set(p, 0);
    view.appendChild(
      el("div", { class: "runs-filters", role: "group", "aria-label": "RLB filters" }, [
        (() => {
          const node = multiSelect("SCAC", "scac", scacCounts, { set: _rf.scac, mode: "include", onChange });
          if (_openFilter === "scac") node.querySelector("details").open = true;
          return node;
        })(),
        pickupRangeFields(),
        ms("Group", "group", { set: _rf.excl.group }),
        ms("Execution status", "status", { set: _rf.excl.status }),
        ms("Shipper", "shippername", { set: _rf.excl.shippername }),
        ms("Origin country", "orig_country", { set: _rf.excl.orig_country }),
        ms("Destination country", "dest_country", { set: _rf.excl.dest_country }),
        el("span", { class: "runs-spacer" }),
        el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "Reset filters", onclick: () => { resetRlbFilters(); renderView(); } }),
      ])
    );
    _openFilter = null;

    // left: count per SCAC · right: the runs
    const perScac = [...countBy(rows, "scac").entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const layout = el("div", { class: "runs-rlb" });
    view.appendChild(layout);
    layout.appendChild(
      panel(
        "Day",
        el("div", {}, [
          el("div", { class: "runs-kpis runs-kpis-col" }, perScac.length ? perScac.map(([s, n]) => kpi(s, n, null, "runs-kpi-d1")) : [kpi("RLB", 0, fmtRange(), "runs-kpi-ok")]),
          el("p", { class: "runs-note", style: "margin-top:8px", text: `${rows.length} run${rows.length === 1 ? "" : "s"} · ${fmtRange()}` }),
        ])
      )
    );
    const RLB_COLS = [
      ["shipperid", "shipperid", (r) => r.shipperid],
      ["shippername", "shippername", (r) => r.shippername],
      ["group", "group", (r) => groupPill(r.group)],
      ["vrid", "vrid", (r) => link(LINKS.vrid(r.vrid), r.vrid)],
      ["pickup", "orig_planned_yard_checkin_time", (r) => fmtPickup(r.pickup_ms)],
      ["scac", "vehicle_carrier", (r) => r.scac],
      ["lane", "facility_sequence", (r) => `${r.orig_node || "(none)"} → ${r.dest_node || "(none)"}`],
      ["load_type", "orig_load_type", (r) => r.load_type || "—"],
      ["status", "execution_status", (r) => statusPill(r)],
      ["orderid", "orderid", (r) => (r.orderid ? link(LINKS.orderid(r.orderid), r.orderid) : "")],
    ];
    const thead = el("thead", {}, [el("tr", {}, RLB_COLS.map(([, h]) => el("th", { text: h })))]);
    const tbody = el("tbody");
    for (const r of rows) tbody.appendChild(el("tr", {}, RLB_COLS.map(([, , fn]) => { const v = fn(r); return el("td", {}, [v instanceof Node ? v : document.createTextNode(str(v))]); })));
    layout.appendChild(
      panel(
        "RLB",
        rows.length ? el("div", { class: "runs-scroll runs-scroll-tall" }, [el("table", { class: "runs-table" }, [thead, tbody])]) : el("div", { class: "runs-empty", text: "No runs on the selected SCACs for this range." }),
        {
          note: `Runs whose FMC carrier is one of ${[..._rf.scac].join(", ") || "(none selected)"}, sorted by planned pick-up. orig_load_type is read from FMC best-effort and shows — when FMC didn't provide it.`,
          tools: [
            csvBtn(`rlb-${rangeTag()}.csv`, RLB_COLS.map(([, h]) => h), () =>
              rows.map((r) => [r.shipperid, r.shippername, r.group, r.vrid, fmtStamp(r.pickup_ms), r.scac, `${r.orig_node} -> ${r.dest_node}`, r.load_type, r.status, r.orderid])
            ),
          ],
        }
      )
    );
  }

  // ── Data tab ───────────────────────────────────────────────────────────────
  const DATA_COLS = [
    ["pickup_ms", "Pickup (planned)", (r) => fmtStamp(r.pickup_ms)],
    ["vrid", "VRID", (r) => link(LINKS.vrid(r.vrid), r.vrid)],
    ["orderid", "Order", (r) => (r.orderid ? link(LINKS.orderid(r.orderid), r.orderid) : "")],
    ["shippername", "Shipper", (r) => r.shippername],
    ["group", "Group", (r) => groupPill(r.group)],
    ["status", "Status", (r) => statusPill(r)],
    ["carrier", "Carrier", (r) => r.carrier],
    ["orig_country", "Orig", (r) => r.orig_country],
    ["dest_country", "Dest", (r) => r.dest_country],
    ["orig_node", "Origin node", (r) => r.orig_node],
    ["dest_node", "Dest node", (r) => r.dest_node],
    ["dest_type", "Dest type", (r) => r.dest_type],
    ["delivery_ms", "Delivery (planned)", (r) => fmtStamp(r.delivery_ms)],
    ["delivery_kind", "Delivery", (r) => r.delivery_kind],
    ["cancellation_reason", "Cancel reason", (r) => r.cancellation_reason],
    ["freight_type", "Freight", (r) => r.freight_type],
    ["in_fmc", "FMC", (r) => (r.in_fmc ? "✓" : "–")],
  ];
  const CSV_COLS = ["vrid", "orderid", "tour_id", "shipperid", "shippername", "group", "shipper_group_raw", "status", "cancellation_reason", "carrier", "orig_country", "orig_node", "dest_country", "dest_node", "dest_type", "pickup_date", "pickup_hour", "delivery_date", "delivery_kind", "freight_type", "equipment_type", "in_fmc"];

  function renderData(view) {
    const rows = dayRows().slice();
    const { key, dir } = _sort;
    rows.sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : str(x).localeCompare(str(y))) * dir;
    });
    const scope = el("span", { class: "runs-note", style: "margin:0", text: `pick-up ${fmtRange()}` });
    const thead = el("thead", {}, [
      el("tr", {}, DATA_COLS.map(([k, label]) =>
        el("th", {
          text: label,
          class: _sort.key === k ? (dir === 1 ? "runs-sorted" : "runs-sorted-desc") : "",
          onclick: () => { _sort = _sort.key === k ? { key: k, dir: -_sort.dir } : { key: k, dir: 1 }; renderView(); },
          "aria-sort": _sort.key === k ? (dir === 1 ? "ascending" : "descending") : "none",
        })
      )),
    ]);
    const tbody = el("tbody");
    for (const r of rows) tbody.appendChild(el("tr", {}, DATA_COLS.map(([, , fn]) => { const v = fn(r); return el("td", {}, [v instanceof Node ? v : document.createTextNode(str(v))]); })));
    view.appendChild(
      panel(
        `All data — ${rows.length} run${rows.length === 1 ? "" : "s"}`,
        rows.length ? el("div", { class: "runs-scroll runs-scroll-tall" }, [el("table", { class: "runs-table" }, [thead, tbody])]) : el("div", { class: "runs-empty", text: "Nothing matches the current filters." }),
        {
          wide: true,
          tools: [scope, csvBtn(`all-runs-${rangeTag()}.csv`, CSV_COLS, () => rows.map((r) => CSV_COLS.map((c) => (c === "in_fmc" ? (r.in_fmc ? "yes" : "no") : r[c]))))],
        }
      )
    );
  }

  // ── view ───────────────────────────────────────────────────────────────────
  function renderView() {
    const view = $("#runs-view");
    if (!view || !_cfg) return;
    view.innerHTML = "";
    if (!_rows.length && !_fetchedAt) {
      view.appendChild(el("div", { class: "runs-empty", text: _busy ? "Loading…" : "No data yet — press Refresh." }));
      return;
    }
    const tabs = el("div", { class: "runs-tabs", role: "tablist" });
    for (const [key, label] of [["summary", "Summary"], ["tbd", "To be delivered"], ["rlb", "RLB"], ["data", "All data"]]) {
      tabs.appendChild(
        el("button", {
          type: "button", role: "tab", class: `runs-tab${_tab === key ? " runs-tab-active" : ""}`, text: label,
          "aria-selected": _tab === key ? "true" : "false",
          onclick: () => {
            if (key !== _tab) {
              // Each tab starts from its own default filters.
              if (key === "tbd") resetTbdFilters();
              else if (key === "rlb") resetRlbFilters();
              else resetMainFilters();
            }
            _tab = key;
            renderView();
          },
        })
      );
    }
    view.appendChild(tabs);
    // The Summary / All data tabs share the QuickSight filter bar; To be
    // delivered has its own (shipper, origin node, destination node, status).
    if (_tab !== "tbd" && _tab !== "rlb") view.appendChild(renderFilters());
    const body = el("div", { role: "tabpanel" });
    view.appendChild(body);
    if (_tab === "summary") renderSummary(body);
    else if (_tab === "tbd") renderToBeDelivered(body);
    else if (_tab === "rlb") renderRlb(body);
    else renderData(body);
  }

  function renderStatusLine() {
    const n = $("#runs-status");
    if (!n) return;
    if (!_fetchedAt) {
      n.textContent = "";
      return;
    }
    const bits = [`updated ${fmtStamp(_fetchedAt)}`, `${_rows.length} runs in window`];
    if (_meta && _meta.fmcAsked) bits.push(`FMC ${_meta.fmcFound}/${_meta.fmcAsked}`);
    if (_meta && _meta.truncated) bits.push("⚠ SMC truncated");
    n.textContent = bits.join(" · ");
    n.title = _meta && _meta.truncated ? `SMC returned more orders than could be paged (${_meta.smc.fetched} of ${_meta.smc.total}). Counts are under-stated.` : "";
  }

  function renderShipperNote() {
    const node = $("#runs-shippers");
    if (!node) return;
    if (!_shippers) {
      node.textContent = "";
      return;
    }
    node.textContent = _shippers.count ? `CST shippers: ${_shippers.count}` : "CST shippers: none (everything is FTL)";
    node.title = _shippers.path || "";
  }

  function banner(kind, nodes, id) {
    const host = $("#runs-banners");
    if (!host) return;
    if (id) host.querySelectorAll(`[data-id="${id}"]`).forEach((n) => n.remove());
    const b = el("div", { class: `runs-banner runs-banner-${kind}`, role: kind === "error" ? "alert" : "status", "data-id": id || "" }, nodes);
    host.appendChild(b);
    return b;
  }
  const clearBanner = (id) => $("#runs-banners")?.querySelectorAll(`[data-id="${id}"]`).forEach((n) => n.remove());

  // ── remote control + identity ──────────────────────────────────────────────
  async function renderControl(refresh = false) {
    let s;
    try {
      s = await msg("controlStatus", { refresh });
    } catch (e) {
      dlog("controlStatus failed:", e && e.message);
      return true;
    }
    const idn = $("#runs-identity");
    if (idn) {
      idn.innerHTML = "";
      idn.appendChild(document.createTextNode("Alias: "));
      idn.appendChild(el("code", { text: s.alias || "unknown — open an SMC tab" }));
      idn.appendChild(document.createTextNode(" · Install: "));
      idn.appendChild(el("code", { text: s.installId || "?" }));
      const u = s.usage || {};
      idn.title = `First used ${u.firstSeen ? fmtTime(Date.parse(u.firstSeen)) : "—"} · last run ${u.lastRun ? fmtTime(Date.parse(u.lastRun)) : "—"} · ${u.runs || 0} run(s)`;
    }
    const v = s.verdict || { allowed: true };
    _blocked = !v.allowed;
    clearBanner("control");
    clearBanner("notice");
    if (v.allowed) {
      if (v.notice) banner("warn", [el("strong", { text: "Notice: " }), document.createTextNode(v.notice)], "notice");
    } else {
      banner("error", [
        el("strong", { text: "Disabled by the administrator." }),
        document.createTextNode(` (${v.reason}) ${v.message || ""} `),
        el("button", { type: "button", class: "runs-btn runs-gray runs-sm", text: "Re-check", onclick: () => renderControl(true) }),
      ], "control");
    }
    const btn = $("#runs-refresh");
    if (btn) btn.disabled = _blocked || _busy;
    return v.allowed;
  }

  // ── site access (host permissions) ─────────────────────────────────────────
  async function missingOrigins() {
    const missing = [];
    for (const o of (_cfg && _cfg.hostOrigins) || []) {
      const ok = await browser.permissions.contains({ origins: [o] }).catch(() => true);
      if (!ok) missing.push(o);
    }
    return missing;
  }
  async function checkPermissions() {
    const missing = await missingOrigins();
    clearBanner("perm");
    if (!missing.length) return true;
    const hosts = missing.map((o) => o.replace(/^https:\/\//, "").replace(/\/\*$/, ""));
    banner("error", [
      el("strong", { text: "Site access needed. " }),
      document.createTextNode("Firefox hasn't allowed this add-on on: "),
      ...hosts.flatMap((h, i) => [el("code", { text: h }), document.createTextNode(i < hosts.length - 1 ? ", " : " ")]),
      el("button", { type: "button", class: "runs-btn runs-sm", text: "Grant site access", onclick: grantAccess }),
      el("span", { text: "(or about:addons → All Runs → Permissions)", style: "color:var(--muted)" }),
    ], "perm");
    return false;
  }
  async function grantAccess() {
    try {
      if (!(await missingOrigins()).length) {
        // Firefox says access is granted yet refused to run on the tab: the tab
        // is most likely in a private window (add-on not allowed there) or the
        // add-on was loaded temporarily before its manifest gained the host.
        toast("Firefox already reports site access for all hosts. If the SharePoint/SMC/FMC tab is in a private window, open it in a normal window; if the add-on is loaded via about:debugging, reload it there.", "warn");
      }
      const ok = await browser.permissions.request({ origins: _cfg.hostOrigins || [] });
      if (ok) {
        toast("Site access granted", "success");
        clearBanner("perm");
        load();
      } else toast("Site access was declined", "warn");
    } catch (e) {
      toast(`Couldn't request site access: ${e.message}`, "error");
    }
  }

  // ── the load ───────────────────────────────────────────────────────────────
  async function load({ quiet = false } = {}) {
    if (_busy) return;
    if (_blocked) {
      toast("Disabled by the administrator", "error");
      return;
    }
    _busy = true;
    const btn = $("#runs-refresh");
    if (btn) btn.disabled = true;
    try {
      await runLoad(quiet && _rows.length > 0);
    } finally {
      _busy = false;
      if (btn) btn.disabled = _blocked;
      autoReset();
    }
  }

  /** Pipeline.fail options for a step error: Open-site buttons, Retry, and
   *  Grant site access when Firefox refused to run on the tab. */
  function failOpts(e, services, retry) {
    const perm = !!(e && e.permission) || /Missing host permission|site access/i.test(String((e && e.message) || ""));
    if (perm) checkPermissions();
    return { services: perm ? [] : services, onRetry: retry, onGrant: perm ? grantAccess : undefined };
  }

  async function runLoad(quiet) {
    const retry = () => load();
    Pipeline.begin(
      "Loading all runs",
      [
        { key: "sessions", label: "Sessions", hint: "SMC · FMC · SharePoint" },
        { key: "shippers", label: "CST shipper source of truth", hint: "tags each run CST / ELEX / FTL" },
        { key: "smc", label: "Fetch runs from SMC", hint: `every order with a VRID, yesterday → +${_daysForward} day${_daysForward === 1 ? "" : "s"}` },
        { key: "fmc", label: "Validate on FMC", hint: "status, planned times and stops per VRID" },
        { key: "build", label: "Build the dashboard", hint: "" },
      ],
      quiet ? "background refresh" : "",
      { quiet }
    );

    // remote control
    if (!(await renderControl(true))) {
      Pipeline.start("sessions", "remote control check…");
      Pipeline.fail("sessions", "Disabled by the administrator — see the banner.", { onRetry: retry });
      return;
    }

    // sessions
    Pipeline.start("sessions", "checking SMC, FMC and SharePoint…");
    let expired = [];
    let reasons = {};
    try {
      ({ expired, reasons = {} } = await msg("checkSessions", { services: ["SMC", "SharePoint", "FMC"] }));
    } catch (e) {
      expired = ["SMC", "SharePoint", "FMC"];
      const m = `session check failed: ${(e && e.message) || e}`;
      reasons = Object.fromEntries(expired.map((x) => [x, { message: m }]));
    }
    if (expired.length) {
      const detail = expired.map((x) => `${x}: ${(reasons[x] && reasons[x].message) || "sign-in required"}`).join("  ·  ");
      const needsGrant = expired.some((x) => reasons[x] && (reasons[x].permission || /Missing host permission|site access/i.test(reasons[x].message || "")));
      if (needsGrant) checkPermissions(); // shows the banner too
      Pipeline.fail("sessions", detail, {
        // Only offer "Open X" for real sign-in problems; a permission refusal
        // isn't fixed by opening the site.
        services: expired.filter((x) => !(reasons[x] && reasons[x].permission)),
        onRetry: retry,
        onGrant: needsGrant ? grantAccess : undefined,
      });
      return;
    }
    Pipeline.done("sessions", "SMC ✓ · FMC ✓ · SharePoint ✓");

    // shippers (tags only — the run continues without them)
    Pipeline.start("shippers", "reading source_of_truth_crawler.csv…");
    let shipperMap = {};
    try {
      _shippers = await msg("getShippers");
      shipperMap = _shippers.shippers || {};
      renderShipperNote();
      if (!_shippers.count) {
        toast("CST shipper CSV not found — every run will show as FTL", "warn");
        Pipeline.done("shippers", "not found — everything tagged FTL");
      } else Pipeline.done("shippers", `${_shippers.count} shippers from ${_shippers.path}`);
    } catch (e) {
      Pipeline.fail("shippers", String((e && e.message) || e), failOpts(e, ["SharePoint"], retry));
      return;
    }

    // SMC
    let win;
    try {
      win = await msg("runsWindow", { daysForward: _daysForward });
    } catch (e) {
      Pipeline.fail("smc", String((e && e.message) || e), { onRetry: retry });
      return;
    }
    Pipeline.start("smc", `${win.start} → ${win.end}…`);
    let rows;
    let meta;
    try {
      ({ rows, meta } = await msg("smcRows", { win: { start: win.start, end: win.end }, opts: win.smcOptions }));
    } catch (e) {
      Pipeline.fail("smc", String((e && e.message) || e), failOpts(e, ["SMC"], retry));
      return;
    }
    Pipeline.done("smc", `${rows.length} run${rows.length === 1 ? "" : "s"}${meta ? ` from ${meta.fetched} order${meta.fetched === 1 ? "" : "s"}` : ""}${meta && meta.truncated ? " — TRUNCATED" : ""}`);

    // FMC (chunked)
    const vrids = [...new Set(rows.map((r) => str(r.vrid).trim()).filter(Boolean))];
    Pipeline.start("fmc", vrids.length ? `0 / ${vrids.length} VRIDs…` : "nothing to validate");
    const byVrid = new Map();
    const chunk = _cfg.fmcChunk || 300;
    try {
      for (let i = 0; i < vrids.length; i += chunk) {
        const { records } = await msg("fmcStatuses", { vrids: vrids.slice(i, i + chunk) });
        for (const [vrid, rec] of Object.entries(records || {})) byVrid.set(vrid, rec);
        Pipeline.note(`${Math.min(i + chunk, vrids.length)} / ${vrids.length} VRIDs…`);
      }
    } catch (e) {
      Pipeline.fail("fmc", String((e && e.message) || e), failOpts(e, ["FMC"], retry));
      return;
    }
    let found = 0;
    for (const r of rows) {
      const rec = byVrid.get(str(r.vrid).trim());
      if (!rec) continue;
      found += 1;
      r._in_fmc = true;
      for (const f of FMC_FIELDS) if (rec[f] != null && rec[f] !== "") r[f] = rec[f];
    }
    Pipeline.done("fmc", `${found} of ${vrids.length} found in FMC`);

    // build
    Pipeline.start("build", "normalising…");
    _rows = normalise(rows, shipperMap, _cfg);
    _meta = { window: { start: win.start, end: win.end }, smc: meta, fmcAsked: vrids.length, fmcFound: found, truncated: !!(meta && meta.truncated) };
    _fetchedAt = Date.now();
    clearBanner("trunc");
    if (_meta.truncated) {
      banner("warn", [
        el("strong", { text: "SMC result truncated. " }),
        document.createTextNode(`SMC had ${meta.total} orders in the window but only ${meta.fetched} could be paged. Every count below is under-stated.`),
      ], "trunc");
    }
    msg("saveCache", { payload: { rows: _rows, meta: _meta, fetchedAt: _fetchedAt, shippers: _shippers ? { count: _shippers.count, path: _shippers.path } : null } }).catch((e) => dlog("saveCache failed:", e && e.message));
    Pipeline.done("build", `${_rows.length} runs`);
    Pipeline.finish();
    Pipeline.hide();
    renderStatusLine();
    renderView();
    if (quiet) toast(`Refreshed — ${dayRows().length} runs for ${fmtRange()}`, "success");
  }

  // ── auto refresh ───────────────────────────────────────────────────────────
  function autoReset() {
    _nextAutoAt = _autoMin > 0 ? Date.now() + _autoMin * 60_000 : 0;
    renderAutoStatus();
  }
  function renderAutoStatus() {
    const n = $("#runs-auto-next");
    if (!n) return;
    if (!_autoMin || !_nextAutoAt) {
      n.textContent = "";
      return;
    }
    const ms = _nextAutoAt - Date.now();
    n.textContent = _busy ? "refreshing…" : ms <= 0 ? "due" : `next in ${Math.ceil(ms / 60_000)}m`;
  }
  function autoTick() {
    renderAutoStatus();
    if (!_autoMin || !_nextAutoAt || Date.now() < _nextAutoAt) return;
    if (_busy || _blocked || document.hidden || Pipeline.isFailed()) return;
    load({ quiet: true });
  }
  async function setAuto(min) {
    _autoMin = Number(min) || 0;
    await browser.storage.local.set({ [AUTO_KEY]: _autoMin }).catch(() => {});
    autoReset();
  }
  async function setDaysForward(n) {
    _daysForward = Math.max(0, Number(n) || 0);
    await browser.storage.local.set({ [FWD_KEY]: _daysForward }).catch(() => {});
    load(); // the window changed → pull it now
  }
  async function loadDaysForward() {
    const def = _cfg.daysForward == null ? 1 : _cfg.daysForward;
    const max = _cfg.maxDaysForward || def;
    _daysForward = def;
    try {
      const got = await browser.storage.local.get(FWD_KEY);
      if (got[FWD_KEY] != null) _daysForward = Math.min(max, Math.max(0, Number(got[FWD_KEY]) || 0));
    } catch {
      /* default */
    }
    const sel = $("#runs-fwd");
    if (sel) {
      sel.innerHTML = "";
      for (let d = 1; d <= max; d++) sel.appendChild(el("option", { value: String(d), text: d === 1 ? "+1 day (tomorrow)" : `+${d} days` }));
      sel.value = String(Math.min(max, Math.max(1, _daysForward)));
    }
  }

  async function loadAuto() {
    const ar = _cfg.autoRefresh || { min: 5, max: 60, step: 5, default: 15 };
    _autoMin = ar.default;
    try {
      const got = await browser.storage.local.get(AUTO_KEY);
      if (got[AUTO_KEY] != null) _autoMin = Number(got[AUTO_KEY]) || 0;
    } catch {
      /* default */
    }
    const sel = $("#runs-auto");
    if (sel) {
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "0", text: "off" }));
      for (let m = ar.min; m <= ar.max; m += ar.step) sel.appendChild(el("option", { value: String(m), text: `${m} min` }));
      if (![0, ..._range(ar)].includes(_autoMin)) _autoMin = ar.default;
      sel.value = String(_autoMin);
    }
    autoReset();
  }
  const _range = (ar) => {
    const out = [];
    for (let m = ar.min; m <= ar.max; m += ar.step) out.push(m);
    return out;
  };

  // ── shell ──────────────────────────────────────────────────────────────────
  function buildShell() {
    document.body.appendChild(
      el("div", { id: "runs-app" }, [
        el("header", { class: "runs-header" }, [
          el("h1", { text: `All Runs v${browser.runtime.getManifest().version}` }),
          el("span", { class: "runs-badge", text: "SMC + FMC" }),
          el("span", { class: "runs-head-note runs-author" }, [
            document.createTextNode("author: mayowa babalola · alias: "),
            el("a", { href: "https://phonetool.amazon.com/users/mayowas", target: "_blank", rel: "noopener", text: "mayowas", title: "Open in Phone Tool" }),
          ]),
          el("span", { class: "runs-head-note", id: "runs-shippers" }),
          el("span", { class: "runs-head-note", id: "runs-status" }),
          el("span", { class: "runs-spacer" }),
          el("span", { class: "runs-head-note", id: "runs-identity" }),
          el("label", { class: "runs-auto", title: "How far ahead of today to pull from SMC. Yesterday is always included. A wider window means a longer load." }, [
            el("span", { text: "Days ahead" }),
            el("select", { id: "runs-fwd", "aria-label": "Days ahead to load", onchange: (e) => setDaysForward(e.target.value) }),
          ]),
          el("label", { class: "runs-auto" }, [
            el("span", { text: "Auto-refresh" }),
            el("select", { id: "runs-auto", "aria-label": "Auto-refresh interval", onchange: (e) => setAuto(e.target.value) }),
            el("span", { id: "runs-auto-next", "aria-live": "polite" }),
          ]),
          el("button", { type: "button", class: "runs-head-btn runs-primary", id: "runs-refresh", text: "↻ Refresh", onclick: () => load() }),
        ]),
        el("main", { class: "runs-body" }, [el("div", { id: "runs-banners" }), el("div", { id: "runs-view" })]),
        el("div", { class: "runs-loading", id: "runs-loading", role: "status", "aria-live": "polite" }, [
          el("div", { class: "runs-pipe-card", id: "runs-pipe-card" }, [
            el("div", { class: "runs-pipe-head" }, [
              el("div", { class: "runs-pipe-title", id: "runs-pipe-title", text: "Working…" }),
              el("div", { class: "runs-pipe-meta", id: "runs-pipe-meta" }),
            ]),
            el("div", { class: "runs-pipe-bar" }, [el("div", { class: "runs-pipe-fill", id: "runs-pipe-fill" })]),
            el("div", { class: "runs-pipe-stepno", id: "runs-pipe-stepno" }),
            el("ol", { class: "runs-pipe-steps", id: "runs-pipe-steps" }),
            el("div", { class: "runs-pipe-foot", id: "runs-pipe-foot", text: "The dashboard appears once every step is complete." }),
            el("div", { class: "runs-pipe-actions", id: "runs-pipe-actions" }),
          ]),
        ]),
      ])
    );
  }

  async function start() {
    buildShell();
    try {
      _cfg = await msg("getConfig");
    } catch (e) {
      banner("error", [el("strong", { text: "Couldn't reach the background: " }), document.createTextNode(String(e.message || e))], "boot");
      return;
    }
    for (const s of _cfg.defaultExcludedStatuses || []) _f.excl.status.add(s);
    document.title = `All Runs v${browser.runtime.getManifest().version} · ${_cfg.label}`;
    await loadAuto();
    await loadDaysForward();
    setInterval(autoTick, AUTO_TICK_MS);
    // Multi-select dropdowns close when you click outside them (or press Esc).
    document.addEventListener("pointerdown", (e) => {
      for (const d of document.querySelectorAll("details.runs-ms[open]")) if (!d.contains(e.target)) d.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") for (const d of document.querySelectorAll("details.runs-ms[open]")) d.open = false;
    });
    // Only one open at a time.
    document.addEventListener("toggle", (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("runs-ms") || !d.open) return;
      for (const o of document.querySelectorAll("details.runs-ms[open]")) if (o !== d) o.open = false;
    }, true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) autoTick();
    });

    // Paint the cached result straight away, then refresh.
    try {
      const cached = await msg("loadCache");
      if (cached && Array.isArray(cached.rows) && cached.rows.length) {
        _rows = cached.rows;
        _meta = cached.meta || null;
        _fetchedAt = cached.fetchedAt || 0;
        if (cached.shippers) _shippers = { count: cached.shippers.count, path: cached.shippers.path, shippers: {} };
        renderShipperNote();
        renderStatusLine();
      }
    } catch (e) {
      dlog("loadCache failed:", e && e.message);
    }
    renderView();

    const allowed = await renderControl(false);
    const perms = await checkPermissions();
    if (allowed && perms) load({ quiet: _rows.length > 0 });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
