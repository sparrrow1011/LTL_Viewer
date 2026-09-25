/**
 * Sweeper page — the replacement for CST_viewer's sweeper.html.
 *
 * Talks to the background only via messages; renders whatever it stored last
 * (browser.storage) and re-renders when storage changes (so a scheduled run
 * updates an open page).
 */
import { CASE_COLUMNS, rowsToCsv } from "../shared/signals.js";

const $ = (id) => document.getElementById(id);

// ── page-side log (merged into the Log tab with the background's) ──────────
const uiLog = [];
function ulog(level, msg) {
  uiLog.push({ t: Date.now(), level, scope: "ui", msg });
  if (uiLog.length > 200) uiLog.shift();
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)("[LobbySweeper ui]", msg);
  if (typeof renderLog === "function") scheduleLogRender();
}

const NO_LISTENER = /Receiving end does not exist|Could not establish connection/i;
// Never auto-retry these: a retry could start a second run.
const NO_RETRY = new Set(["runSweep", "runLobby", "runCycle", "importShippers", "saveSettings"]);

async function call(action, payload = {}) {
  let resp;
  const t0 = Date.now();
  try {
    resp = await browser.runtime.sendMessage({ action, ...payload });
  } catch (e) {
    if (!NO_LISTENER.test(String(e && e.message))) throw e;
    if (NO_RETRY.has(action)) {
      ulog("error", `${action}: background unreachable (${e.message})`);
      const err = new Error("The extension background didn't answer. Reload this page (and the add-on if that doesn't help).");
      err.orphaned = true;
      throw err;
    }
    // Firefox event page may still be waking up — give it one more shot.
    ulog("warn", `${action}: no background listener (${e.message}) — retrying in 700ms`);
    await new Promise((r) => setTimeout(r, 700));
    try {
      resp = await browser.runtime.sendMessage({ action, ...payload });
    } catch (e2) {
      // Thrown (not returned) by the page's own sendMessage = the background
      // has no listener for us: the extension was reloaded/updated while this
      // page stayed open, or the background script failed to start.
      ulog("error", `${action}: background unreachable after retry (${e2.message})`);
      const err = new Error(
        "This page lost its connection to the extension (it was reloaded/updated, or the background script failed to start — check about:debugging → Inspect for a red error)."
      );
      err.orphaned = true;
      throw err;
    }
  }
  if (!resp) throw new Error(`No response for ${action}`);
  if (action !== "getLog" && action !== "getState") {
    ulog(resp.ok ? "info" : "error", `${action} → ${resp.ok ? "ok" : `FAILED: ${resp.error}`} (${Date.now() - t0}ms)`);
  }
  if (!resp.ok) {
    const err = new Error(resp.error || `${action} failed`);
    err.expired = !!resp.expired;
    err.controlBlocked = !!resp.controlBlocked;
    err.status = resp.status;
    throw err;
  }
  return resp.data;
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const app = {
  config: null,
  settings: null,
  state: null,
  sweepSort: { key: "QueueStatus", dir: "asc" },
  alertSort: { key: "type", dir: "asc" },
  lobbySort: { key: "Creation Date", dir: "desc" },
  alertTypeFilter: null,
};

// ── banner / busy ──────────────────────────────────────────────────────────

function banner(kind, html) {
  const el = $("banner");
  if (!html) {
    el.hidden = true;
    el.className = "banner";
    el.innerHTML = "";
    return;
  }
  el.className = `banner ${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}

function setBusy(text) {
  const el = $("busy");
  el.hidden = !text;
  $("busyText").textContent = text || "";
  // Run sweep / Run SLA check stay disabled permanently (single-job runs are
  // retired in favour of Run both); only these two toggle with busy state.
  $("btnCheckSessions").disabled = !!text;
  $("btnRunCycle").disabled = !!text || app.controlBlocked === true;
  if (text) {
    // Re-enable Stop for a new run unless a stop is already pending.
    const stopping = /stopping after this batch/i.test(text);
    $("btnStop").disabled = stopping;
    $("btnStop").textContent = stopping ? "Stopping…" : "Stop";
  }
}

function describeError(e, what) {
  if (e.controlBlocked) {
    return `<strong>Disabled by the administrator.</strong> ${esc(e.message)} <button type="button" class="btn btn-ghost" data-act="control-refresh">Re-check</button>`;
  }
  if (e.orphaned) {
    return `${esc(e.message)} <button type="button" class="btn btn-ghost" data-act="reload-page">Reload this page</button>`;
  }
  if (/Site access not granted|Missing host permission/i.test(e.message)) {
    return `${what} stopped: Firefox hasn't allowed the add-on on one of the sites. <button type="button" class="btn btn-primary" data-act="grant-access">Grant site access</button> <span class="muted">${esc(e.message)}</span>`;
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(e.message)) {
    return `${what} failed: a Paragon or SMC tab had no working bridge (usually a tab opened before the extension was loaded or reloaded). Close the Paragon/SMC tabs and retry — fresh ones are opened automatically. <span class="muted">${esc(e.message)}</span>`;
  }
  if (e.expired) {
    return `${what} stopped: a session has expired. <button type="button" class="btn btn-primary" data-act="recheck">Check sessions</button> to open the sign-in tabs, then retry. <span class="muted">${esc(e.message)}</span>`;
  }
  return `${what} failed: ${esc(e.message)}`;
}

