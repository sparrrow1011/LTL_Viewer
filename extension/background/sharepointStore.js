/**
 * SharePoint-backed storage adapter — team-scoped lists.
 *
 * Public API (every call takes the team key, e.g. "LTL" / "CST"):
 *   loadRuns(team) / saveRuns(team, rows)   — the team's RECORDS list: one item
 *                                             per (orderid, vrid) annotation
 *   loadShippers(team) / saveShippers(team, rows)
 *                                           — the team's shipper source-of-truth
 *                                             list (only for teams with
 *                                             Config.TEAMS[team].shipperList)
 *   rowKey(row)   -> "orderid|vrid"
 *   indexByKey(rows)
 *
 * Storage model: one SharePoint List item per logical row. The row identity is
 * stored in the item's `Title`; the full row dict is JSON-serialized in a
 * `Payload` multiline-text column, with key fields promoted to their own columns
 * so the list is readable in the SharePoint UI. Lists are auto-created on first
 * use.
 *
 * NOTE on concurrency: per-item upserts let many browsers write different
 * rows without clobbering. save*() diffs against what SharePoint currently holds
 * and issues per-item add/update/delete.
 */

import { Config } from "../config.js";
import { spGet, spWrite, listPath, SpError } from "./spClient.js";
import { log } from "./debug.js";

const KEY_SEP = "|";

// ── team → list definitions ───────────────────────────────────────────────────

export function teamConfig(team) {
  const key = String(team || Config.DEFAULT_TEAM).toUpperCase();
  const cfg = Config.TEAMS[key];
  if (!cfg) throw new Error(`Unknown team: ${team}`);
  return cfg;
}

// Records list: one item per (orderid, vrid) manual-sourcing/email annotation.
const RECORD_PROMOTED = [
  "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
  "email_sent", "email_generated_at",
  // outcome (written by the FMC sweep) + auto-tracking
  "final_carrier", "covered_at", "first_seen_at",
];

function recordsDef(team) {
  const cfg = teamConfig(team);
  return {
    kind: "records",
    title: cfg.spList,
    columns: [
      { name: "Payload", type: "Note" },
      { name: "orderid", type: "Text" },
      { name: "vrid", type: "Text" },
      ...RECORD_PROMOTED.map((name) => ({ name, type: "Text" })),
    ],
    keyOf: rowKey,
    // Row -> item fields (Title/Payload + promoted columns).
    toFields(row) {
      const fields = { Title: rowKey(row), Payload: JSON.stringify(row) };
      fields.orderid = String(row.orderid ?? "");
      fields.vrid = String(row.vrid ?? "");
      for (const f of RECORD_PROMOTED) {
        const v = row[f];
        fields[f] = v == null ? "" : String(v);
      }
      return fields;
    },
    // Fallback when Payload is missing/corrupt.
    fromTitle(title) {
      const [orderid = "", vrid = ""] = String(title || "").split(KEY_SEP);
      return { orderid, vrid };
    },
  };
}

// Shipper source-of-truth list: one item per shipper (Title = shipperid).
const SHIPPER_PROMOTED = ["shippername", "shipper_group"];

function shippersDef(team) {
  const cfg = teamConfig(team);
  if (!cfg.shipperList) throw new Error(`Team ${cfg.key} has no shipper list`);
  return {
    kind: "shippers",
    title: cfg.shipperList,
    columns: [
      { name: "Payload", type: "Note" },
      ...SHIPPER_PROMOTED.map((name) => ({ name, type: "Text" })),
    ],
    keyOf: (row) => String(row.shipperid ?? "").trim(),
    toFields(row) {
      const fields = { Title: String(row.shipperid ?? "").trim(), Payload: JSON.stringify(row) };
      for (const f of SHIPPER_PROMOTED) {
        const v = row[f];
        fields[f] = v == null ? "" : String(v);
      }
      return fields;
    },
    fromTitle(title) {
      return { shipperid: String(title || "").trim() };
    },
  };
}

// ── identity ──────────────────────────────────────────────────────────────────

export function rowKey(row) {
  return `${String(row.orderid ?? "")}${KEY_SEP}${String(row.vrid ?? "")}`;
}

// ── list provisioning ─────────────────────────────────────────────────────────

const _ensured = new Set();

/** Create the list + its columns if missing. Idempotent, cached per session. */
async function ensureList(def) {
  if (_ensured.has(def.title)) return def.title;

  log.debug("ensureList", `checking list '${def.title}'`);
  let exists = true;
  try {
    await spGet(listPath(def.title));
  } catch (e) {
    if (e instanceof SpError && (e.status === 404 || e.status === 500)) {
      exists = false;
    } else {
      log.error("ensureList", e, `unexpected error checking '${def.title}'`);
      throw e;
    }
  }

  if (!exists) {
    log.info("ensureList", `creating list '${def.title}'`);
    // 100 = GenericList template.
    await spWrite("/web/lists", {
      method: "POST",
      body: { BaseTemplate: 100, Title: def.title, AllowContentTypes: false },
    });
  } else {
    log.debug("ensureList", `list '${def.title}' exists`);
  }

  // Ensure columns (Title already exists on every list).
  const existingCols = await _existingFieldNames(def.title);
  for (const col of def.columns) {
    if (existingCols.has(col.name)) continue;
    log.info("ensureList", `adding column '${col.name}' (${col.type}) to '${def.title}'`);
    // FieldTypeKind: 2=Text, 3=Note(multiline). Send ONLY base SP.Field props —
    // type-specific ones (RichText/NumberOfLines) belong to the subtype and get
    // rejected on this generic endpoint. A default Note field is fine: we only
    // ever store/read the raw JSON string via REST.
    const kind = col.type === "Note" ? 3 : 2;
    await spWrite(listPath(def.title, "/fields"), {
      method: "POST",
      body: { Title: col.name, FieldTypeKind: kind },
    });
    log.debug("ensureList", `column '${col.name}' created`);
  }

  _ensured.add(def.title);
  log.debug("ensureList", `'${def.title}' ready`);
  return def.title;
}

