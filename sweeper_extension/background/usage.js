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

/** Create the list + text columns if missing (idempotent, once per session). */
async function ensureList() {
  if (_ensured) return;
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
  let have = new Set();
  try {
    const f = await req("GET", listPath("/fields?$select=InternalName,Title&$top=500"));
    for (const x of f.value || []) {
      if (x.InternalName) have.add(x.InternalName);
      if (x.Title) have.add(x.Title);
    }
  } catch (_) {
    have = new Set();
  }
  for (const col of [...COLUMNS, "Payload"]) {
    if (have.has(col)) continue;
    cfg.log.info("usage", `adding column '${col}' to '${LIST}'`);
    await req("POST", listPath("/fields"), { Title: col, FieldTypeKind: col === "Payload" ? 3 : 2 });
  }
  _ensured = true;
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
      const fields = {
        Title: `${cfg.slug}|${installId}`,
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

      await ensureList();

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