// ── tabs ───────────────────────────────────────────────────────────────────

function showTab(name) {
  for (const b of document.querySelectorAll(".tab")) {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const n of ["sweep", "lobby", "settings", "log"]) $(`tab-${n}`).hidden = n !== name;
  if (name === "log") renderLog();
}

// ── log tab ────────────────────────────────────────────────────────────────

let bgLog = { lines: [], instance: null, debug: false };
let logRenderTimer = null;
function scheduleLogRender() {
  if (logRenderTimer) return;
  logRenderTimer = setTimeout(() => {
    logRenderTimer = null;
    renderLog();
  }, 150);
}

async function fetchLog() {
  try {
    bgLog = await call("getLog");
  } catch (e) {
    ulog("warn", `getLog failed: ${e.message}`);
  }
  renderLog();
}

function renderLog() {
  const view = $("logView");
  if (!view) return;
  const errorsOnly = $("logErrorsOnly").checked;
  const pipelineOnly = $("logPipelineOnly").checked;
  const all = [...bgLog.lines, ...uiLog].sort((a, b) => a.t - b.t);
  let shown = all;
  if (pipelineOnly) shown = shown.filter((l) => l.scope === "pipeline" || l.level === "warn" || l.level === "error");
  if (errorsOnly) shown = shown.filter((l) => l.level === "warn" || l.level === "error");
  const fmt = (l) => {
    const d = new Date(l.t);
    const hh = d.toLocaleTimeString([], { hour12: false });
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `<span class="l-${esc(l.level)}${l.scope === "ui" ? " l-ui" : ""}">${hh}.${ms} ${esc(l.level.padEnd(5))} ${esc(l.scope.padEnd(14))} ${esc(l.msg)}</span>`;
  };
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
  view.innerHTML = shown.map(fmt).join("\n") || '<span class="muted">(empty)</span>';
  if (atBottom) view.scrollTop = view.scrollHeight;
  const errs = all.filter((l) => l.level === "error").length;
  $("logCount").textContent = errs || "";
  $("logCount").className = `count ${errs ? "bad" : ""}`;
  $("logMeta").textContent = `${all.length} lines · background instance ${bgLog.instance ? new Date(bgLog.instance).toLocaleTimeString() : "?"} · debug ${bgLog.debug ? "on" : "off"}`;
}

function logAsText() {
  const all = [...bgLog.lines, ...uiLog].sort((a, b) => a.t - b.t);
  return all.map((l) => `${new Date(l.t).toISOString()} ${l.level.padEnd(5)} ${l.scope.padEnd(14)} ${l.msg}`).join("\n");
}

// ── generic sortable table ─────────────────────────────────────────────────

