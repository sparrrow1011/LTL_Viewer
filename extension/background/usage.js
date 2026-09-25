/**
 * Usage roster — one SharePoint list item per install, so the admin can see
 * who has the extension, which version, and when it was first/last used.
 *
 * List: Extension_Installs on the AmazonFreightOperations site (auto-created).
 *   Title       = "<slug>|<installId>"        (unique key)
 *   Extension   = slug
 *   Alias       = SMC signed-in alias (lowercase) or ""
 *   Version     = manifest version
 *   FirstSeen   = ISO time this install first reported
 *   LastSeen    = ISO time of the latest report
 *   LastRun     = ISO time of the latest sweep/load run ("" if none)
 *   Runs        = total run count (string)
 *   Browser     = UA short string
 *   Payload     = JSON of all the above (self-describing)
 *
 * Report policy: on background start, then at most once per REPORT_MINUTES,
 * plus immediately after a run (still throttled). Failures are logged and
 * swallowed — the roster must never block the actual work.
 *
 * Shared verbatim between sweeper_extension/ and extension/ — keep identical.
 * Only init() differs (slug, spRequest, getAlias).
 */

const LIST = "Extension_Installs";
const COLUMNS = ["Extension", "Alias", "Version", "FirstSeen", "LastSeen", "LastRun", "Runs", "Browser"];
const KEY = "usage"; // storage: { firstSeen, lastReportAt, itemId, runs, lastRun }
const REPORT_MINUTES = 60;

let cfg = {
  slug: "",
  version: "0",
  /** (req:{method,path,body,etag}) => {ok,status,data,body} — same shape as sp:req */
  spRequest: null,
  getAlias: async () => null,
  getInstallId: async () => "",
  log: { info() {}, warn() {}, debug() {}, error() {} },
};
let _ensured = false;
let _inflight = null;

export function init(options) {
  cfg = { ...cfg, ...options };
}

const listPath = (suffix = "") => `/web/lists/getbytitle('${encodeURIComponent(LIST)}')${suffix}`;

