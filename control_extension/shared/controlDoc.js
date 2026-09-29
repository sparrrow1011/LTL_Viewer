/**
 * control.json document helpers shared by the background and the page.
 *
 * Schema (what background/control.js in every controlled add-on evaluates):
 *   enabled (global), message (shown when disabled), notice (shown while
 *   enabled), minVersion (+ optional minVersionMessage), admins[],
 *   users{alias:{enabled,message}}, installs{installId:{enabled,message}}.
 *
 * evaluate() is a copy of the add-ons' verdict logic so the page can preview
 * exactly what each install will see once a draft is saved.
 */

export function normalize(d) {
  d = d && typeof d === "object" ? d : {};
  return {
    _readme: d._readme,
    enabled: d.enabled !== false,
    message: d.message || "",
    notice: d.notice || "",
    minVersion: d.minVersion || "",
    minVersionMessage: d.minVersionMessage || "",
    admins: Array.isArray(d.admins) ? d.admins.map((a) => String(a).trim().toLowerCase()).filter(Boolean) : [],
    users: cleanMap(d.users),
    installs: cleanMap(d.installs),
  };
}

function cleanMap(m) {
  const out = {};
  for (const [k, v] of Object.entries(m && typeof m === "object" ? m : {})) {
    const key = String(k).trim().toLowerCase();
    if (!key || !v || typeof v !== "object") continue;
    const e = { enabled: v.enabled !== false };
    if (v.message) e.message = String(v.message);
    out[key] = e;
  }
  return out;
}

/** Key order matches the github.io admin page so either editor yields a minimal diff. */
export function serialize(d) {
  const out = {};
  if (d._readme) out._readme = d._readme;
  out.enabled = d.enabled;
  out.message = d.message;
  out.notice = d.notice;
  out.minVersion = d.minVersion;
  if (d.minVersionMessage) out.minVersionMessage = d.minVersionMessage;
  out.admins = d.admins;
  out.users = d.users;
  out.installs = d.installs;
  return JSON.stringify(out, null, 2) + "\n";
}

export const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Same precedence as control.js evaluate(): version → user → install → global. */
export function evaluate(doc, { alias, installId, version }) {
  if (!doc) return { allowed: true, reason: null };
  if (doc.minVersion && cmpVersion(version || "0", doc.minVersion) < 0) return { allowed: false, reason: "version" };
  const user = alias && doc.users && doc.users[alias];
  if (user && user.enabled === false) return { allowed: false, reason: "user" };
  const inst = installId && doc.installs && doc.installs[installId];
  if (inst && inst.enabled === false) return { allowed: false, reason: "install" };
  if (doc.enabled === false && !(user && user.enabled === true) && !(inst && inst.enabled === true)) return { allowed: false, reason: "global" };
  return { allowed: true, reason: null, override: !!((user && user.enabled === true) || (inst && inst.enabled === true)) };
}

/** Human summary of a draft vs the saved doc — used as the commit message. */
export function summarize(a, b) {
  const parts = [];
  if (a.enabled !== b.enabled) parts.push(b.enabled ? "enable all" : "DISABLE all");
  if (a.minVersion !== b.minVersion) parts.push(`minVersion ${b.minVersion || "cleared"}`);
  if ((a.minVersionMessage || "") !== (b.minVersionMessage || "")) parts.push("minVersion message changed");
  if (a.notice !== b.notice) parts.push(b.notice ? "notice set" : "notice cleared");
  if (a.message !== b.message) parts.push("message changed");
  if (a.admins.join() !== b.admins.join()) parts.push(`admins: ${b.admins.join(", ") || "none"}`);
  for (const kind of ["users", "installs"]) {
    const ak = Object.keys(a[kind]), bk = Object.keys(b[kind]);
    for (const k of bk) if (!ak.includes(k) || JSON.stringify(a[kind][k]) !== JSON.stringify(b[kind][k])) parts.push(`${b[kind][k].enabled === false ? "disable" : "allow"} ${k}`);
    for (const k of ak) if (!bk.includes(k)) parts.push(`remove ${k}`);
  }
  return parts.join(", ") || "no-op";
}