function sortRows(rows, sort) {
  if (!sort.key) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key] ?? "";
    const bv = b[sort.key] ?? "";
    const an = parseFloat(av);
    const bn = parseFloat(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && String(av).trim() !== "" && String(bv).trim() !== "") {
      return (an - bn) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function renderTable({ headEl, bodyEl, columns, rows, sort, onSort }) {
  headEl.innerHTML = columns
    .map((c) => {
      const active = sort.key === c.key;
      const dir = active ? (sort.dir === "asc" ? "▲" : "▼") : "";
      return `<th data-key="${esc(c.key)}" scope="col" aria-sort="${active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}">${esc(c.label)}<span class="dir">${dir}</span></th>`;
    })
    .join("");
  for (const th of headEl.querySelectorAll("th")) {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
      else {
        sort.key = key;
        sort.dir = "asc";
      }
      onSort();
    });
  }
  const sorted = sortRows(rows, sort);
  bodyEl.innerHTML = sorted
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => `<td class="${c.wrap ? "wrap" : ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`)
          .join("")}</tr>`
    )
    .join("");
}

const caseLink = (id) =>
  id
    ? `<a href="${esc(app.config.caseUrlTemplate.replace("__ID__", encodeURIComponent(id)))}" target="_blank" rel="noopener">${esc(id)}</a>`
    : "";

const statusPill = (r) =>
  r.QueueStatus === "good"
    ? `<span class="pill pill-good" title="In a CST queue">good</span>`
    : `<span class="pill pill-warn" title="NOT in a CST queue">check</span>`;

const sevPill = (s) => {
  const n = parseInt(s, 10);
  const cls = n === 1 ? "pill-bad" : n === 2 || n === 3 ? "pill-warn" : "pill-muted";
  return s === "" || s == null ? "" : `<span class="pill ${cls}">${esc(s)}</span>`;
};

// ── sweep tab ──────────────────────────────────────────────────────────────

// CST-link check: "yes" when the case's Merchant ID is a CST shipper ID, or
// its subject carries one of our order IDs / VRIDs (all from CST shippers).
const LINK_LABEL = { merchant: "merchant ID", vrid: "VRID", order: "order ID" };
const cstPill = (r) =>
  r.CstCheck === "yes"
    ? `<span class="pill pill-good" title="linked via ${esc(LINK_LABEL[r.cstLink] || r.cstLink)}">yes · ${esc(LINK_LABEL[r.cstLink] || "")}</span>`
    : `<span class="pill pill-bad" title="Merchant ID not in the CST shipper list and no CST order/VRID in the subject">no</span>`;

const SWEEP_COLUMNS = [
  { key: "QueueStatus", label: "Queue check", render: statusPill },
  { key: "CstCheck", label: "CST-linked", render: cstPill },
  { key: "ID", label: "Case", render: (r) => caseLink(r.ID) },
  { key: "Queue", label: "Queue" },
  { key: "Status", label: "Status" },
  { key: "Severity", label: "Sev", render: (r) => sevPill(r.Severity) },
  { key: "Owner", label: "Owner" },
  { key: "Merchant ID", label: "Merchant ID (Paragon)" },
  { key: "shipperid", label: "Shipper ID (SMC)" },
  { key: "shipper", label: "Shipper" },
  { key: "orderid", label: "Order ID" },
  { key: "vrid", label: "VRID" },
  { key: "fmc_status", label: "FMC status" },
  { key: "lane", label: "Lane (SMC)" },
  { key: "Subject", label: "Subject", wrap: true },
  { key: "Creation Date", label: "Created" },
  { key: "Last Inbound Date", label: "Last inbound" },
  { key: "Last Outbound Date", label: "Last outbound" },
];

function sweepRows() {
  const s = app.state && app.state.lastSweep;
  return (s && s.rows) || [];
}

function filteredSweepRows() {
  const q = $("sweepSearch").value.trim().toLowerCase();
  const f = $("sweepFilter").value;
  const cst = $("sweepCstFilter").value;
  return sweepRows().filter((r) => {
    if (f && r.QueueStatus !== f) return false;
    if (cst && (r.CstCheck || "no") !== cst) return false;
    if (!q) return true;
    return SWEEP_COLUMNS.some((c) => String(r[c.key] ?? "").toLowerCase().includes(q));
  });
}

function renderSweep() {
  const s = app.state && app.state.lastSweep;
  const stats = $("sweepStats");
  if (!s) {
    stats.innerHTML = "";
    $("sweepEmpty").hidden = false;
    $("sweepTable").hidden = true;
    $("sweepCount").textContent = "";
    $("sweepShown").textContent = "";
    return;
  }
  const win = s.window ? `${s.window.start.slice(0, 10)} → ${s.window.end.slice(0, 10)}` : "";
  stats.innerHTML = [
    stat("Last run", fmtTime(s.finishedAt || s.at), win),
    stat("CST shippers", s.shippers ? s.shippers.count : "—", s.shippers ? s.shippers.source : ""),
    stat("SMC orders", s.orders, s.truncated ? `TRUNCATED of ${s.ordersTotal}` : `${s.orderCount ?? "—"} order IDs`, s.truncated ? "bad" : ""),
    stat("VRIDs", s.vridCount ?? "—", `${s.fmcConfirmed ?? "—"} confirmed in FMC`),
    stat("Paragon ids", s.pairCount, `${s.batches} batch(es) of 35`),
    stat("Open cases", s.openCount ?? s.rows.length, `${s.closedCount ?? 0} resolved${s.excludedCount ? `, ${s.excludedCount} excluded` : ""} removed`),
    stat("CST-linked", s.linkedCount ?? "—", `${(s.openCount ?? s.rows.length) - (s.linkedCount ?? 0)} not linked`),
    stat("Wrong queue", s.flaggedCount, "check", s.flaggedCount ? "warn" : ""),
    s.failedBatches.length ? stat("Failed batches", s.failedBatches.length, s.failedBatches.join(", "), "bad") : "",
  ].join("");
  $("sweepCount").textContent = s.flaggedCount || "";
  $("sweepCount").className = `count ${s.flaggedCount ? "warn" : ""}`;

  const rows = filteredSweepRows();
  $("sweepEmpty").hidden = true;
  $("sweepTable").hidden = false;
  $("sweepShown").textContent = `${rows.length} of ${s.rows.length}`;
  renderTable({
    headEl: $("sweepHead"),
    bodyEl: $("sweepBody"),
    columns: SWEEP_COLUMNS,
    rows,
    sort: app.sweepSort,
    onSort: renderSweep,
  });
}

function stat(label, value, sub = "", cls = "") {
  return `<div class="stat ${cls}"><b>${esc(value ?? "—")}</b><span>${esc(label)}${sub ? ` · ${esc(sub)}` : ""}</span></div>`;
}

function downloadSweepCsv() {
  const rows = filteredSweepRows();
  if (!rows.length) return banner("warn", "Nothing to download.");
  const csv = rowsToCsv(rows, [...CASE_COLUMNS, "QueueStatus", "CstCheck", "cstLink", "shipperid", "shipper", "orderid", "vrid", "fmc_status", "lane"]);
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lobby_sweep_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── lobby / SLA tab ────────────────────────────────────────────────────────

const ALERT_COLUMNS = [
  { key: "type", label: "Alert", render: (a) => `<span class="pill ${a.type === "Needs Response" ? "pill-bad" : a.type === "New Case" ? "pill-warn" : "pill-muted"}">${esc(a.type)}</span>` },
  { key: "id", label: "Case", render: (a) => caseLink(a.id) },
  { key: "severity", label: "Sev", render: (a) => sevPill(a.severity) },
  { key: "owner", label: "Owner" },
  { key: "status", label: "Status" },
  { key: "queue", label: "Queue" },
  { key: "minutes", label: "Mins" },
  { key: "details", label: "Details", wrap: true },
  { key: "subject", label: "Subject", wrap: true },
];

const LOBBY_COLUMNS = [
  { key: "ID", label: "Case", render: (r) => caseLink(r.ID) },
  { key: "Severity", label: "Sev", render: (r) => sevPill(r.Severity) },
  { key: "Status", label: "Status" },
  { key: "Owner", label: "Owner" },
  { key: "Queue", label: "Queue" },
  { key: "Creation Date", label: "Created" },
  { key: "Last Inbound Date", label: "Last inbound" },
  { key: "Last Outbound Date", label: "Last outbound" },
  { key: "Outbound SLA", label: "Outbound SLA" },
  { key: "Subject", label: "Subject", wrap: true },
];

function renderLobby() {
  const l = app.state && app.state.lastLobby;
  const alerts = (l && l.alerts) || [];
  const rows = (l && l.rows) || [];

  const byType = {};
  for (const a of alerts) byType[a.type] = (byType[a.type] || 0) + 1;

  $("lobbyStats").innerHTML = l
    ? [
        stat("Last run", fmtTime(l.finishedAt || l.at), l.team),
        stat("Lobby cases", rows.length),
        stat("Alerts", alerts.length, "", alerts.length ? "bad" : ""),
        ...Object.entries(byType).map(([t, n]) => stat(t, n, "", t === "Needs Response" ? "bad" : "warn")),
      ].join("")
    : "";
  $("lobbyCount").textContent = alerts.length || "";
  $("lobbyCount").className = `count ${alerts.length ? "bad" : ""}`;

  // chips
  const chips = $("alertTypeChips");
  const types = Object.keys(byType);
  chips.innerHTML =
    `<button class="chip" type="button" data-type="" aria-pressed="${app.alertTypeFilter ? "false" : "true"}">All (${alerts.length})</button>` +
    types
      .map(
        (t) =>
          `<button class="chip" type="button" data-type="${esc(t)}" aria-pressed="${app.alertTypeFilter === t}">${esc(t)} (${byType[t]})</button>`
      )
      .join("");
  for (const b of chips.querySelectorAll(".chip")) {
    b.addEventListener("click", () => {
      app.alertTypeFilter = b.dataset.type || null;
      renderLobby();
    });
  }

  const q = $("lobbySearch").value.trim().toLowerCase();
  const shown = alerts.filter((a) => {
    if (app.alertTypeFilter && a.type !== app.alertTypeFilter) return false;
    if (!q) return true;
    return ALERT_COLUMNS.some((c) => String(a[c.key] ?? "").toLowerCase().includes(q));
  });

  $("alertEmpty").hidden = shown.length > 0 || !l;
  $("alertTable").hidden = shown.length === 0;
  if (!l) $("alertEmpty").hidden = false;
  renderTable({
    headEl: $("alertHead"),
    bodyEl: $("alertBody"),
    columns: ALERT_COLUMNS,
    rows: shown,
    sort: app.alertSort,
    onSort: renderLobby,
  });

  $("lobbyRowCount").textContent = rows.length;
  renderTable({
    headEl: $("lobbyHead"),
    bodyEl: $("lobbyBody"),
    columns: LOBBY_COLUMNS,
    rows,
    sort: app.lobbySort,
    onSort: renderLobby,
  });
}

// ── settings tab ───────────────────────────────────────────────────────────

function renderSettings() {
  const s = app.settings;
  const sel = $("setTeam");
  sel.innerHTML = Object.values(app.config.teams)
    .map((t) => `<option value="${esc(t.key)}" ${t.key === s.team ? "selected" : ""}>${esc(t.label)} — ${esc(t.description)}</option>`)
    .join("");
  $("setDaysBack").value = s.daysBack;
  $("setDaysForward").value = s.daysForward;
  $("setShipperPath").value = s.shipperPath || "";
  $("setExcludeSubjects").value = s.excludeSubjects || "";
  $("setValidQueues").value = s.validQueues || "";
  $("setLobbyQueues").value = s.lobbyQueues || "";
  $("setDebug").checked = !!s.debug;
  updateWindowHint();
  $("setScheduleEnabled").checked = !!s.scheduleEnabled;
  $("setScheduleMinutes").value = s.scheduleMinutes;
  $("setRunSweep").checked = !!s.runSweep;
  $("setRunLobby").checked = !!s.runLobby;
  $("setDesktop").checked = !!s.desktopNotifications;
  $("setSlack").value = s.slackWebhook || "";
  $("setSlackAlerts").checked = !!s.slackAlerts;
  $("setSlackWrongQueue").checked = !!s.slackWrongQueue;
  $("setDedupe").value = s.alertDedupeMinutes;
  $("schedToggle").checked = !!s.scheduleEnabled;
}

/** Fill the three list textareas from the selected team's config defaults. */
function resetQueuesToDefaults() {
  const team = app.config.teams[$("setTeam").value] || app.config.teams[app.settings.team];
  $("setValidQueues").value = (team.validQueues || []).join("\n");
  $("setLobbyQueues").value = (team.lobbyQueues || []).join("\n");
  $("setExcludeSubjects").value = (team.excludeSubjects || []).join("\n");
  $("settingsSaved").textContent = "Defaults loaded — click Save to apply";
}

function updateWindowHint() {
  const back = Math.max(0, Number($("setDaysBack").value) || 0);
  const fwd = Math.max(0, Number($("setDaysForward").value) || 0);
  const day = 86_400_000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const fmt = (d) => d.toISOString().slice(0, 10);
  $("windowHint").textContent = `= ${fmt(new Date(today - back * day))} → ${fmt(new Date(today.getTime() + fwd * day))} (${back + fwd + 1} days)`;
}

async function renderShipperStatus(force = false) {
  const el = $("shipperStatus");
  el.textContent = "Checking…";
  el.className = "status";
  try {
    const s = await call("getShippers", { force });
    if (!s.count) {
      el.className = "status bad";
      el.textContent = `No shipper IDs available${s.error ? ` — ${s.error}` : ""}`;
      return;
    }
    el.className = `status ${s.stale ? "warn" : "good"}`;
    const from = s.source === "sharepoint" ? "SharePoint" : s.source === "import" ? "imported CSV" : s.source;
    el.textContent = `${s.count} CST shipper IDs from ${from}${s.path ? ` (${s.path})` : ""}${s.stale ? " — stale cache, SharePoint unreadable" : ""} · ${fmtTime(s.fetchedAt)} · e.g. ${s.sample.join(", ")}`;
  } catch (e) {
    el.className = "status bad";
    el.textContent = e.message;
  }
}

function readSettingsForm() {
  return {
    team: $("setTeam").value,
    daysBack: Number($("setDaysBack").value),
    daysForward: Number($("setDaysForward").value),
    shipperPath: $("setShipperPath").value.trim(),
    excludeSubjects: $("setExcludeSubjects").value,
    validQueues: $("setValidQueues").value,
    lobbyQueues: $("setLobbyQueues").value,
    debug: $("setDebug").checked,
    scheduleEnabled: $("setScheduleEnabled").checked,
    scheduleMinutes: Number($("setScheduleMinutes").value) || 30,
    runSweep: $("setRunSweep").checked,
    runLobby: $("setRunLobby").checked,
    desktopNotifications: $("setDesktop").checked,
    slackWebhook: $("setSlack").value.trim(),
    slackAlerts: $("setSlackAlerts").checked,
    slackWrongQueue: $("setSlackWrongQueue").checked,
    alertDedupeMinutes: Math.max(0, Number($("setDedupe").value) || 0),
  };
}

async function saveSettings(patch) {
  const { settings, schedule } = await call("saveSettings", { settings: patch });
  app.settings = settings;
  renderSettings();
  renderHeader(schedule);
  return settings;
}

// ── header ─────────────────────────────────────────────────────────────────

function renderHeader(schedule) {
  const s = app.settings;
  const sched = schedule || (app.state && app.state.schedule);
  if (schedule) app.schedule = schedule;
  let line = `Paragon lobby · team ${s.team} · window −${s.daysBack}d / +${s.daysForward}d`;
  if (sched && sched.enabled) {
    line += ` · auto every ${sched.periodMinutes} min, next ${fmtTime(sched.nextAt)}`;
    if (sched.lastFiredAt) {
      line += ` · last fired ${new Date(sched.lastFiredAt).toLocaleTimeString()}`;
      if (sched.lastOutcome) line += ` (${sched.lastOutcome.length > 60 ? sched.lastOutcome.slice(0, 60) + "…" : sched.lastOutcome})`;
    } else if (sched.armedAt) {
      line += " · not fired yet";
    }
  } else line += " · scheduler off";
  $("teamLine").textContent = line;
  $("schedToggle").checked = !!s.scheduleEnabled;
  tickCountdown();
}

// ── scheduler countdown ring ───────────────────────────────────────────────
const RING_LEN = 97.4; // 2π·15.5
let _cdRefreshing = false;

function fmtRemaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${s}s`;
}