async function stored() {
  const got = await browser.storage.local.get(KEY);
  return got[KEY] || { firstSeen: null, lastReportAt: 0, itemId: null, runs: 0, lastRun: null };
}
async function store(patch) {
  const cur = await stored();
  const next = { ...cur, ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

async function req(method, path, body) {
  const r = await cfg.spRequest({ method, path, body, etag: "*" });
  if (!r || !r.ok) {
    const err = new Error(`${method} ${path} → HTTP ${r ? r.status : 0}${r && r.body ? `: ${String(r.body).slice(0, 200)}` : ""}`);
    err.status = r ? r.status : 0;
    err.expired = !!(r && r.expired);
    throw err;
  }
  return r.data;
}

// Display title -> InternalName for our columns. SharePoint does NOT keep the
// title as the internal name when it collides with a built-in (e.g. "Version"
// becomes "Version0") or contains special chars, and item POST/MERGE must use
// the internal name or it 400s. Resolved once per session from /fields.
let _internal = null;

async function readFieldMap() {
  const f = await req("GET", listPath("/fields?$select=InternalName,Title,Hidden,ReadOnlyField&$top=500"));
  const byTitle = new Map();
  for (const x of f.value || []) {
    if (!x.Title || !x.InternalName) continue;
    // Prefer a writable, non-hidden field when several share a title.
    const cur = byTitle.get(x.Title);
    if (!cur || (cur.Hidden || cur.ReadOnlyField) && !(x.Hidden || x.ReadOnlyField)) byTitle.set(x.Title, x);
  }
  return byTitle;
}

/** Create the list + text columns if missing; resolve internal names. */
async function ensureList() {
  if (_ensured && _internal) return _internal;
  let exists = true;
  try {
    await req("GET", listPath());
  } catch (e) {
    if (e.status === 404 || e.status === 500) exists = false;
    else throw e;
  }
  if (!exists) {
    cfg.log.info("usage", `creating SharePoint list '${LIST}'`);
    await req("POST", "/web/lists", { BaseTemplate: 100, Title: LIST, AllowContentTypes: false });
  }
  let byTitle = await readFieldMap();
  const wanted = [...COLUMNS, "Payload"];
  let added = false;
  for (const col of wanted) {
    const f = byTitle.get(col);
    if (f && !f.ReadOnlyField) continue;
    // Built-in read-only fields (e.g. "Version") can't be written: create our
    // own column with a safe title instead ("Version" -> "ExtVersion").
    const title = f && f.ReadOnlyField ? `Ext${col}` : col;
    if (byTitle.has(title) && !byTitle.get(title).ReadOnlyField) continue;
    cfg.log.info("usage", `adding column '${title}' to '${LIST}'`);
    await req("POST", listPath("/fields"), { Title: title, FieldTypeKind: col === "Payload" ? 3 : 2 });
    added = true;
  }
  if (added) byTitle = await readFieldMap();
  const map = {};
  for (const col of wanted) {
    const f = [byTitle.get(col), byTitle.get(`Ext${col}`)].find((x) => x && !x.ReadOnlyField);
    if (!f) throw new Error(`column '${col}' missing on '${LIST}' after provisioning`);
    map[col] = f.InternalName;
  }
  cfg.log.debug("usage", `field map: ${JSON.stringify(map)}`);
  _internal = map;
  _ensured = true;
  return map;
}

function browserShort() {
  const m = navigator.userAgent.match(/Firefox\/(\d+)/);
  return m ? `Firefox ${m[1]}` : navigator.userAgent.slice(0, 40);
}

/**
 * Upsert this install's row. `reason` is for the log only.
 * @param {{force?:boolean, ran?:boolean}} opts  ran=true bumps Runs/LastRun
 */
export async function report(reason = "tick", { force = false, ran = false } = {}) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const st = await stored();
      const now = Date.now();
      let runs = st.runs || 0;
      let lastRun = st.lastRun;
      if (ran) {
        runs += 1;
        lastRun = new Date(now).toISOString();
        await store({ runs, lastRun });
      }
      if (!force && st.lastReportAt && now - st.lastReportAt < REPORT_MINUTES * 60_000) {
        cfg.log.debug("usage", `report skipped (${reason}) — last ${Math.round((now - st.lastReportAt) / 60000)} min ago`);
        return { skipped: true };
      }
      const installId = await cfg.getInstallId();
      let alias = null;
      try {
        alias = await cfg.getAlias();
      } catch (_) {
        /* offline SMC — leave blank */
      }
      alias = alias ? String(alias).trim().toLowerCase() : "";
      const firstSeen = st.firstSeen || new Date(now).toISOString();
      const row = {
        slug: cfg.slug,
        installId,
        alias,
        version: cfg.version,
        firstSeen,
        lastSeen: new Date(now).toISOString(),
        lastRun: lastRun || "",
        runs,
        browser: browserShort(),
      };
      const map = await ensureList();
      const byTitle = {
        Extension: cfg.slug,
        Alias: alias,
        Version: cfg.version,
        FirstSeen: firstSeen,
        LastSeen: row.lastSeen,
        LastRun: row.lastRun,
        Runs: String(runs),
        Browser: row.browser,
        Payload: JSON.stringify(row),
      };
      const fields = { Title: `${cfg.slug}|${installId}` };
      for (const [t, v] of Object.entries(byTitle)) fields[map[t]] = v;

      // Find our item (by remembered Id, else by Title) and MERGE; else POST.
      let itemId = st.itemId;
      if (itemId) {
        try {
          await req("MERGE", listPath(`/items(${itemId})`), fields);
        } catch (e) {
          if (e.status !== 404) throw e;
          itemId = null; // row deleted by an admin — recreate
        }
      }
      if (!itemId) {
        const q = listPath(`/items?$select=Id&$filter=Title eq '${encodeURIComponent(fields.Title).replace(/'/g, "''")}'&$top=1`);
        const found = await req("GET", q);
        const hit = (found.value || [])[0];
        if (hit) {
          itemId = hit.Id;
          await req("MERGE", listPath(`/items(${itemId})`), fields);
        } else {
          const created = await req("POST", listPath("/items"), fields);
          itemId = created && created.Id;
        }
      }
      await store({ firstSeen, lastReportAt: now, itemId });
      cfg.log.info("usage", `reported (${reason}): ${alias || "no alias"} · ${cfg.slug} ${cfg.version} · runs ${runs}`);
      return { ok: true, itemId };
    } catch (e) {
      // Never let the roster interfere with real work.
      cfg.log.warn("usage", `report failed (${reason}): ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** For the UI: what this install has recorded locally. */
export async function local() {
  return stored();
}

/**
 * Read every install row (both extensions). Uses the resolved internal names
 * so a renamed column ("Version" -> "Version0") still maps back correctly.
 * Throws with .expired on a SharePoint sign-in problem.
 */
export async function roster() {
  const map = await ensureList();
  const sel = ["Id", "Title", ...Object.values(map).filter((n) => n !== map.Payload)].join(",");
  const data = await req("GET", listPath(`/items?$select=${sel}&$top=2000`));
  return (data.value || []).map((x) => ({
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
}
