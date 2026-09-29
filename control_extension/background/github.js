/**
 * GitHub contents API client for the `updates` branch.
 *
 * Reads and writes `<slug>/control.json` exactly like the github.io admin page
 * did (GET for content + sha, PUT with sha), so both editors stay compatible
 * and the controlled add-ons see no difference.
 *
 * The token is a fine-grained personal access token for OWNER/REPO with
 * "Contents: Read and write". It lives in browser.storage.local (private to
 * this add-on) — never in a page's localStorage.
 */

import { Config } from "../config.js";
import { log } from "./debug.js";
import { cmpVersion } from "../shared/controlDoc.js";

const KEY = "github"; // storage: { token }
const API = `https://api.github.com/repos/${Config.OWNER}/${Config.REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${Config.OWNER}/${Config.REPO}/${Config.BRANCH}`;

export class GitHubError extends Error {
  constructor(message, status = 0, body = "") {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

// ── token ─────────────────────────────────────────────────────────────────────

export async function getToken() {
  const got = await browser.storage.local.get(KEY);
  return (got[KEY] && got[KEY].token) || "";
}

export async function setToken(token) {
  await browser.storage.local.set({ [KEY]: { token: String(token || "").trim() } });
  return { saved: !!String(token || "").trim() };
}

function headers(token, extra = {}) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Who the stored token belongs to, and whether it can write to the repo.
 * { login, hasToken, canWrite, writeProblem } — canWrite is null when GitHub
 * didn't say. Throws only if the token itself is rejected.
 *
 * A fine-grained token passes /user yet can't write when it was created with
 * "Public repositories (read-only)" access, without this repo selected, or
 * with Contents left at "Read" — so we look at the repo's `permissions.push`.
 */
export async function whoami() {
  const token = await getToken();
  if (!token) return { login: null, hasToken: false, canWrite: null, writeProblem: null };
  const r = await fetch("https://api.github.com/user", { headers: headers(token), cache: "no-store" });
  if (!r.ok) throw new GitHubError(`token rejected by GitHub (HTTP ${r.status})`, r.status, await safeText(r));
  const u = await r.json();
  let canWrite = null, writeProblem = null;
  try {
    const rr = await fetch(`https://api.github.com/repos/${Config.OWNER}/${Config.REPO}`, { headers: headers(token), cache: "no-store" });
    if (rr.status === 404) {
      canWrite = false;
      writeProblem = `the token has no access to ${Config.OWNER}/${Config.REPO} — edit it: Repository access → Only select repositories → ${Config.REPO}`;
    } else if (rr.ok) {
      const repo = await rr.json();
      if (repo.permissions && typeof repo.permissions.push === "boolean") {
        canWrite = repo.permissions.push;
        if (!canWrite) writeProblem = `the token is read-only on ${Config.REPO} — edit it: Repository permissions → Contents → Read and write (and not "Public repositories (read-only)")`;
      }
    }
  } catch (_) {
    /* leave canWrite null — the save path reports precisely anyway */
  }
  return { login: u.login, hasToken: true, canWrite, writeProblem };
}

/** GitHub's own "message" from an error body, if any. */
async function apiMessage(res) {
  const text = await safeText(res);
  try {
    const m = JSON.parse(text).message;
    return m ? ` GitHub says: "${m}".` : "";
  } catch {
    return text ? ` ${text}` : "";
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

const utf8ToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const base64ToUtf8 = (b64) => {
  const bin = atob(String(b64 || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

// ── files ─────────────────────────────────────────────────────────────────────

/**
 * Read a file on the updates branch via the API (always fresh, includes sha).
 * Returns { exists:false } on 404. Unauthenticated works for the public repo
 * (60 req/h); the token lifts that to 5000.
 */
export async function readFile(path) {
  const token = await getToken();
  const r = await fetch(`${API}/${path}?ref=${Config.BRANCH}&t=${Date.now()}`, { headers: headers(token), cache: "no-store" });
  if (r.status === 404) return { exists: false, sha: null, text: null };
  if (!r.ok) throw new GitHubError(`read ${path}: HTTP ${r.status}`, r.status, await safeText(r));
  const meta = await r.json();
  return { exists: true, sha: meta.sha, text: base64ToUtf8(meta.content) };
}

/** Read a public file straight from raw.githubusercontent.com (no API quota). */
export async function readRaw(path) {
  const r = await fetch(`${RAW}/${path}?t=${Date.now()}`, { cache: "no-store" });
  if (r.status === 404) return { exists: false, text: null };
  if (!r.ok) throw new GitHubError(`raw ${path}: HTTP ${r.status}`, r.status, await safeText(r));
  return { exists: true, text: await r.text() };
}

/**
 * Create or update a file on the updates branch. `sha` must be the sha you
 * read (null to create). A 409/422 means someone else saved in between —
 * the caller should reload and re-apply.
 */
export async function writeFile(path, text, message, sha) {
  const token = await getToken();
  if (!token) throw new GitHubError("No GitHub token saved — set one in the header first.", 401);
  const body = { message, content: utf8ToBase64(text), branch: Config.BRANCH };
  if (sha) body.sha = sha;
  log.info("github", `PUT ${path} (${message})`);
  const r = await fetch(`${API}/${path}`, {
    method: "PUT",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (r.status === 403 || r.status === 404) {
    // 404 on a PUT is how GitHub answers a fine-grained token that wasn't granted this repo.
    throw new GitHubError(
      `Write refused (HTTP ${r.status}).${await apiMessage(r)} On the token page set Repository access → Only select repositories → ${Config.REPO} (not "Public repositories (read-only)") and Repository permissions → Contents → Read and write.`,
      r.status
    );
  }
  if (r.status === 409 || r.status === 422) {
    throw new GitHubError(`${path} changed on GitHub since you loaded it (HTTP ${r.status}).${await apiMessage(r)} Reload and re-apply your change.`, r.status);
  }
  if (!r.ok) throw new GitHubError(`write ${path}: HTTP ${r.status}.${await apiMessage(r)}`, r.status);
  const out = await r.json();
  return { sha: out.content && out.content.sha, commit: out.commit && out.commit.sha };
}

/** Latest published version of a slug, from its updates.json (or "" if none). */
export async function latestVersion(slug) {
  const r = await readRaw(`${slug}/updates.json`);
  if (!r.exists) return "";
  try {
    const u = JSON.parse(r.text);
    const vs = Object.values(u.addons || {}).flatMap((a) => (a.updates || []).map((x) => x.version));
    return vs.sort(cmpVersion).pop() || "";
  } catch {
    return "";
  }
}