function tickCountdown() {
  const el = $("countdown");
  const sched = app.schedule;
  const running = app.state && app.state.running;
  if (!sched || !sched.enabled) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (running) {
    el.className = "countdown running";
    $("cdText").textContent = "run";
    el.title = `Scheduled run in progress: ${progressText(app.state.progress)}`;
    return;
  }
  const period = (sched.periodMinutes || 30) * 60_000;
  const remaining = (sched.nextAt || 0) - Date.now();
  const frac = Math.min(1, Math.max(0, remaining / period));
  $("cdRing").style.strokeDashoffset = String(RING_LEN * (1 - frac));
  $("cdText").textContent = fmtRemaining(remaining);
  el.className = `countdown${remaining < 60_000 ? " soon" : ""}`;
  el.title = `Next scheduled run at ${fmtTime(sched.nextAt)} (every ${sched.periodMinutes} min)`;
  // Past due: the alarm fired (or the period changed) — re-read the schedule.
  if (remaining <= 0 && !_cdRefreshing) {
    _cdRefreshing = true;
    refreshState()
      .catch(() => {})
      .finally(() => setTimeout(() => (_cdRefreshing = false), 5000));
  }
}
setInterval(tickCountdown, 1000);

async function openExpiredSites(services) {
  const list = services && services.length ? services : app.expiredServices || [];
  if (!list.length) return;
  try {
    const r = await call("openSites", { services: list });
    ulog("info", `opened sign-in tabs: ${r.opened.map((o) => `${o.service}${o.reused ? " (existing tab)" : ""}`).join(", ")}`);
  } catch (e) {
    banner("error", `Couldn't open the site tabs: ${esc(e.message)}`);
  }
}

