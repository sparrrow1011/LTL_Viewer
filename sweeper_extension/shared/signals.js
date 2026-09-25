/**
 * Pure detection logic — no browser APIs, so it is usable from the background
 * worker and the UI page alike (both import it as an ES module).
 *
 * Ports:
 *   paragon.py       load_queries / merge_and_filter  → buildPairQueries / flagWrongQueue
 *   lobby_monitor.py LOBBY_QUERY / detect_case_signals → buildLobbyQuery / detectCaseSignals
 *
 * A "case row" is what content/paragon-bridge.js returns for one Paragon CASE:
 * the 14 human columns from paragon.py KEEP_COLS plus raw epoch-ms timestamps
 * (`_creationMs`, `_lastInboundMs`, `_lastOutboundMs`) so nothing here has to
 * parse date strings.
 */

/** Columns shown/exported by the sweeper table (paragon.py KEEP_COLS). */
export const CASE_COLUMNS = [
  "ID",
  "Subject",
  "Partner",
  "Merchant ID",
  "Owner",
  "Severity",
  "Status",
  "Creation Date",
  "Last Inbound Date",
  "Last Outbound Date",
  "Queue",
  "Status SLA",
  "Outbound SLA",
  "Oldest Active Follow-up Date",
];

const quote = (s) => `"${String(s).replace(/"/g, "")}"`;

/**
 * '"<orderid>" "<vrid>"' search terms, one per pair (paragon.py load_queries /
 * fmc_update.py fetch_paragon_queries). Drops pairs missing either id or with
 * the historical 'no_vrid' placeholder, dedupes.
 * @param {Array<{orderid:string, vrid:string}>} pairs
 * @returns {string[]}
 */
export function buildPairQueries(pairs) {
  const seen = new Set();
  const out = [];
  for (const p of pairs || []) {
    const orderid = String(p.orderid ?? "").trim();
    const vrid = String(p.vrid ?? "").trim();
    if (!orderid || !vrid || vrid.toLowerCase() === "no_vrid") continue;
    const key = `${orderid}|${vrid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${quote(orderid)} ${quote(vrid)}`);
  }
  return out;
}

/**
 * The lobby search filter (lobby_monitor.py LOBBY_QUERY):
 *   (queue:"a" OR queue:"b") AND (status:"x" OR status:"y" ...)
 * @param {string[]} queues
 * @param {string[]} statuses
 */
export function buildLobbyQuery(queues, statuses) {
  const q = (queues || []).map((v) => `queue:${quote(v)}`).join(" OR ");
  const s = (statuses || []).map((v) => `status:${quote(v)}`).join(" OR ");
  if (!q) throw new Error("buildLobbyQuery: no queues configured for this team");
  return s ? `(${q}) AND (${s})` : `(${q})`;
}

/**
 * Wrong-queue check (paragon.py merge_and_filter): a case is flagged when its
 * queue is NOT one of the team's valid queues AND it is not Resolved.
 * Returns new row objects with `check` (boolean) and `QueueStatus`
 * ("good" | "check" — the label sweeper.html rendered).
 * @param {object[]} rows
 * @param {string[]} validQueues
 */
export function flagWrongQueue(rows, validQueues) {
  const valid = new Set((validQueues || []).map((q) => String(q).trim().toLowerCase()));
  return (rows || []).map((row) => {
    const queue = String(row.Queue ?? "").trim().toLowerCase();
    const status = String(row.Status ?? "").trim().toUpperCase();
    const check = !valid.has(queue) && status !== "RESOLVED";
    return { ...row, check, QueueStatus: check ? "check" : "good" };
  });
}

