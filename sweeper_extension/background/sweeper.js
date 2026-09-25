/**
 * Orchestration — the port of paragon_scheduler.py's cycle plus the Slack /
 * notification side of paragon.py and lobby_monitor.py.
 *
 *   runSweep(team)  SMC pairs → Paragon batched search → wrong-queue flag
 *   runLobby(team)  Paragon lobby query → SLA alerts
 *   runCycle()      what the alarm fires: sweep then lobby (per settings)
 *
 * Results land in browser.storage (store.js) for the UI; new alerts are
 * de-duplicated against the alert log before notifying (desktop + Slack).
 */
import { Config } from "../config.js";
import * as paragon from "./paragonClient.js";
import * as smc from "./smcClient.js";
import * as fmc from "./fmcClient.js";
import * as shippers from "./shippers.js";
import * as store from "./store.js";
import { log } from "./debug.js";
import {
  buildLobbyQuery,
  flagWrongQueue,
  detectCaseSignals,
  alertKey,
  formatAlertSlack,
  formatWrongQueueSlack,
} from "../shared/signals.js";

let running = null;
const INSTANCE = Date.now();

function teamCfg(key) {
  const team = Config.TEAMS[String(key || "").toUpperCase()];
  if (!team) throw new Error(`Unknown team: ${key}`);
  return team;
}

/**
 * Run lock, persisted in storage as { job, startedAt, instance } so a
 * background that was terminated mid-run (Firefox event-page idle kill) can
 * recognise the orphaned lock on restart instead of silently starting over.
 */
async function withLock(label, fn) {
  if (running) throw new Error(`Already running: ${running}`);
  const state = await store.getState();
  if (state.running && state.running.instance === INSTANCE) throw new Error(`Already running: ${state.running.job}`);
  running = label;
  cancelRequested = false;
  await store.patchState({ running: { job: label, startedAt: Date.now(), instance: INSTANCE }, progress: null });
  try {
    return await fn();
  } finally {
    running = null;
    cancelRequested = false;
    await store.patchState({ running: null, progress: null });
  }
}

/** Called once on background start: report a run the previous instance never finished. */
export async function recoverInterruptedRun() {
  const state = await store.getState();
  const r = state.running;
  if (!r || r.instance === INSTANCE) return;
  const p = state.progress;
  const where = p ? ` at "${p.label}"${p.total ? ` (${p.current}/${p.total})` : ""}` : "";
  log.error("pipeline", `previous ${r.job} started ${new Date(r.startedAt).toLocaleTimeString()} was interrupted${where} — background was terminated mid-run`);
  await store.patchState({
    running: null,
    progress: null,
    lastError: { at: Date.now(), job: r.job, message: `Run interrupted${where}: the background was terminated mid-run.`, expired: false },
  });
}

/** Newline-separated settings list → trimmed array; empty → fallback. */
export function listSetting(text, fallback = []) {
  const items = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : [...fallback];
}

// ── cancellation ───────────────────────────────────────────────────────────
// The pipeline runs in short hops (one Paragon/FMC batch, one SMC page per
// bridge round-trip) and calls progress() between hops, so checking the flag
// there stops a run within a hop or two of the request.
let cancelRequested = false;

export async function requestCancel() {
  if (!running) return { cancelling: false, reason: "nothing is running" };
  cancelRequested = true;
  log.warn("pipeline", `⏹ stop requested by user during ${running} — finishing the current batch`);
  const st = await store.getState();
  await store.patchState({ progress: { ...(st.progress || {}), label: `stopping after this batch… (${(st.progress || {}).label || running})` } });
  return { cancelling: true, job: running };
}

function checkCancel(where) {
  if (!cancelRequested) return;
  const err = new Error(`Stopped by user at ${where}`);
  err.cancelled = true;
  throw err;
}

/**
 * Progress for the UI (persisted; every write is also an activity tick).
 * Deliberately NOT async: checkCancel must throw synchronously so the throw
 * propagates into the batch loop that called us (the per-batch onProgress
 * callbacks are not awaited). Returns a promise for callers that do await.
 */