async function checkSessions(silent = false) {
  const badge = $("sessionBadge");
  badge.className = "pill pill-muted";
  badge.textContent = "sessions: checking…";
  try {
    const services = ["SharePoint", "SMC", "FMC", "Paragon"];
    const { expired, details } = await call("checkSessions", { services });
    if (!expired.length) {
      badge.className = "pill pill-good";
      badge.textContent = services.map((s) => `${s} ✓`).join(" · ");
      if (!silent) banner("ok", "SharePoint, SMC, FMC and Paragon sessions are live.");
    } else {
      badge.className = "pill pill-bad";
      badge.textContent = `expired: ${expired.join(", ")}`;
      badge.title = Object.entries(details).map(([k, v]) => `${k}: ${v}`).join("\n");
      app.expiredServices = expired;
      const list = `<strong>${esc(expired.join(", "))}</strong>`;
      if (!silent) {
        // Manual click: open the sign-in tabs straight away.
        await openExpiredSites(expired);
        banner(
          "error",
          `Not signed in to ${list}. Opened ${expired.length === 1 ? "its tab" : "their tabs"} — complete the Midway login there, then ` +
            `<button type="button" class="btn btn-ghost" data-act="recheck">Check sessions again</button>`
        );
      } else {
        banner(
          "error",
          `Not signed in to ${list}. <button type="button" class="btn btn-primary" data-act="open-expired">Open sign-in tabs</button> ` +
            `then <button type="button" class="btn btn-ghost" data-act="recheck">Check sessions again</button>`
        );
      }
    }
    return expired;
  } catch (e) {
    badge.className = "pill pill-bad";
    badge.textContent = "sessions: error";
    if (!silent) banner("error", esc(e.message));
    return null;
  }
}