// lobby_monitor.py is_owner_missing: NaN / "" / "nan" / "none" all count as no owner.
export function isOwnerMissing(val) {
  if (val == null) return true;
  const s = String(val).trim().toLowerCase();
  return s === "" || s === "nan" || s === "none" || s === "null";
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const minutes = (ms) => ms / 60000;
const hours = (ms) => ms / 3600000;
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Alert types produced by detectCaseSignals, with the Slack decorations
 * lobby_monitor.py send_slack_message used.
 */
export const ALERT_TYPES = {
  "Needs Response": { emoji: ":rotating_light:", title: "Case Needs Response!" },
  "New Case": { emoji: ":new:", title: "New Case Alert!" },
  "WIP Stagnant": { emoji: ":hourglass_flowing_sand:", title: "Stagnant WIP Case!" },
  "PAA Overdue": { emoji: ":warning:", title: "Pending Internal Follow-up Overdue!" },
};

/**
 * Port of lobby_monitor.py detect_case_signals.
 *
 * @param {object[]} rows   case rows from the Paragon bridge
 * @param {object}   sla    Config.SLA
 * @param {number}   [nowMs]
 * @returns {Array<{type, id, severity, owner, status, queue, subject, details, minutes}>}
 */
export function detectCaseSignals(rows, sla, nowMs = Date.now()) {
  const alerts = [];
  const thresholds = sla.needsResponseMinutesBySeverity || {};

  for (const row of rows || []) {
    const caseId = String(row.ID ?? "").trim();
    if (!caseId) continue;
    const ownerMissing = isOwnerMissing(row.Owner);
    const owner = ownerMissing ? "" : String(row.Owner).trim();
    const status = String(row.Status ?? "").trim();
    const statusU = status.toUpperCase();
    const queue = row.Queue ?? "";
    const severity = toInt(row.Severity);
    const lastIn = row._lastInboundMs ?? null;
    const lastOut = row._lastOutboundMs ?? null;
    const creation = row._creationMs ?? null;

    const base = {
      id: caseId,
      severity,
      owner: owner || "Unassigned",
      status,
      queue,
      subject: row.Subject ?? "",
    };

    // 1) Needs Response
    if (lastIn) {
      if (lastOut) {
        const deltaMin = minutes(lastIn - lastOut);
        const limit = severity != null ? thresholds[severity] : undefined;
        if (limit != null && deltaMin >= limit) {
          alerts.push({
            ...base,
            type: "Needs Response",
            minutes: r1(deltaMin),
            details: `No outbound for ${r1(deltaMin)} mins since last inbound`,
          });
        }
      } else {
        const sinceIn = minutes(nowMs - lastIn);
        if (sinceIn >= (sla.noOutboundMinutes ?? 30)) {
          alerts.push({
            ...base,
            type: "Needs Response",
            minutes: r1(sinceIn),
            details: `No outbound found. ${r1(sinceIn)} mins since last inbound`,
          });
        }
      }
    }

    // 2) New Case (unassigned + no owner)
    if (statusU === "UNASSIGNED" && ownerMissing) {
      const opened = lastIn ? `Opened ${r1(minutes(nowMs - lastIn))} mins ago` : "Opened time not available";
      alerts.push({
        ...base,
        type: "New Case",
        owner: "Unassigned",
        minutes: lastIn ? r1(minutes(nowMs - lastIn)) : null,
        details: `Case is unassigned and needs triage. ${opened}`,
      });
    }

    // 3) WIP stagnant (off unless sla.wipStagnantHours is set)
    if (sla.wipStagnantHours && creation && (statusU === "WORK-IN-PROGRESS" || statusU === "WIP")) {
      const ageH = hours(nowMs - creation);
      if (ageH > sla.wipStagnantHours) {
        alerts.push({
          ...base,
          type: "WIP Stagnant",
          minutes: r1(ageH * 60),
          details: `WIP case open for ${r1(ageH)} hours without update`,
        });
      }
    }

    // 4) PAA overdue
    if (creation && (statusU === "PENDING AMAZON ACTION" || statusU === "PAA")) {
      const ageH = hours(nowMs - creation);
      if (ageH > (sla.paaOverdueHours ?? 24)) {
        alerts.push({
          ...base,
          type: "PAA Overdue",
          minutes: r1(ageH * 60),
          details: `PAA case pending for ${r1(ageH)} hours without follow-up`,
        });
      }
    }
  }

  return alerts;
}

/** Stable key for alert de-duplication. */
export const alertKey = (a) => `${a.type}|${a.id}`;

/**
 * Slack message text for one alert (lobby_monitor.py send_slack_message).
 * @param {object} alert
 * @param {(id:string)=>string} caseUrl
 */
export function formatAlertSlack(alert, caseUrl) {
  const deco = ALERT_TYPES[alert.type] || { emoji: ":information_source:", title: "CST Alert" };
  return [
    `${deco.emoji} *${deco.title}*`,
    `Case: <${caseUrl(alert.id)}|${alert.id}>`,
    `Severity: ${alert.severity ?? "N/A"}`,
    `Owner: ${alert.owner || "Unassigned"}`,
    `Status: ${alert.status}`,
    `Queue: ${alert.queue}`,
    alert.details,
  ].join("\n");
}

/**
 * Slack digest for wrong-queue cases (paragon.py send_slack_table).
 * @param {object[]} flagged  rows with check === true
 * @param {(id:string)=>string} caseUrl
 */
export function formatWrongQueueSlack(flagged, caseUrl) {
  if (!flagged.length) return null;
  const lines = flagged
    .slice(0, 50)
    .map(
      (r) =>
        `• <${caseUrl(r.ID)}|${r.ID}> | Sev: ${r.Severity ?? "N/A"} | Status: ${
          r.Status ?? "N/A"
        } | Queue: ${r.Queue || "Unknown"}`
    );
  let msg = `:warning: *Cases in Wrong Queue - ${flagged.length} Total*\n\n${lines.join("\n")}`;
  if (flagged.length > 50) msg += `\n\n_... and ${flagged.length - 50} more cases._`;
  return msg;
}

/**
 * CSV export of case rows (sweeper.html convertToCSV). The ID column is
 * wrapped as ="..." so Excel keeps it as text.
 */
export function rowsToCsv(rows, columns = [...CASE_COLUMNS, "QueueStatus"]) {
  const esc = (col, v) => {
    const s = v == null ? "" : String(v);
    if (col.toLowerCase() === "id") return `="${s.replace(/"/g, '""')}"`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => esc(c, r[c])).join(","));
  return [head, ...body].join("\n");
}