async function _existingFieldNames(listTitle) {
  try {
    const data = await spGet(
      listPath(listTitle, "/fields?$select=InternalName,Title&$top=500")
    );
    const names = new Set();
    for (const f of data.value || []) {
      if (f.InternalName) names.add(f.InternalName);
      if (f.Title) names.add(f.Title);
    }
    return names;
  } catch {
    return new Set();
  }
}

// ── item -> row mapping ───────────────────────────────────────────────────────

function _itemToRow(def, item) {
  if (item.Payload) {
    try {
      return { __id: item.Id, ...JSON.parse(item.Payload) };
    } catch {
      /* fall through */
    }
  }
  // Payload missing/corrupt: reconstruct minimally from Title.
  return { __id: item.Id, ...def.fromTitle(item.Title) };
}

// ── generic load/save over a list ───────────────────────────────────────────────

async function _loadAll(def) {
  // Ensure the list + its columns exist before selecting them — otherwise a
  // half-provisioned list (list present, Payload column missing) 400s the read.
  let title;
  try {
    title = await ensureList(def);
  } catch (e) {
    log.warn("load", `ensureList failed (${def.title}); treating as empty:`, e && e.message);
    return [];
  }

  try {
    const data = await spGet(
      listPath(title, "/items?$select=Id,Title,Payload&$top=5000"),
      { paged: true }
    );
    const rows = (data.value || []).map((it) => _itemToRow(def, it));
    log.debug("load", `${def.kind} ('${title}'): ${rows.length} rows`);
    return rows;
  } catch (e) {
    // Missing list / missing column == empty store (tolerant). A missing
    // Payload column self-heals on the next ensureList/write.
    if (
      e instanceof SpError &&
      (e.status === 404 || e.status === 500 || e.status === 400)
    ) {
      log.debug("load", `${def.kind} ('${title}'): not readable yet (HTTP ${e.status}) → []`);
      return [];
    }
    log.error("load", e, `loading ${def.kind} ('${title}')`);
    throw e;
  }
}

/**
 * Reconcile the target list to exactly `rows` (keyed by Title). Adds new items,
 * updates changed payloads, deletes items no longer present. Per-item ops so
 * concurrent writers to *different* rows don't collide.
 */
async function _reconcile(def, rows) {
  const title = await ensureList(def);

  // Current items keyed by Title, with Id + etag-free payload compare.
  const current = await spGet(
    listPath(title, "/items?$select=Id,Title,Payload&$top=5000"),
    { paged: true }
  );
  const currentByTitle = new Map();
  for (const it of current.value || []) currentByTitle.set(String(it.Title), it);

  const desiredByTitle = new Map();
  for (const row of rows) {
    const fields = def.toFields(row);
    if (!fields.Title) continue; // no identity → skip
    desiredByTitle.set(fields.Title, fields);
  }

  const itemsPath = listPath(title, "/items");
  let added = 0;
  let updated = 0;
  let deleted = 0;

  // Adds + updates.
  for (const [titleKey, fields] of desiredByTitle) {
    const existing = currentByTitle.get(titleKey);
    if (!existing) {
      await spWrite(itemsPath, { method: "POST", body: fields });
      added += 1;
    } else if (existing.Payload !== fields.Payload) {
      await spWrite(listPath(title, `/items(${existing.Id})`), {
        method: "MERGE",
        body: fields,
      });
      updated += 1;
    }
  }

  // Deletes (present in SharePoint but not in desired set).
  for (const [titleKey, existing] of currentByTitle) {
    if (!desiredByTitle.has(titleKey)) {
      await spWrite(listPath(title, `/items(${existing.Id})`), { method: "DELETE" });
      deleted += 1;
    }
  }

  log.info(
    "reconcile",
    `${def.kind} ('${title}'): +${added} ~${updated} -${deleted} (desired=${desiredByTitle.size}, had=${currentByTitle.size})`
  );
  return { added, updated, deleted, total: desiredByTitle.size };
}

// ── public API ────────────────────────────────────────────────────────────────

export async function loadRuns(team) {
  return _loadAll(recordsDef(team));
}
export async function saveRuns(team, rows) {
  return _reconcile(recordsDef(team), rows);
}

export async function loadShippers(team) {
  return _loadAll(shippersDef(team));
}
export async function saveShippers(team, rows) {
  return _reconcile(shippersDef(team), rows);
}

export function indexByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(rowKey(r), r);
  return m;
}