// ── actions ────────────────────────────────────────────────────────────────

// The run we started from this page: { action, label, startedAt }. The
// background answers "started" immediately; we follow state.progress and
// state.running through storage.onChanged and report when running clears.
let activeRun = null;

async function run(action, label) {
  banner();
  if (!(await checkPermissions())) return;
  ulog("info", `▶ ${label} (${action})`);
  setBusy(`${label}… starting`);
  try {
    activeRun = { action, label, startedAt: Date.now() };
    await call(action);
  } catch (e) {
    activeRun = null;
    ulog("error", `✖ ${label}: ${e.message}`);
    banner("error", `${describeError(e, label)} <span class="muted">— details in the Log tab.</span>`);
    setBusy(null);
    await fetchLog();
  }
}

function progressText(p) {
  if (!p) return "working…";
  const n = p.total ? ` ${p.current}/${p.total}` : "";
  return `${p.label}${n}`;
}

function finishRun(state) {
  const r = activeRun;
  activeRun = null;
  setBusy(null);
  const le = state.lastError;
  if (le && le.at >= r.startedAt - 1000 && le.cancelled) {
    ulog("warn", `⏹ ${r.label}: ${le.message}`);
    banner("warn", `<strong>Stopped.</strong> ${esc(le.message)}. Results from the interrupted run were discarded; the previous results are still shown.`);
    return;
  }
  if (le && le.at >= r.startedAt - 1000) {
    ulog("error", `✖ ${r.label}: ${le.message}`);
    const e = Object.assign(new Error(le.message), { expired: le.expired });
    banner("error", `${describeError(e, r.label)} <span class="muted">— details in the Log tab.</span>`);
    if (le.expired) checkSessions(true);
    return;
  }
  const secs = ((Date.now() - r.startedAt) / 1000).toFixed(0);
  if (r.action === "runSweep" || r.action === "runCycle") {
    const s = state.lastSweep;
    if (s && s.at >= r.startedAt - 1000) {
      banner(
        s.flaggedCount ? "warn" : "ok",
        `Sweep done in ${secs}s: ${s.openCount} open cases (${s.closedCount} resolved removed), <strong>${s.flaggedCount}</strong> in a wrong queue, ${s.linkedCount} CST-linked.`
      );
      if (r.action === "runSweep") showTab("sweep");
    }
  }
  if (r.action === "runLobby" || r.action === "runCycle") {
    const l = state.lastLobby;
    if (l && l.at >= r.startedAt - 1000) {
      banner(l.alerts.length ? "warn" : "ok", `SLA check done in ${secs}s: ${l.rows.length} lobby cases, <strong>${l.alerts.length}</strong> alert(s).`);
      if (r.action === "runLobby") showTab("lobby");
    }
  }
  ulog("info", `✓ ${r.label} finished in ${secs}s`);
}

