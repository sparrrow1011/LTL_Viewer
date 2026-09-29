/**
 * Install roster — reads the Extension_Installs SharePoint list that every
 * controlled add-on's usage.js writes to (one row per install).
 *
 *   Title = "<slug>|<installId>", columns Extension, Alias, Version (or
 *   ExtVersion when the built-in read-only "Version" collided), FirstSeen,
 *   LastSeen, LastRun, Runs, Browser.
 *
 * Display titles are resolved to internal names from /fields, same as
 * usage.roster() does, so a renamed column still maps back.
 */

import { Config } from "../config.js";
import * as sp from "./spClient.js";

const LIST = Config.ROSTER_LIST;
const COLUMNS = ["Extension", "Alias", "Version", "FirstSeen", "LastSeen", "LastRun", "Runs", "Browser"];

let _map = null;

async function fieldMap() {
  if (_map) return _map;
  const f = await sp.spGet(sp.listPath(LIST, "/fields?$select=InternalName,Title,Hidden,ReadOnlyField&$top=500"));
  const byTitle = new Map();
  for (const x of f.value || []) {
    if (!x.Title || !x.InternalName) continue;
    const cur = byTitle.get(x.Title);
    if (!cur || ((cur.Hidden || cur.ReadOnlyField) && !(x.Hidden || x.ReadOnlyField))) byTitle.set(x.Title, x);
  }
  const map = {};
  for (const col of COLUMNS) {
    const hit = [byTitle.get(col), byTitle.get(`Ext${col}`)].find((x) => x && !x.ReadOnlyField);
    if (!hit) throw new Error(`column '${col}' missing on '${LIST}' — has any add-on reported yet?`);
    map[col] = hit.InternalName;
  }
  _map = map;
  return map;
}

/** Every install row across all add-ons. Throws with .expired on a sign-in problem. */
export async function roster() {
  const map = await fieldMap();
  const sel = ["Id", "Title", ...Object.values(map)].join(",");
  const data = await sp.spGet(sp.listPath(LIST, `/items?$select=${sel}&$top=2000`), { paged: true });
  const rows = (data.value || []).map((x) => ({
    id: x.Id,
    extension: x[map.Extension] || "",
    installId: String(x.Title || "").split("|")[1] || "",
    alias: x[map.Alias] || "",
    version: x[map.Version] || "",
    firstSeen: x[map.FirstSeen] || "",
    lastSeen: x[map.LastSeen] || "",
    lastRun: x[map.LastRun] || "",
    runs: Number(x[map.Runs] || 0),
    browser: x[map.Browser] || "",
  }));
  return { rows, listUrl: sp.listUrl(LIST), fetchedAt: new Date().toISOString() };
}

/** Delete one roster row (a retired laptop, a duplicate). The add-on re-creates it on its next report. */
export async function removeRow(id) {
  if (!Number.isInteger(id)) throw new Error("row id required");
  await sp.spWrite(sp.listPath(LIST, `/items(${id})`), { method: "DELETE" });
  return { removed: id };
}