let _lastProgressWrite = 0;
function progress(label, current = null, total = null, force = false) {
  checkCancel(total ? `${label} ${current}/${total}` : label);
  const now = Date.now();
  if (!force && now - _lastProgressWrite < 400) return Promise.resolve(); // throttle storage writes
  _lastProgressWrite = now;
  const p = store.patchState({ progress: { label, current, total, at: now } });
  p.catch(() => {});
  return p;
}

export const isRunning = () => running;

// ── notifications ──────────────────────────────────────────────────────────

async function postSlack(webhook, text) {
  if (!webhook) return false;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mrkdwn: true }),
  });
  if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return true;
}

async function desktopNotify(title, message) {
  try {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-96.png"),
      title,
      message,
    });
  } catch (e) {
    log.warn("notify", "desktop notification failed:", e && e.message);
  }
}

export async function updateBadge() {
  const state = await store.getState();
  const alerts = (state.lastLobby && state.lastLobby.alerts) || [];
  const flagged = (state.lastSweep && state.lastSweep.flaggedCount) || 0;
  const n = alerts.length + flagged;
  try {
    await browser.action.setBadgeText({ text: n ? String(n) : "" });
    await browser.action.setBadgeBackgroundColor({ color: alerts.length ? "#d13212" : "#e07b00" });
    await browser.action.setTitle({
      title: n ? `Lobby Sweeper — ${alerts.length} SLA alert(s), ${flagged} wrong-queue` : "Lobby Sweeper",
    });
  } catch (e) {
    log.warn("badge", e && e.message);
  }
}

/**
 * Split `items` into those not notified within the dedupe window and record
 * them in the alert log. Returns { fresh, alertLog }.
 */
function dedupe(items, keyOf, alertLog, dedupeMinutes, nowMs = Date.now()) {
  const pruned = store.pruneAlertLog(alertLog, dedupeMinutes, nowMs);
  const fresh = [];
  for (const it of items) {
    const k = keyOf(it);
    if (pruned[k]) continue;
    pruned[k] = nowMs;
    fresh.push(it);
  }
  return { fresh, alertLog: pruned };
}

// ── jobs ───────────────────────────────────────────────────────────────────

/**
 * Wrong-queue sweep for `teamKey`. Never throws for a *partial* Paragon
 * failure (failed batches are reported); throws on SMC/Paragon session loss
 * or a total failure so the caller can surface it.
 */
