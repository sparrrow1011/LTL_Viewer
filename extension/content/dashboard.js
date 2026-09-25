/**
 * Dashboard view — metrics + dependency-free SVG charts over the team's
 * SharePoint records (the durable history of manual-sourcing + email work, plus
 * the auto-tracked runs and their FMC outcomes).
 *
 * Layout: a shared control bar (activity date range, flag filters, export,
 * refresh) and sub-tabs:
 *   Overview  cards + outcome funnel + weekly trend charts
 *   Runs      every tracked run in range with its outcome (Open / Covered MS /
 *             Covered RLB), filterable
 *   Emails    email funnel + sent-per-day
 *   Users     by-user table
 *   Live      breakdown of what's on the Manual Sourcing board right now
 *
 * Exposed as window.__ltlDashboard.render(container, records, opts), where
 * `records` is the { "orderid|vrid": recordObj } map from getRecords.
 */
(function () {
  "use strict";

  // ── date helpers ────────────────────────────────────────────────────────────
  function parseDate(v) {
    if (!v) return null;
    const d = new Date(String(v).replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function dayKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // Sunday–Saturday week label "YYYY-Www" (matches the app's week convention).
  function weekKey(d) {
    const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
    const monday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1);
    const t = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
    const dayNum = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - dayNum + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
    const week = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  function truthy(v) {
    return v === true || ["1", "true", "yes"].includes(String(v).trim().toLowerCase());
  }
  function isoDay(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtLocal(iso) {
    const d = parseDate(iso);
    return d ? d.toLocaleString() : "";
  }
  function fmtHours(h) {
    if (h == null) return "–";
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} d`;
  }
  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ── record classification ───────────────────────────────────────────────────
  function isWorked(r) {
    return truthy(r.is_manual_source) || !!r.email_generated_at || truthy(r.email_sent);
  }
  // "open" | "covered_ms" | "covered_rlb"
  function outcomeOf(r) {
    if (!r.covered_at) return "open";
    return truthy(r.is_manual_source) ? "covered_ms" : "covered_rlb";
  }
  const OUTCOME_LABEL = { open: "Open", covered_ms: "Covered (MS)", covered_rlb: "Covered (RLB)" };
  const OUTCOME_BADGE = { open: "ltl-badge-yellow", covered_ms: "ltl-badge-green", covered_rlb: "ltl-badge-blue" };

  // ACTIVITY dates = things that happened to the run: we manual-sourced it,
  // generated / sent an email, or FMC reported it covered. Deliberately NOT
  // first_seen_at — merely appearing on the sourcing list is not activity, and
  // counting it made every listed run look "active" the moment it was tracked.
  function recordDates(r) {
    return [
      parseDate(r.manual_source_date),
      parseDate(r.email_generated_at),
      parseDate(r.email_sent_confirmed_at),
      parseDate(r.covered_at),
    ].filter(Boolean);
  }
  function latestActivity(r) {
    const ds = recordDates(r);
    if (ds.length) return Math.max(...ds.map((d) => d.getTime()));
    // Seen-only records have no activity; fall back to first seen for sorting.
    const seen = parseDate(r.first_seen_at);
    return seen ? seen.getTime() : 0;
  }

  // A run is "worked or covered" when someone did something to it (MS / email)
  // or FMC reported it covered. Everything else is a seen-only auto-tracked run
  // (it just appeared on the list) and is hidden by default.
  function isWorkedOrCovered(r) {
    return (
      truthy(r.is_manual_source) ||
      !!r.email_generated_at ||
      truthy(r.email_sent) ||
      !!r.covered_at
    );
  }

  // Planned origin yard check-in (the run's departure), as a Date or null.
  function plannedCheckin(r) {
    return parseDate(r.orig_planned_yard_checkin_time);
  }

  // Inclusive "is `d` inside {start,end}" where either bound may be null.
  function inWindow(d, range) {
    if (!range || (!range.start && !range.end)) return true;
    if (!d) return false;
    const t = d.getTime();
    const s = range.start ? range.start.getTime() : -Infinity;
    const e = range.end ? range.end.getTime() : Infinity;
    return t >= s && t <= e;
  }

  // Flag filters: { ms, gen, sent } each "" (any) | "yes" | "no".
  function matchesFlags(r, flags) {
    if (!flags) return true;
    const test = (v, actual) => (v === "yes" ? actual : v === "no" ? !actual : true);
    return (
      test(flags.ms, truthy(r.is_manual_source)) &&
      test(flags.gen, !!r.email_generated_at) &&
      test(flags.sent, truthy(r.email_sent))
    );
  }

  /**
   * Records → array filtered by:
   *   1. worked/covered only (default) — seen-only auto-tracked runs are
   *      excluded unless flags.includeSeen is true
   *   2. ACTIVITY date range (`range`): any MS / email / covered date in window
   *   3. PLANNED CHECKIN date range (flags.checkin {start,end}): the run's
   *      orig_planned_yard_checkin_time in window — independent of activity
   *   4. MS / Generated / Sent flag filters
   */
  function selectRecords(records, range, flags) {
    let rows = Object.values(records || {});

    if (!(flags && flags.includeSeen)) rows = rows.filter(isWorkedOrCovered);

    if (range && (range.start || range.end)) {
      rows = rows.filter((r) => {
        const dates = recordDates(r);
        if (dates.length) return dates.some((d) => inWindow(d, range));
        // Seen-only rows (only reachable with includeSeen) have no activity
        // dates: fall back to first_seen so the activity range still applies.
        return inWindow(parseDate(r.first_seen_at), range);
      });
    }

    const checkin = flags && flags.checkin;
    if (checkin && (checkin.start || checkin.end)) {
      rows = rows.filter((r) => inWindow(plannedCheckin(r), checkin));
    }

    if (flags) rows = rows.filter((r) => matchesFlags(r, flags));
    return rows;
  }

  // ── metrics ─────────────────────────────────────────────────────────────────
  function computeMetrics(records, range, flags) {
    const rows = selectRecords(records, range, flags);
    const m = {
      total: rows.length, // every tracked run in range (seen or worked)
      worked: 0, // MS or email activity
      manualSourced: 0,
      emailsGenerated: 0,
      emailsSent: 0,
      pending: 0, // generated but not sent
      totalCost: 0,
      costCount: 0,
      byUser: {}, // user -> { manual, sent }
      msPerWeek: {}, // weekKey -> count
      sentPerDay: {}, // dayKey -> count
      costPerWeek: {}, // weekKey -> total ms_cost
      seenPerWeek: {}, // weekKey -> runs first seen
      // outcomes (FMC sweep)
      open: 0,
      coveredMs: 0,
      coveredRlb: 0,
      msOpen: 0,
      byFinalCarrier: {}, // carrier -> count (all covered)
      coverHoursMs: [], // MS date → covered_at
      daysOnList: [], // first_seen → covered_at (all covered)
      runs: rows,
    };

    for (const r of rows) {
      const isMs = truthy(r.is_manual_source);
      const gen = !!r.email_generated_at;
      const sent = truthy(r.email_sent);
      if (isWorked(r)) m.worked += 1;
      if (isMs) m.manualSourced += 1;
      if (gen) m.emailsGenerated += 1;
      if (sent) m.emailsSent += 1;
      if (gen && !sent) m.pending += 1;

      const out = outcomeOf(r);
      if (out === "open") {
        m.open += 1;
        if (isMs) m.msOpen += 1;
      } else {
        if (out === "covered_ms") m.coveredMs += 1;
        else m.coveredRlb += 1;
        const c = String(r.final_carrier || "").trim() || "(unknown)";
        m.byFinalCarrier[c] = (m.byFinalCarrier[c] || 0) + 1;
        const cov = parseDate(r.covered_at);
        const seen = parseDate(r.first_seen_at);
        if (cov && seen && cov >= seen) m.daysOnList.push((cov - seen) / 86_400_000);
        const msd = parseDate(r.manual_source_date);
        if (isMs && cov && msd && cov >= msd) m.coverHoursMs.push((cov - msd) / 3_600_000);
      }

      const cost = parseFloat(r.ms_cost);
      const msd0 = parseDate(r.manual_source_date);
      if (!Number.isNaN(cost)) {
        m.totalCost += cost;
        m.costCount += 1;
        if (msd0) m.costPerWeek[weekKey(msd0)] = (m.costPerWeek[weekKey(msd0)] || 0) + cost;
      }
      if (isMs && r.manual_source_by) {
        const u = String(r.manual_source_by);
        (m.byUser[u] = m.byUser[u] || { manual: 0, sent: 0 }).manual += 1;
      }
      if (sent && r.email_sent_by) {
        const u = String(r.email_sent_by);
        (m.byUser[u] = m.byUser[u] || { manual: 0, sent: 0 }).sent += 1;
      }
      if (isMs && msd0) m.msPerWeek[weekKey(msd0)] = (m.msPerWeek[weekKey(msd0)] || 0) + 1;
      const sd = parseDate(r.email_sent_confirmed_at);
      if (sent && sd) m.sentPerDay[dayKey(sd)] = (m.sentPerDay[dayKey(sd)] || 0) + 1;
      const fs = parseDate(r.first_seen_at);
      if (fs) m.seenPerWeek[weekKey(fs)] = (m.seenPerWeek[weekKey(fs)] || 0) + 1;
    }
    m.covered = m.coveredMs + m.coveredRlb;
    m.avgCost = m.costCount ? m.totalCost / m.costCount : 0;
    m.sentRate = m.emailsGenerated ? (m.emailsSent / m.emailsGenerated) * 100 : 0;
    // Of the manual-sourced runs, how many FMC now shows covered.
    m.msCoverRate = m.manualSourced ? (m.coveredMs / m.manualSourced) * 100 : 0;
    // How often we had to step in: MS ÷ all tracked runs.
    m.interventionRate = m.total ? (m.manualSourced / m.total) * 100 : 0;
    m.medianCoverHoursMs = median(m.coverHoursMs);
    m.medianDaysOnList = median(m.daysOnList);
    return m;
  }

  // ── tiny DOM builder ──────────────────────────────────────────────────────
  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
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

  // ── charts (inline SVG) ─────────────────────────────────────────────────────
  // data: [{label, value}]. Vertical bars, value on top + label under each.
  // Sized to the data (one slot per bar) and capped, so a single bar renders
  // as a small chart rather than stretching across the panel.
  function barChart(data, { height = 180, color = "#2563eb", slot = 64, maxWidth = 640 } = {}) {
    const pad = { l: 8, r: 8, t: 18, b: 34 };
    const width = Math.min(maxWidth, pad.l + pad.r + Math.max(1, data.length) * slot);
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "ltl-chart" });
    if (!data.length) return svg;
    const cw = width - pad.l - pad.r;
    const ch = height - pad.t - pad.b;
    const max = Math.max(1, ...data.map((d) => d.value));
    const bw = cw / data.length;
    const barW = Math.min(40, bw * 0.62);
    data.forEach((d, i) => {
      const x = pad.l + i * bw + (bw - barW) / 2;
      const h = Math.round((d.value / max) * ch);
      const y = pad.t + (ch - h);
      svg.appendChild(svgEl("rect", { x, y, width: barW, height: h, rx: 3, fill: color }));
      const val = svgEl("text", { x: x + barW / 2, y: y - 5, "text-anchor": "middle", "font-size": 11, fill: "#334155" });
      val.textContent = d.value;
      svg.appendChild(val);
      const label = String(d.label);
      const l1 = svgEl("text", { x: x + barW / 2, y: height - 18, "text-anchor": "middle", "font-size": 10, fill: "#64748b" });
      if (label.length > 7) {
        l1.textContent = label.slice(0, 7);
        const l2 = svgEl("text", { x: x + barW / 2, y: height - 6, "text-anchor": "middle", "font-size": 10, fill: "#64748b" });
        l2.textContent = label.slice(7);
        svg.appendChild(l2);
      } else {
        l1.textContent = label;
      }
      svg.appendChild(l1);
    });
    return svg;
  }

  // funnel: [{label, value, color}] horizontal bars scaled to the max.
  function funnel(stages) {
    const wrap = el("div", { class: "ltl-funnel" });
    const max = Math.max(1, ...stages.map((s) => s.value));
    for (const s of stages) {
      const row = el("div", { class: "ltl-funnel-row" });
      row.appendChild(el("span", { class: "ltl-funnel-label", text: s.label }));
      const track = el("div", { class: "ltl-funnel-track" });
      const fill = el("div", { class: "ltl-funnel-fill" });
      fill.style.width = `${Math.round((s.value / max) * 100)}%`;
      fill.style.background = s.color;
      fill.appendChild(el("span", { class: "ltl-funnel-val", text: String(s.value) }));
      track.appendChild(fill);
      row.appendChild(track);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function card(label, value, sub) {
    return el("div", { class: "ltl-card" }, [
      el("div", { class: "ltl-card-val", text: String(value) }),
      el("div", { class: "ltl-card-lbl", text: label }),
      sub ? el("div", { class: "ltl-card-sub", text: sub }) : null,
    ]);
  }
  function section(title, body, note) {
    return el("div", { class: "ltl-dash-section" }, [
      el("h3", { class: "ltl-dash-title", text: title }),
      note ? el("div", { class: "ltl-dash-note", text: note }) : null,
      body,
    ]);
  }
  function empty(text) {
    return el("div", { class: "ltl-dash-empty ltl-dash-empty-sm", text });
  }
  function sortedSeries(obj, limit) {
    const keys = Object.keys(obj).sort(); // chronological (YYYY-... sorts right)
    const use = limit ? keys.slice(-limit) : keys;
    return use.map((k) => ({ label: k, value: obj[k] }));
  }
  function countBy(rows, field, blank = "(none)") {
    const out = {};
    for (const r of rows) {
      const v = r[field];
      const k = v == null || String(v).trim() === "" ? blank : String(v).trim();
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }
  function topSeries(obj, limit = 10) {
    return Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, value]) => ({ label, value }));
  }
  function simpleTable(headers, rows) {
    const table = el("table", { class: "ltl-dash-usertable" });
    table.appendChild(el("tr", {}, headers.map((h) => el("th", { text: h }))));
    for (const r of rows) table.appendChild(el("tr", {}, r.map((c) => (c instanceof Node ? el("td", {}, [c]) : el("td", { text: String(c ?? "") })))));
    return table;
  }

  // ── history CSV export ─────────────────────────────────────────────────────
  const HISTORY_COLUMNS = [
    "orderid", "vrid", "shippername", "shipper_group", "tour_id", "freight_type",
    "orig_node", "dest_node", "orig_country", "dest_country",
    "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time", "vehicle_carrier",
    "first_seen_at", "last_seen_at",
    "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
    "email_generated_at", "email_sent", "email_sent_count", "email_sent_confirmed_at", "email_sent_by",
    "outcome", "covered", "final_carrier", "final_carrier_name", "final_status", "covered_at", "outcome_checked_at",
  ];
  function historyCell(r, c) {
    if (c === "covered") return r.covered_at ? "yes" : "no";
    if (c === "outcome") return OUTCOME_LABEL[outcomeOf(r)];
    return r[c];
  }
  function csvCell(v) {
    if (v == null) return "";
    const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadHistoryCsv(rows, team, range) {
    const sorted = [...rows].sort((a, b) => latestActivity(b) - latestActivity(a));
    const lines = [
      HISTORY_COLUMNS.join(","),
      ...sorted.map((r) => HISTORY_COLUMNS.map((c) => csvCell(historyCell(r, c))).join(",")),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${team ? team.key : "LTL"}_History_${range.startStr || "all"}_${range.endStr || isoDay(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  const TABS = [
    ["overview", "Overview"],
    ["runs", "Runs"],
    ["emails", "Emails"],
    ["users", "Users"],
    ["live", "Live board"],
  ];

  function renderOverview(root, m) {
    root.appendChild(
      el("div", { class: "ltl-cards" }, [
        card("Runs tracked", m.total, _flags.includeSeen ? "worked, covered or seen in range" : "worked or covered in range"),
        card("Manual sourced", m.manualSourced, `${m.interventionRate.toFixed(0)}% of tracked`),
        card("Covered by MS", m.coveredMs, `${m.msCoverRate.toFixed(0)}% of manual sourced`),
        card("Covered by RLB", m.coveredRlb, "no intervention"),
        card("Still open", m.open, `${m.msOpen} of them manual sourced`),
        card("Time to cover (MS)", fmtHours(m.medianCoverHoursMs), "median, MS → carrier"),
        card("Days on list", m.medianDaysOnList == null ? "–" : m.medianDaysOnList.toFixed(1), "median, seen → covered"),
        card("Total cost", `€${m.totalCost.toFixed(2)}`, `avg €${m.avgCost.toFixed(2)}`),
      ])
    );
    const grid = el("div", { class: "ltl-dash-grid" });
    grid.appendChild(
      section(
        "Outcome",
        funnel([
          { label: "Tracked", value: m.total, color: "#64748b" },
          { label: "Manual sourced", value: m.manualSourced, color: "#7c3aed" },
          { label: "Covered (MS)", value: m.coveredMs, color: "#16a34a" },
          { label: "Covered (RLB)", value: m.coveredRlb, color: "#2563eb" },
          { label: "Open", value: m.open, color: "#f59e0b" },
        ])
      )
    );
    const carriers = topSeries(m.byFinalCarrier, 8);
    grid.appendChild(section("Covered by carrier", carriers.length ? barChart(carriers, { color: "#16a34a" }) : empty("Nothing covered yet in this range.")));
    grid.appendChild(section("Runs first seen per week", barChart(sortedSeries(m.seenPerWeek, 8), { color: "#64748b" })));
    grid.appendChild(section("Manual sourced per week", barChart(sortedSeries(m.msPerWeek, 8), { color: "#7c3aed" })));
    grid.appendChild(
      section(
        "Cost per week (€)",
        barChart(sortedSeries(m.costPerWeek, 8).map((d) => ({ label: d.label, value: Math.round(d.value) })), { color: "#0891b2" })
      )
    );
    root.appendChild(grid);
  }

  const _runsFilter = { outcome: "", worked: "" };
  function renderRuns(root, m, rerender, onToggle) {
    const bar = el("div", { class: "ltl-dash-subbar" });
    const sel = (key, options) => {
      const s = el("select", { class: "ltl-dash-flag" });
      for (const [v, t] of options) s.appendChild(el("option", { value: v, text: t }));
      s.value = _runsFilter[key];
      s.addEventListener("change", () => {
        _runsFilter[key] = s.value;
        rerender();
      });
      return s;
    };
    bar.appendChild(sel("outcome", [["", "Outcome: All"], ["open", "Open"], ["covered_ms", "Covered (MS)"], ["covered_rlb", "Covered (RLB)"]]));
    bar.appendChild(sel("worked", [["", "Runs: All"], ["worked", "Worked by us"], ["seen", "Seen only"]]));
    root.appendChild(bar);

    let rows = m.runs.filter((r) => !_runsFilter.outcome || outcomeOf(r) === _runsFilter.outcome);
    if (_runsFilter.worked === "worked") rows = rows.filter(isWorked);
    if (_runsFilter.worked === "seen") rows = rows.filter((r) => !isWorked(r));
    // Open first, then most recent activity.
    rows.sort((a, b) => {
      const ao = a.covered_at ? 1 : 0;
      const bo = b.covered_at ? 1 : 0;
      if (ao !== bo) return ao - bo;
      return latestActivity(b) - latestActivity(a);
    });

    const MAX = 300;
    const table = el("table", { class: "ltl-dash-usertable ltl-dash-runs" });
    const canToggle = typeof onToggle === "function";
    table.appendChild(
      el("tr", {}, ["Shipper", "VRID", "Lane", "First seen", "MS", "MS by", "MS at", "SIMS", "Outcome", "Carrier now", "Covered at"].map((h) => el("th", { text: h })))
    );
    for (const r of rows.slice(0, MAX)) {
      const out = outcomeOf(r);
      // Manual Source tick — the real workflow ticks AFTER the carrier is
      // assigned, so this must work on covered runs too.
      const msBox = el("input", { type: "checkbox", title: canToggle ? "Mark as manual sourced by us" : "" });
      msBox.checked = truthy(r.is_manual_source);
      msBox.disabled = !canToggle;
      if (canToggle) msBox.addEventListener("change", (e) => onToggle(e, r));
      const vrid = r.vrid
        ? el("a", {
            href: `https://trans-logistics-eu.amazon.com/fmc/execution/search/${encodeURIComponent(r.vrid)}`,
            target: "_blank", rel: "noopener noreferrer", class: "ltl-link", text: r.vrid,
          })
        : el("span");
      table.appendChild(
        el("tr", {}, [
          el("td", { text: r.shippername || "" }),
          el("td", {}, [vrid]),
          el("td", { text: r.orig_node || r.dest_node ? `${r.orig_node || "?"} → ${r.dest_node || "?"}` : "" }),
          el("td", { text: fmtLocal(r.first_seen_at) }),
          el("td", {}, [msBox]),
          el("td", { text: r.manual_source_by || "" }),
          el("td", { text: fmtLocal(r.manual_source_date) }),
          el("td", { text: r.sims || "" }),
          el("td", {}, [el("span", { class: `ltl-badge ${OUTCOME_BADGE[out]}`, text: OUTCOME_LABEL[out], title: r.final_status ? `FMC status: ${r.final_status}` : "" })]),
          // SCAC in the cell; full carrier name on hover.
          el("td", {
            text: r.covered_at ? r.final_carrier || "" : r.vehicle_carrier || "",
            title: r.covered_at ? r.final_carrier_name || "" : r.carrier_name || "",
          }),
          el("td", { text: fmtLocal(r.covered_at) }),
        ])
      );
    }
    const title = rows.length > MAX ? `Runs (showing ${MAX} of ${rows.length} — use Download CSV for all)` : `Runs (${rows.length})`;
    root.appendChild(section(title, rows.length ? table : empty("No runs match these filters.")));
  }

  function renderEmails(root, m) {
    root.appendChild(
      el("div", { class: "ltl-cards" }, [
        card("Emails generated", m.emailsGenerated),
        card("Emails sent", m.emailsSent),
        card("Sent rate", `${m.sentRate.toFixed(0)}%`, "sent ÷ generated"),
        card("Pending", m.pending, "generated, not sent"),
      ])
    );
    const grid = el("div", { class: "ltl-dash-grid" });
    grid.appendChild(
      section(
        "Email funnel",
        funnel([
          { label: "Generated", value: m.emailsGenerated, color: "#3b82f6" },
          { label: "Pending", value: m.pending, color: "#f59e0b" },
          { label: "Sent", value: m.emailsSent, color: "#16a34a" },
        ])
      )
    );
    grid.appendChild(section("Emails sent per day", barChart(sortedSeries(m.sentPerDay, 14), { color: "#16a34a", slot: 44 })));
    root.appendChild(grid);
  }

  function renderUsers(root, m) {
    const users = Object.entries(m.byUser).sort((a, b) => b[1].manual + b[1].sent - (a[1].manual + a[1].sent));
    root.appendChild(
      section(
        "By user",
        users.length
          ? simpleTable(["User", "Manual sourced", "Emails sent"], users.map(([u, c]) => [u, c.manual, c.sent]))
          : empty("No user activity in this range.")
      )
    );
  }

  // Live board: breakdown of the rows currently loaded in Manual Sourcing
  // (this team's SMC window, FMC-validated). Not stored anywhere.
  function renderLive(root, rows, team) {
    const n = rows ? rows.length : 0;
    if (!rows) {
      root.appendChild(empty("Open the Manual Sourcing tab first to load the board."));
      return;
    }
    root.appendChild(el("div", { class: "ltl-dash-note", text: `${n} load(s) needing sourcing in the Manual Sourcing tab's current date window (SMC + FMC). Not stored.` }));
    if (!n) {
      root.appendChild(empty("Nothing loaded yet — open Manual Sourcing (or widen its date window) and come back."));
      return;
    }
    const byStatus = countBy(rows, "vehicle_execution_status", "(no status)");
    const byCountry = countBy(rows, "orig_country", "(no country)");
    const byCarrier = countBy(rows, "vehicle_carrier", "(no carrier)");
    const byShipper = countBy(rows, "shippername", "(no shipper)");
    const uniqueOrders = new Set(rows.map((r) => String(r.orderid ?? ""))).size;
    const cards = [card("Loads (VRIDs)", n), card("Orders", uniqueOrders), card("Planned", byStatus.PLANNED || 0, "FMC status"), card("Countries", Object.keys(byCountry).length)];
    let byGroup = null;
    if (team && (team.shipperList || team.shipperSource)) {
      byGroup = countBy(rows, "shipper_group", "(no group)");
      const top = topSeries(byGroup, 1)[0];
      cards.push(card("Shipper groups", Object.keys(byGroup).length, top ? `top: ${top.label} (${top.value})` : ""));
    }
    root.appendChild(el("div", { class: "ltl-cards" }, cards));
    const grid = el("div", { class: "ltl-dash-grid" });
    grid.appendChild(section("By status", barChart(topSeries(byStatus, 8), { color: "#2563eb" })));
    grid.appendChild(section("By origin country", barChart(topSeries(byCountry, 8), { color: "#0891b2" })));
    if (byGroup) grid.appendChild(section("By shipper group", barChart(topSeries(byGroup, 8), { color: "#7c3aed" })));
    grid.appendChild(section("By carrier", barChart(topSeries(byCarrier, 8), { color: "#f59e0b" })));
    root.appendChild(grid);
    root.appendChild(section("Top shippers", simpleTable(["Shipper", "Loads"], topSeries(byShipper, 10).map((d) => [d.label, d.value]))));
  }

  // ── public render ─────────────────────────────────────────────────────────
  // UI state kept across re-renders: activity date range, planned-checkin date
  // range, flag filters (incl. the seen-only toggle), active tab.
  let _range = null; // ACTIVITY window   { startStr, endStr }
  let _checkin = null; // PLANNED CHECKIN window { startStr, endStr } (empty = any)
  const _flags = { ms: "", gen: "", sent: "", includeSeen: false, checkin: null };
  let _tab = "overview";

  // {startStr,endStr} → {start:Date|null, end:Date|null} (whole local days).
  function toDateRange(r) {
    return {
      start: r && r.startStr ? new Date(`${r.startStr}T00:00:00`) : null,
      end: r && r.endStr ? new Date(`${r.endStr}T23:59:59`) : null,
    };
  }

  /**
   * @param {HTMLElement} container
   * @param {object} records   { "orderid|vrid": record } for the team
   * @param {object} [opts]
   * @param {Function} [opts.onRefresh]
   * @param {Function} [opts.onManualSourceToggle]  (event, record) → Promise; enables the MS tick on the Runs tab
   * @param {object}   [opts.team]      selected team config
   * @param {object[]} [opts.liveRows]  rows currently loaded in Manual Sourcing
   */
  function render(container, records, opts = {}) {
    const onRefresh = typeof opts.onRefresh === "function" ? opts.onRefresh : null;
    const onToggleMs = typeof opts.onManualSourceToggle === "function" ? opts.onManualSourceToggle : null;
    const team = opts.team || null;
    const liveRows = Array.isArray(opts.liveRows) ? opts.liveRows : null;
    if (!_range) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      _range = { startStr: isoDay(start), endStr: isoDay(end) };
    }

    if (!_checkin) _checkin = { startStr: "", endStr: "" };

    function doRender() {
      const range = toDateRange(_range);
      _flags.checkin = toDateRange(_checkin);
      const m = computeMetrics(records, range, _flags);
      container.innerHTML = "";
      const root = el("div", { class: "ltl-dash" });

      // One labelled date row: [label] [start] → [end] [presets…]. `state` is
      // the {startStr,endStr} object it edits. `presets` = [[label, days|null]];
      // days=null clears the range ("All" / "Any"), days=N = last N days,
      // and for the planned-checkin row a `forward` preset spans N days AHEAD.
      const dateRow = (label, state, presets, { forward = false } = {}) => {
        const row = el("div", { class: "ltl-dash-daterow" });
        row.appendChild(el("span", { class: "ltl-dash-ctl-label", text: label }));
        const startInput = el("input", { type: "date", value: state.startStr || "" });
        const endInput = el("input", { type: "date", value: state.endStr || "" });
        startInput.addEventListener("change", () => { state.startStr = startInput.value; doRender(); });
        endInput.addEventListener("change", () => { state.endStr = endInput.value; doRender(); });
        row.appendChild(startInput);
        row.appendChild(el("span", { text: "→" }));
        row.appendChild(endInput);
        const pr = el("div", { class: "ltl-dash-presets" });
        for (const [text, days] of presets) {
          const b = el("button", { class: "ltl-preset", text });
          b.addEventListener("click", () => {
            if (days == null) {
              state.startStr = "";
              state.endStr = "";
            } else {
              const a = new Date();
              const z = new Date();
              if (forward) z.setDate(z.getDate() + days); // today → +N days
              else a.setDate(a.getDate() - days); //        -N days → today
              state.startStr = isoDay(a);
              state.endStr = isoDay(z);
            }
            doRender();
          });
          pr.appendChild(b);
        }
        row.appendChild(pr);
        return row;
      };

      // ── control bar (shared by all tabs) ──
      const controls = el("div", { class: "ltl-dash-controls" });

      // Row 1: ACTIVITY date — when we worked the run / FMC covered it.
      controls.appendChild(
        dateRow("Activity date:", _range, [["Today", 0], ["7d", 7], ["30d", 30], ["90d", 90], ["All", null]])
      );
      // Row 2: PLANNED CHECKIN — the run's departure (orig_planned_yard_checkin_time).
      // Presets look FORWARD because you plan upcoming departures; "Any" clears.
      controls.appendChild(
        dateRow(
          "Planned checkin:",
          _checkin,
          [["Today", 0], ["Next 7d", 7], ["Next 14d", 14], ["Next 30d", 30], ["Any", null]],
          { forward: true }
        )
      );

      const flagSel = (key, label) => {
        const sel = el("select", { class: "ltl-dash-flag", title: label });
        for (const [v, t] of [["", "Any"], ["yes", "Yes"], ["no", "No"]]) sel.appendChild(el("option", { value: v, text: `${label}: ${t}` }));
        sel.value = _flags[key];
        sel.addEventListener("change", () => { _flags[key] = sel.value; doRender(); });
        return sel;
      };
      controls.appendChild(flagSel("ms", "MS"));
      controls.appendChild(flagSel("gen", "Generated"));
      controls.appendChild(flagSel("sent", "Sent"));

      // Seen-only toggle. Default OFF: the dashboard counts only runs that were
      // worked (MS / email) or that FMC reported covered. Turn on to also show
      // auto-tracked runs that merely appeared on the list.
      const seenWrap = el("label", {
        class: "ltl-dash-seen",
        title: "Also include runs that only appeared on the sourcing list (never worked, not yet covered)",
      });
      const seenCb = el("input", { type: "checkbox" });
      seenCb.checked = !!_flags.includeSeen;
      seenCb.addEventListener("change", () => { _flags.includeSeen = seenCb.checked; doRender(); });
      seenWrap.appendChild(seenCb);
      seenWrap.appendChild(el("span", { text: " Include seen-only" }));
      controls.appendChild(seenWrap);

      const spacer = el("span");
      spacer.style.flex = "1";
      controls.appendChild(spacer);

      const exportBtn = el("button", { class: "ltl-btn", text: `⬇ Download CSV (${m.total})`, title: "Export the records matching the date range and flag filters" });
      exportBtn.disabled = !m.total;
      exportBtn.addEventListener("click", () => downloadHistoryCsv(selectRecords(records, range, _flags), team, _range));
      controls.appendChild(exportBtn);
      if (onRefresh) {
        const refreshBtn = el("button", { class: "ltl-btn ltl-gray", text: "↻ Refresh", title: "Re-check outcomes on FMC and re-read SharePoint records" });
        refreshBtn.addEventListener("click", () => onRefresh());
        controls.appendChild(refreshBtn);
      }
      root.appendChild(controls);

      // ── sub-tabs ──
      const tabs = el("div", { class: "ltl-dash-tabs", role: "tablist" });
      for (const [key, label] of TABS) {
        const b = el("button", {
          class: "ltl-dash-tab" + (key === _tab ? " ltl-dash-tab-active" : ""),
          role: "tab",
          "aria-selected": key === _tab ? "true" : "false",
          text: key === "runs" ? `${label} (${m.total})` : label,
        });
        b.addEventListener("click", () => { _tab = key; doRender(); });
        tabs.appendChild(b);
      }
      root.appendChild(tabs);

      // ── tab body ──
      const body = el("div", { class: "ltl-dash-body", role: "tabpanel" });
      const noRecords = !m.total && _tab !== "live";
      if (noRecords) {
        body.appendChild(el("div", {
          class: "ltl-dash-empty",
          text: "No worked or covered runs match — widen the Activity / Planned checkin dates, click ‘All’ / ‘Any’, or tick ‘Include seen-only’.",
        }));
      } else if (_tab === "overview") renderOverview(body, m);
      else if (_tab === "runs") renderRuns(body, m, doRender, onToggleMs);
      else if (_tab === "emails") renderEmails(body, m);
      else if (_tab === "users") renderUsers(body, m);
      else if (_tab === "live") renderLive(body, liveRows, team);
      root.appendChild(body);
      container.appendChild(root);
    }

    doRender();
  }

  window.__ltlDashboard = { render, computeMetrics, selectRecords, outcomeOf };
})();