async function refreshState() {
  app.state = await call("getState");
  renderHeader(app.state.schedule);
  renderSweep();
  renderLobby();
  const running = app.state.running;
  if (running) {
    const mine = activeRun ? "" : " (started elsewhere — scheduler or another tab)";
    setBusy(`${running.job}${mine}: ${progressText(app.state.progress)}`);
  } else if (activeRun) {
    finishRun(app.state);
  } else {
    setBusy(null);
    const le = app.state.lastError;
    if (le && !$("banner").innerHTML) {
      if (le.controlBlocked) banner("error", `Scheduled ${esc(le.job)} at ${fmtTime(le.at)} was refused — disabled by the administrator: ${esc(le.message)}`);
      else if (le.cancelled) banner("warn", `Last ${esc(le.job)} at ${fmtTime(le.at)} was stopped: ${esc(le.message)}`);
      else banner(le.expired ? "error" : "warn", `Last ${esc(le.job)} at ${fmtTime(le.at)} failed: ${esc(le.message)}`);
    }
  }
}

// ── init ───────────────────────────────────────────────────────────────────

// ── site access (host permissions) ─────────────────────────────────────────
// Firefox grants host_permissions automatically for TEMPORARY add-ons only.
// An installed .xpi starts with them off, so every bridge would fail with
// "Missing host permission". Check on load and offer a one-click grant
// (permissions.request must run from a user gesture → button handler).
async function missingOrigins() {
  const origins = app.config.hostOrigins || [];
  const missing = [];
  for (const o of origins) {
    const ok = await browser.permissions.contains({ origins: [o] }).catch(() => true);
    if (!ok) missing.push(o);
  }
  return missing;
}