export async function runSweep(teamKey, { notify = true } = {}) {
  const team = teamCfg(teamKey);
  const settings = await store.getSettings();
  const startedAt = Date.now();
  const P = "pipeline";
  const t = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const win = smc.sweepWindow({ daysBack: settings.daysBack, daysForward: settings.daysForward });
  log.info(P, `━━ sweep start (team ${team.key}, window -${settings.daysBack}d/+${settings.daysForward}d) ━━`);

  // ── 1. CST shipper IDs (SharePoint source of truth) ─────────────────────
  await progress("1/4 reading CST shipper IDs", null, null, true);
  const ship = await shippers.getShipperIds();
  if (!ship.ids.length) {
    log.error(P, `1/4 shippers: NONE available (${ship.error || "no SharePoint CSV and no import"}) — sweep aborted`);
    throw new Error(
      `No CST shipper IDs available (${ship.error || "SharePoint CSV unreadable"}). Import the shipper CSV in Settings, or sign in to SharePoint and retry.`
    );
  }
  const shipperSet = new Set(ship.ids);
  log.info(P, `1/4 shippers: ${ship.ids.length} CST shipper IDs from ${ship.source} (${ship.path})${ship.stale ? " [stale cache]" : ""}`);

  // ── 2. SMC orders for those shippers ────────────────────────────────────
  await progress("2/4 fetching SMC orders", null, null, true);
  const { pairs, orders, total, truncated, window } = await smc.getPairs(team, ship.ids, win);
  const withVrid = pairs.filter((p) => p.vrid);
  const noVrid = pairs.filter((p) => !p.vrid);
  const orderIds = [...new Set(pairs.map((p) => p.orderid))];
  const smcVrids = [...new Set(withVrid.map((p) => p.vrid))];
  log.info(
    P,
    `2/4 SMC: ${orders} orders (${window.start.slice(0, 10)} → ${window.end.slice(0, 10)})${truncated ? ` — TRUNCATED, SMC reports ${total}` : ""}; ` +
      `${smcVrids.length} VRIDs on ${withVrid.length} rows, ${noVrid.length} orders without a VRID [${t()}]`
  );
  if (!orders) log.warn(P, "2/4 SMC returned no orders for the CST shippers in this window");

  // ── 3. FMC: confirm the VRIDs SMC reported ──────────────────────────────
  // (FMC's by-id search only takes VRIDs — order IDs returned nothing live —
  // so VRID-less orders are searched in Paragon by order ID alone.)
  const fmcById = new Map(); // vrid -> record
  try {
    const fmcBatches = Math.ceil(smcVrids.length / 50);
    await progress("3/4 confirming VRIDs in FMC", 0, fmcBatches, true);
    const records = smcVrids.length
      ? await fmc.byId(smcVrids, (done, totalB) => progress("3/4 confirming VRIDs in FMC", done, totalB))
      : [];
    for (const rec of records) fmcById.set(rec.vrid, rec);
    const confirmed = smcVrids.filter((v) => fmcById.has(v)).length;
    const missing = smcVrids.length - confirmed;
    log.info(
      P,
      `3/4 FMC: ${smcVrids.length} VRIDs in ${fmcBatches} batches → ${records.length} records; ${confirmed} confirmed` +
        (missing ? `, ${missing} NOT found in FMC` : "") +
        ` [${t()}]`
    );
  } catch (e) {
    if (e && e.expired) throw e;
    log.warn(P, `3/4 FMC: skipped — ${e.message}`);
  }
  const allVrids = smcVrids;

  // ── 4. Paragon: search every orderid + vrid, 35 ids per batch ───────────
  const terms = [...orderIds, ...allVrids].map((id) => `"${id}"`);
  const batchSize = Config.PARAGON_BATCH_SIZE;
  const nBatches = Math.ceil(terms.length / batchSize);
  log.info(P, `4/4 Paragon: ${orderIds.length} order IDs + ${allVrids.length} VRIDs = ${terms.length} ids → ${nBatches} batches of ${batchSize}`);
  await progress("4/4 searching Paragon", 0, nBatches, true);
  const { rows, failedBatches, batches } = await paragon.sweep(terms, (done, totalB, cases) =>
    progress(`4/4 searching Paragon (${cases} cases so far)`, done, totalB)
  );
  log.info(P, `4/4 Paragon: ${rows.length} unique cases${failedBatches.length ? `, ${failedBatches.length} failed batch(es): ${failedBatches.join(", ")}` : ""} [${t()}]`);
  await progress("finishing", null, null, true);

  // ── check: is the case connected to a CST shipper? ──────────────────────
  // A case is CST-linked when its Merchant ID is one of the CST shipper IDs,
  // or its subject mentions one of OUR order IDs / VRIDs (which all belong to
  // CST shippers by construction of step 2).
  const orderSet = new Set(orderIds);
  const vridSet = new Set(allVrids);
  const pairByOrder = new Map(pairs.map((p) => [p.orderid, p]));
  const pairByVrid = new Map(pairs.filter((p) => p.vrid).map((p) => [p.vrid, p]));
  const idRe = /\b[A-Z0-9][A-Z0-9-]{5,}\b/g;
  for (const r of rows) {
    const merchant = String(r["Merchant ID"] || "").trim();
    const tokens = String(r.Subject || "").toUpperCase().match(idRe) || [];
    const hitOrder = tokens.find((tk) => orderSet.has(tk));
    const hitVrid = tokens.find((tk) => vridSet.has(tk));
    const pair = (hitVrid && pairByVrid.get(hitVrid)) || (hitOrder && pairByOrder.get(hitOrder)) || null;
    r.orderid = pair ? pair.orderid : hitOrder || "";
    r.vrid = pair ? pair.vrid : hitVrid || "";
    r.shipperid = pair ? pair.shipperid : merchant;
    r.shipper = pair ? pair.shipper : "";
    r.lane = pair ? [pair.origin, pair.dest].filter(Boolean).join(" → ") : "";
    const fmcRec = r.vrid ? fmcById.get(r.vrid) : null;
    r.fmc_status = fmcRec ? fmcRec.status : "";
    r.fmc_carrier = fmcRec ? fmcRec.carrier : "";
    r.cstLink = shipperSet.has(merchant) ? "merchant" : hitVrid ? "vrid" : hitOrder ? "order" : "";
    r.CstCheck = r.cstLink ? "yes" : "no";
  }
  const linked = rows.filter((r) => r.cstLink).length;
  log.info(
    P,
    `check: ${linked}/${rows.length} cases connected to CST shippers (by merchant ${rows.filter((r) => r.cstLink === "merchant").length}, ` +
      `by VRID ${rows.filter((r) => r.cstLink === "vrid").length}, by order ${rows.filter((r) => r.cstLink === "order").length}); ${rows.length - linked} NOT linked`
  );

  // Drop closed cases (Resolved, Closed, …). "Open" = the lobby's open-status
  // list from lobby_monitor.py. Closed cases are counted in the log only.
  const openSet = new Set(Config.LOBBY_STATUSES.map((s) => s.toUpperCase()));
  const openAll = rows.filter((r) => openSet.has(String(r.Status || "").trim().toUpperCase()));
  const closedCount = rows.length - openAll.length;

  // Subject exclusions (Settings → one substring per line, case-insensitive).
  const excludes = String(settings.excludeSubjects || "")
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const excludedCounts = new Map();
  const openRows = openAll.filter((r) => {
    const subj = String(r.Subject || "").toLowerCase();
    const hit = excludes.find((x) => subj.includes(x));
    if (hit) excludedCounts.set(hit, (excludedCounts.get(hit) || 0) + 1);
    return !hit;
  });
  const excludedCount = openAll.length - openRows.length;
  if (excludedCount) {
    log.info(P, `excluded ${excludedCount} by subject: ${[...excludedCounts].map(([k, n]) => `"${k}" ×${n}`).join(", ")}`);
  }

  const validQueues = listSetting(settings.validQueues, team.validQueues);
  const flaggedRows = flagWrongQueue(openRows, validQueues);
  const flagged = flaggedRows.filter((r) => r.check);
  log.info(
    P,
    `status: ${openRows.length} open kept, ${closedCount} resolved/closed removed${excludedCount ? `, ${excludedCount} excluded by subject` : ""}. ` +
      `queues: ${flagged.length}/${openRows.length} open cases outside the ${validQueues.length} valid queues ` +
      `(${flagged.filter((r) => r.cstLink).length} of them CST-linked) ━━ done in ${t()}`
  );

  const result = {
    at: startedAt,
    finishedAt: Date.now(),
    team: team.key,
    window,
    shippers: { count: ship.ids.length, source: ship.source, path: ship.path },
    orders,
    ordersTotal: total,
    truncated,
    vridCount: allVrids.length,
    orderCount: orderIds.length,
    fmcConfirmed: smcVrids.filter((v) => fmcById.has(v)).length,
    pairCount: terms.length,
    batches,
    failedBatches,
    rows: flaggedRows,
    caseCount: rows.length,
    openCount: openRows.length,
    closedCount,
    excludedCount,
    linkedCount: flaggedRows.filter((r) => r.cstLink).length,
    flaggedCount: flagged.length,
    error: null,
  };

  let state = await store.patchState({ lastSweep: result, lastError: null });

  if (notify && flagged.length) {
    const { fresh, alertLog } = dedupe(
      flagged,
      (r) => `WrongQueue|${r.ID}`,
      state.alertLog,
      settings.alertDedupeMinutes
    );
    state = await store.patchState({ alertLog });
    if (fresh.length) {
      if (settings.desktopNotifications) {
        await desktopNotify(
          `Lobby Sweeper — ${fresh.length} case(s) in wrong queue`,
          fresh.slice(0, 5).map((r) => `${r.ID} · ${r.Queue}`).join("\n") + (fresh.length > 5 ? "\n…" : "")
        );
      }
      if (settings.slackWrongQueue && settings.slackWebhook) {
        try {
          await postSlack(settings.slackWebhook, formatWrongQueueSlack(fresh, (id) => Config.caseUrl(id)));
        } catch (e) {
          log.error("slack", e);
        }
      }
    }
  }

  await updateBadge();
  return result;
}

