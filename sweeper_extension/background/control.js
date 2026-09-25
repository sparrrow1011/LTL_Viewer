/**
 * Remote control — a small JSON file on the repo's `updates` branch decides
 * whether this install may run, globally or per user.
 *
 *   https://raw.githubusercontent.com/<repo>/updates/<slug>/control.json
 *   {
 *     "enabled": true,                 // global kill switch
 *     "message": "",                   // shown in the page banner when disabled
 *     "minVersion": "0.2.7",           // older installs refuse to run until updated
 *     "users": {                       // per-alias overrides (SMC requester, lowercase)
 *       "jdoe": { "enabled": false, "message": "Paused — talk to Mayowa" }
 *     },
 *     "installs": {                    // per-install-id overrides (fallback when no alias)
 *       "4f1c…": { "enabled": false }
 *     }
 *   }
 *
 * Identity: the SMC signed-in alias (stable, meaningful) plus a random install
 * id generated once (fallback, and lets you target one machine). Both shown in
 * Settings so the admin can add someone to the file.
 *
 * Cooperative control, not security: it manages normal use. A fetch failure
 * keeps the last verdict (never lock people out on a network blip); no cached
 * verdict at all = allowed.
 *
 * This file is shared verbatim between sweeper_extension/ and extension/ —
 * keep them identical. Only `init()` args differ.
 */

const KEY = "control";
const ALLOW = { allowed: true, reason: null, message: "" };

let cfg = {
  url: null,
  version: "0",
  slug: "",
  getAlias: async () => null, // returns the SMC alias or null
  refreshMinutes: 15,
  log: { info() {}, warn() {}, debug() {}, error() {} },
};
let _refreshing = null;

export function init(options) {
  cfg = { ...cfg, ...options };
}

async function getStored() {
  const got = await browser.storage.local.get(KEY);
  return got[KEY] || { installId: null, alias: null, verdict: null, doc: null, fetchedAt: null, error: null };
}

async function setStored(patch) {
  const cur = await getStored();
  const next = { ...cur, ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export async function getInstallId() {
  const s = await getStored();
  if (s.installId) return s.installId;
  const id = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 16) : Math.random().toString(36).slice(2, 18);
  await setStored({ installId: id });
  return id;
}

/** Current identity for display: { alias, installId }. Alias may be null offline. */
export async function identity() {
  const installId = await getInstallId();
  const s = await getStored();
  let alias = s.alias;
  try {
    const fresh = await cfg.getAlias();
    if (fresh) {
      alias = String(fresh).trim().toLowerCase();
      if (alias !== s.alias) await setStored({ alias });
    }
  } catch (_) {
    /* keep the stored alias */
  }
  return { alias, installId };
}

const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Pure: evaluate a control document for this identity/version. */
export function evaluate(doc, { alias, installId, version }) {
  if (!doc || typeof doc !== "object") return ALLOW;
  if (doc.minVersion && cmpVersion(version, doc.minVersion) < 0) {
    return {
      allowed: false,
      reason: "version",
      message: doc.minVersionMessage || `Version ${version} is no longer allowed (minimum ${doc.minVersion}). Update the add-on: about:addons → gear → Check for Updates.`,
    };
  }
  const user = alias && doc.users && doc.users[alias];
  if (user && user.enabled === false) {
    return { allowed: false, reason: "user", message: user.message || doc.message || `This add-on has been disabled for ${alias}.` };
  }
  const inst = installId && doc.installs && doc.installs[installId];
  if (inst && inst.enabled === false) {
    return { allowed: false, reason: "install", message: inst.message || doc.message || "This add-on has been disabled on this computer." };
  }
  if (doc.enabled === false && !(user && user.enabled === true) && !(inst && inst.enabled === true)) {
    return { allowed: false, reason: "global", message: doc.message || "This add-on is currently disabled for everyone." };
  }
  return { ...ALLOW, notice: doc.notice || "" };
}

/**
 * Fetch control.json and store the verdict. Never throws; on failure keeps
 * the previous verdict and records the error.
 */
export async function refresh() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    const id = await identity();
    if (!cfg.url) return { ...ALLOW, ...id };
    try {
      const res = await fetch(`${cfg.url}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (res.status === 404) {
        // No control file published yet = nothing is restricted.
        const v = { ...ALLOW, ...id, fetchedAt: Date.now() };
        await setStored({ verdict: v, doc: null, fetchedAt: Date.now(), error: null });
        return v;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      const v = { ...evaluate(doc, { ...id, version: cfg.version }), ...id, fetchedAt: Date.now() };
      await setStored({ verdict: v, doc, fetchedAt: Date.now(), error: null });
      if (!v.allowed) cfg.log.warn("control", `disabled (${v.reason}): ${v.message}`);
      else cfg.log.debug("control", `allowed (alias ${id.alias || "?"}, install ${id.installId})`);
      return v;
    } catch (e) {
      const s = await setStored({ error: `${e.message} @ ${new Date().toISOString()}` });
      cfg.log.warn("control", `control.json unreachable (${e.message}) — keeping last verdict`);
      return s.verdict || { ...ALLOW, ...id };
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

/** Verdict to enforce right now: refreshes if stale (older than refreshMinutes). */
export async function check({ force = false } = {}) {
  const s = await getStored();
  const stale = !s.fetchedAt || Date.now() - s.fetchedAt > cfg.refreshMinutes * 60_000;
  if (force || stale || !s.verdict) return refresh();
  return s.verdict;
}

/** Throw a tagged error if this install is not allowed to run. */
export async function assertAllowed(what = "run") {
  const v = await check();
  if (v.allowed) return v;
  const err = new Error(v.message);
  err.controlBlocked = true;
  err.reason = v.reason;
  cfg.log.warn("control", `${what} refused: ${v.message}`);
  throw err;
}

/** For the UI: identity + current verdict + last fetch status. */
export async function status() {
  const s = await getStored();
  const id = await identity();
  return {
    ...id,
    url: cfg.url,
    verdict: s.verdict || ALLOW,
    fetchedAt: s.fetchedAt,
    error: s.error,
    doc: s.doc,
  };
}