async function checkPermissions() {
  const missing = await missingOrigins();
  if (!missing.length) return true;
  const hosts = missing.map((o) => o.replace(/^https:\/\//, "").replace(/\/\*$/, ""));
  ulog("warn", `site access not granted for: ${hosts.join(", ")}`);
  banner(
    "error",
    `<strong>Site access needed.</strong> Firefox hasn't allowed this add-on on: ${hosts.map((h) => `<code>${esc(h)}</code>`).join(", ")}. ` +
      `<button type="button" class="btn btn-primary" data-act="grant-access">Grant site access</button> ` +
      `<span class="muted">(or about:addons → Lobby Sweeper → Permissions)</span>`
  );
  $("sessionBadge").className = "pill pill-bad";
  $("sessionBadge").textContent = "site access not granted";
  return false;
}

async function grantAccess() {
  const origins = app.config.hostOrigins || [];
  try {
    const ok = await browser.permissions.request({ origins });
    if (ok) {
      ulog("info", "site access granted");
      banner("ok", "Site access granted. Checking sessions…");
      await checkSessions(true);
    } else {
      banner("warn", "Site access was declined. The sweep can't reach Paragon/SMC/FMC/SharePoint until it's granted.");
    }
  } catch (e) {
    banner("error", `Couldn't request site access: ${esc(e.message)}`);
  }
}

// ── remote control (control.json) ──────────────────────────────────────────
async function renderControl(refresh = false) {
  let s;
  try {
    s = await call("controlStatus", { refresh });
  } catch (e) {
    $("controlStatus").className = "status warn";
    $("controlStatus").textContent = `Couldn't read control status: ${e.message}`;
    return true;
  }
  const v = s.verdict || { allowed: true };
  $("controlIdentity").innerHTML =
    `Alias: <code>${esc(s.alias || "unknown — open an SMC tab")}</code> · Install ID: <code>${esc(s.installId)}</code>`;
  const when = s.fetchedAt ? `checked ${fmtTime(s.fetchedAt)}` : "not checked yet";
  const err = s.error ? ` · last fetch error: ${esc(s.error)}` : "";
  const el = $("controlStatus");
  app.controlBlocked = !v.allowed;
  if (v.allowed) {
    el.className = "status good";
    el.innerHTML = `Enabled for this install (${when})${err}${v.notice ? ` · notice: ${esc(v.notice)}` : ""}`;
    if (v.notice) banner("warn", `<strong>Notice:</strong> ${esc(v.notice)}`);
    for (const id of ["btnRunCycle", "schedToggle"]) $(id).disabled = false;
    return true;
  }
  el.className = "status bad";
  el.innerHTML = `<strong>Disabled</strong> (${esc(v.reason)}, ${when}): ${esc(v.message)}${err}`;
  banner("error", `<strong>Disabled by the administrator.</strong> ${esc(v.message)} <button type="button" class="btn btn-ghost" data-act="control-refresh">Re-check</button>`);
  for (const id of ["btnRunCycle", "schedToggle"]) $(id).disabled = true;
  return false;
}

async function init() {
  app.config = await call("getConfig");
  app.settings = await call("getSettings");
  renderSettings();
  await refreshState();
  $("banner").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='grant-access']")) grantAccess();
    else if (e.target.closest("[data-act='open-expired']")) openExpiredSites();
    else if (e.target.closest("[data-act='recheck']")) checkSessions(false);
    else if (e.target.closest("[data-act='control-refresh']")) renderControl(true);
  });
  $("btnControlRefresh").addEventListener("click", () => renderControl(true));
  const allowed = await renderControl(false);
  if (allowed && (await checkPermissions())) checkSessions(true);

  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));
  $("banner").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='reload-page']")) location.reload();
  });

  $("btnRunSweep").addEventListener("click", () => run("runSweep", "Wrong-queue sweep"));
  $("btnRunLobby").addEventListener("click", () => run("runLobby", "SLA check"));
  $("btnRunCycle").addEventListener("click", () => run("runCycle", "Sweep + SLA check"));
  $("btnStop").addEventListener("click", async () => {
    $("btnStop").disabled = true;
    $("btnStop").textContent = "Stopping…";
    try {
      const r = await call("cancelRun");
      ulog("warn", r.cancelling ? `⏹ stop requested (${r.job})` : `stop: ${r.reason}`);
      if (!r.cancelling) setBusy(null);
    } catch (e) {
      banner("error", `Couldn't stop: ${esc(e.message)}`);
    }
  });
  $("btnCheckSessions").addEventListener("click", async () => {
    if (await checkPermissions()) checkSessions(false);
  });
  $("schedToggle").addEventListener("change", (e) => saveSettings({ scheduleEnabled: e.target.checked }).catch((err) => banner("error", esc(err.message))));

  $("sweepSearch").addEventListener("input", renderSweep);
  $("sweepFilter").addEventListener("change", renderSweep);
  $("btnSweepCsv").addEventListener("click", downloadSweepCsv);
  $("lobbySearch").addEventListener("input", renderLobby);

  $("btnResetQueues").addEventListener("click", resetQueuesToDefaults);
  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await saveSettings(readSettingsForm());
      $("settingsSaved").textContent = `Saved ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      banner("error", esc(err.message));
    }
  });
  $("btnTestSlack").addEventListener("click", async () => {
    try {
      await call("testSlack", { webhook: $("setSlack").value.trim() });
      banner("ok", "Slack test message sent.");
    } catch (err) {
      banner("error", esc(err.message));
    }
  });
  $("btnClearLog").addEventListener("click", async () => {
    await call("clearAlertLog");
    banner("ok", "Notification memory reset — the next run will re-notify every current alert.");
  });

  // Settings: window hint, shipper source
  $("setDaysBack").addEventListener("input", updateWindowHint);
  $("setDaysForward").addEventListener("input", updateWindowHint);
  $("sweepCstFilter").addEventListener("change", renderSweep);
  renderShipperStatus(false);
  $("btnShippersRefresh").addEventListener("click", async () => {
    // Save the path override first so the re-read uses it.
    await saveSettings({ shipperPath: $("setShipperPath").value.trim() }).catch(() => {});
    await renderShipperStatus(true);
  });
  $("shipperCsvFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await call("importShippers", { text, name: file.name });
      banner("ok", `Imported ${r.count} shipper IDs from ${esc(file.name)}.`);
      await renderShipperStatus(true);
    } catch (err) {
      banner("error", `Import failed: ${esc(err.message)}`);
    } finally {
      e.target.value = "";
    }
  });
  $("btnShippersClearImport").addEventListener("click", async () => {
    await call("clearShipperImport");
    await renderShipperStatus(true);
  });

  // Log tab
  await fetchLog();
  $("logPipelineOnly").addEventListener("change", renderLog);
  $("logErrorsOnly").addEventListener("change", renderLog);
  $("btnLogClear").addEventListener("click", async () => {
    await call("clearLog");
    uiLog.length = 0;
    await fetchLog();
  });
  $("btnLogCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(logAsText());
      banner("ok", "Log copied to clipboard.");
    } catch (e) {
      banner("error", `Copy failed: ${esc(e.message)}`);
    }
  });

  // A scheduled run (or another page) changed stored results → re-render.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.log) {
      bgLog = { ...bgLog, lines: changes.log.newValue || [] };
      scheduleLogRender();
    }
    if (changes.state) refreshState().catch(() => {});
    if (changes.settings) {
      app.settings = { ...app.settings, ...changes.settings.newValue };
      renderSettings();
      renderHeader();
    }
  });
}

init().catch((e) => banner("error", `Failed to start: ${esc(e.message)}`));