/** SLA monitor pass for `teamKey` (lobby_monitor.run_lobby_monitor). */
export async function runLobby(teamKey, { notify = true } = {}) {
  const team = teamCfg(teamKey);
  const settings = await store.getSettings();
  const startedAt = Date.now();
  const lobbyQueues = listSetting(settings.lobbyQueues, team.lobbyQueues);
  const query = buildLobbyQuery(lobbyQueues, Config.LOBBY_STATUSES);
  log.info("pipeline", `━━ SLA check start (team ${team.key}, ${lobbyQueues.length} lobby queues: ${lobbyQueues.join(", ")}) ━━`);

  await progress("SLA: querying the Paragon lobby", null, null, true);
  const rows = await paragon.query(query, (done, total) => progress("SLA: querying the Paragon lobby", done, total));
  const alerts = detectCaseSignals(rows, Config.SLA, Date.now());
  const byType = {};
  for (const a of alerts) byType[a.type] = (byType[a.type] || 0) + 1;
  log.info(
    "pipeline",
    `SLA: ${rows.length} lobby cases → ${alerts.length} alerts ${JSON.stringify(byType)} ━━ done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );

  const result = {
    at: startedAt,
    finishedAt: Date.now(),
    team: team.key,
    query,
    rows,
    alerts,
    error: null,
  };
  let state = await store.patchState({ lastLobby: result, lastError: null });

  if (notify && alerts.length) {
    const { fresh, alertLog } = dedupe(alerts, alertKey, state.alertLog, settings.alertDedupeMinutes);
    state = await store.patchState({ alertLog });
    if (fresh.length) {
      if (settings.desktopNotifications) {
        const byType = {};
        for (const a of fresh) byType[a.type] = (byType[a.type] || 0) + 1;
        await desktopNotify(
          `Lobby Sweeper — ${fresh.length} new SLA alert(s)`,
          Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join("\n")
        );
      }
      if (settings.slackAlerts && settings.slackWebhook) {
        for (const a of fresh) {
          try {
            await postSlack(settings.slackWebhook, formatAlertSlack(a, (id) => Config.caseUrl(id)));
          } catch (e) {
            log.error("slack", e);
          }
        }
      }
    }
  }

  await updateBadge();
  return result;
}

/** One scheduled cycle: sweep then lobby, each guarded so the other still runs. */
export async function runCycle(trigger = "manual") {
  return withLock("cycle", async () => {
    const settings = await store.getSettings();
    const out = { trigger, at: Date.now(), sweep: null, lobby: null, errors: [] };
    let cancelled = false;
    if (settings.runSweep) {
      try {
        out.sweep = await runSweep(settings.team);
      } catch (e) {
        cancelled = !!e.cancelled;
        out.errors.push(`sweep: ${e.message}`);
        (cancelled ? log.warn : log.error).call(log, "pipeline", cancelled ? e.message : `sweep failed: ${e.message}`);
        await store.patchState({ lastError: { at: Date.now(), job: "sweep", message: e.message, expired: !!e.expired, cancelled } });
      }
    }
    if (settings.runLobby && !cancelled) {
      try {
        out.lobby = await runLobby(settings.team);
      } catch (e) {
        cancelled = !!e.cancelled;
        out.errors.push(`lobby: ${e.message}`);
        (cancelled ? log.warn : log.error).call(log, "pipeline", cancelled ? e.message : `lobby failed: ${e.message}`);
        await store.patchState({ lastError: { at: Date.now(), job: "lobby", message: e.message, expired: !!e.expired, cancelled } });
      }
    }
    out.cancelled = cancelled;
    return out;
  });
}

export const runSweepLocked = (team) => withLock("sweep", () => runSweep(team));
export const runLobbyLocked = (team) => withLock("lobby", () => runLobby(team));

// ── sessions ───────────────────────────────────────────────────────────────

/** Probe Paragon/SMC; returns the subset that are expired or unreachable. */
export async function checkSessions(services = ["SharePoint", "SMC", "FMC", "Paragon"]) {
  const expired = [];
  const details = {};
  await Promise.all(
    services.map(async (svc) => {
      try {
        if (svc === "Paragon") await paragon.ping();
        else if (svc === "SMC") await smc.ping();
        else if (svc === "FMC") await fmc.ping();
        else if (svc === "SharePoint") await shippers.ping();
        details[svc] = "ok";
      } catch (e) {
        details[svc] = String(e && e.message ? e.message : e);
        expired.push(svc);
      }
    })
  );
  return { expired, details };
}
