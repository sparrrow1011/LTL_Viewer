/**
 * Extension Control — page logic.
 *
 * Dashboard layout: a sidebar lists the views (Overview, one entry per
 * controlled add-on, Installs, Settings); the content area shows one view at a
 * time. Each add-on view is a draft of its control.json (Save writes it through
 * the background) plus the installs of that add-on. The Installs view is the
 * live roster from SharePoint whose State column previews the current drafts.
 * Everything goes through the background router.
 */
import { normalize, serialize, cmpVersion, evaluate, summarize } from "../shared/controlDoc.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const DAY = 86_400_000;

async function call(action, payload = {}) {
  const r = await browser.runtime.sendMessage({ action, ...payload });
  if (!r) throw new Error(`No reply from the background for ${action} — reload this page.`);
  if (!r.ok) {
    const e = new Error(r.error || `${action} failed`);
    e.status = r.status;
    e.expired = !!r.expired;
    e.permission = !!r.permission;
    throw e;
  }
  return r.data;
}

let cfg = null;
const state = {}; // slug → { name, doc, orig, sha, latest, card, error }
let roster = null; // { rows, listUrl, fetchedAt }
let login = null;
let tokenProblem = null; // why the token can't write, if known
let view = { name: "overview", slug: null };

const extName = (slug) => ((cfg && cfg.exts.find((x) => x.slug === slug)) || { name: slug }).name;

function banner(kind, html) {
  const b = $("#banner");
  if (!html) {
    b.hidden = true;
    return;
  }
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
  b.scrollIntoView({ block: "nearest" });
}

// ── views / sidebar ───────────────────────────────────────────────────────────

function showView(name, slug = null) {
  view = { name, slug };
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${name}`;
  if (name === "ext") for (const c of document.querySelectorAll("#extCards .ext")) c.hidden = c.dataset.slug !== slug;
  for (const b of document.querySelectorAll(".nav")) {
    const on = b.dataset.view === name && (name !== "ext" || b.dataset.slug === slug);
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  }
  const hash = name === "ext" ? `ext/${slug}` : name;
  if (location.hash.replace(/^#/, "") !== hash) history.replaceState(null, "", `#${hash}`);
  if (name === "overview") renderOverview();
}

function applyHash() {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^ext\/(.+)$/);
  if (m && cfg.exts.some((x) => x.slug === m[1])) showView("ext", m[1]);
  else if (["installs", "settings"].includes(h)) showView(h);
  else showView("overview");
}

/** Saved-state summary for one add-on: { cls, text } for pills, dots and tiles. */
function savedState(slug) {
  const s = state[slug];
  if (!s || s.error) return { cls: "muted", text: "unavailable" };
  const o = s.orig;
  const offUsers = Object.values(o.users).filter((u) => u.enabled === false).length;
  const offInst = Object.values(o.installs).filter((u) => u.enabled === false).length;
  if (!o.enabled) return { cls: "bad", text: "DISABLED for everyone" };
  if (offUsers || offInst) return { cls: "warn", text: `enabled · ${offUsers} user(s), ${offInst} install(s) off` };
  return { cls: "good", text: o.notice ? "enabled · notice shown" : "enabled" };
}

const isDirty = (slug) => {
  const s = state[slug];
  return !!(s && !s.error && serialize(s.doc) !== serialize(s.orig));
};

function renderSidebar() {
  const nav = $("#navExts");
  nav.innerHTML = cfg.exts
    .map((ext) => {
      const st = savedState(ext.slug);
      const n = ((roster && roster.rows) || []).filter((r) => r.extension === ext.slug).length;
      return `<button type="button" class="nav" data-view="ext" data-slug="${esc(ext.slug)}" title="${esc(st.text)}"><span class="dot ${st.cls}"></span><span class="grow">${esc(ext.name)}</span>${isDirty(ext.slug) ? '<span class="badge warn" title="unsaved draft">draft</span>' : n ? `<span class="badge">${n}</span>` : ""}</button>`;
    })
    .join("");
  $("#navInstallsCount").textContent = roster && roster.rows.length ? String(roster.rows.length) : "";
  for (const b of document.querySelectorAll(".nav")) {
    const on = b.dataset.view === view.name && (view.name !== "ext" || b.dataset.slug === view.slug);
    b.classList.toggle("active", on);
  }
}

const kpi = (n, label) => `<div class="kpi"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;

function renderOverview() {
  const rows = (roster && roster.rows) || [];
  const day = Date.now() - DAY;
  const aliases = new Set(rows.map((r) => r.alias).filter(Boolean));
  const offSaved = rows.filter((r) => state[r.extension] && !state[r.extension].error && !evaluate(state[r.extension].orig, idOf(r)).allowed).length;
  $("#ovStats").innerHTML = roster
    ? [kpi(rows.length, "installs"), kpi(aliases.size, "known aliases"), kpi(rows.filter((r) => Date.parse(r.lastSeen) > day).length, "active last 24 h"), kpi(offSaved, "blocked by saved config")].join("")
    : kpi("…", "installs (roster loading)");
  $("#ovTiles").innerHTML = cfg.exts
    .map((ext) => {
      const s = state[ext.slug];
      const ok = !!(s && !s.error);
      const st = savedState(ext.slug);
      const mine = rows.filter((r) => r.extension === ext.slug);
      const active = mine.filter((r) => Date.parse(r.lastSeen) > day).length;
      const outdated = ok && s.latest ? mine.filter((r) => cmpVersion(r.version || "0", s.latest) < 0).length : 0;
      const note = !s ? "loading…" : s.error ? esc(s.error) : s.orig.notice ? `Notice: ${esc(s.orig.notice)}` : !s.orig.enabled && s.orig.message ? `Message: ${esc(s.orig.message)}` : "";
      return `<button type="button" class="tile" data-slug="${esc(ext.slug)}">
        <h2><span>${esc(ext.name)}</span><span class="pill pill-${st.cls}">${esc(st.text)}</span></h2>
        <div class="nums">
          <div><b>${mine.length}</b>installs</div>
          <div><b>${active}</b>active 24 h</div>
          <div><b>${ok ? esc(s.latest || "—") : "—"}</b>latest</div>
          <div><b>${outdated}</b>outdated</div>
          <div><b>${ok ? esc(s.orig.minVersion || "—") : "—"}</b>min version</div>
        </div>
        ${note ? `<div class="note">${note}</div>` : ""}${isDirty(ext.slug) ? '<div class="note" style="color:var(--warn)">Unsaved draft on this add-on</div>' : ""}
      </button>`;
    })
    .join("");
}

// ── GitHub token ──────────────────────────────────────────────────────────────

async function whoami() {
  const pill = $("#who");
  try {
    const r = await call("gh:whoami");
    login = r.login;
    tokenProblem = r.writeProblem || null;
    if (!r.hasToken) {
      pill.className = "pill pill-muted";
      pill.textContent = "GitHub: read-only (no token)";
    } else if (r.canWrite === false) {
      pill.className = "pill pill-bad";
      pill.textContent = `GitHub: ${r.login} · token can't write`;
      pill.title = r.writeProblem || "";
    } else {
      pill.className = "pill pill-good";
      pill.textContent = `GitHub: ${r.login}${r.canWrite ? " · can write" : ""}`;
      pill.title = "";
    }
    $("#tokenStatus").hidden = !tokenProblem;
    $("#tokenStatus").textContent = tokenProblem ? `Token problem: ${tokenProblem}.` : "";
  } catch (e) {
    login = null;
    tokenProblem = e.message;
    $("#tokenStatus").hidden = false;
    $("#tokenStatus").textContent = `Token rejected: ${e.message}`;
    pill.className = "pill pill-bad";
    pill.textContent = `GitHub token rejected (${e.message})`;
  }
}

function wireChrome() {
  document.addEventListener("click", (e) => {
    const nav = e.target.closest(".nav");
    if (nav) return showView(nav.dataset.view, nav.dataset.slug || null);
    const tile = e.target.closest(".tile[data-slug]");
    if (tile) showView("ext", tile.dataset.slug);
  });
  window.addEventListener("hashchange", applyHash);

  $("#btnSaveToken").addEventListener("click", async () => {
    const t = $("#token").value.trim();
    if (!t) return banner("warn", "Paste a token first.");
    await call("gh:setToken", { token: t });
    $("#token").value = "";
    await whoami();
    if (!login) banner("err", "Token saved but GitHub rejected it — check it has access to the repo.");
    else if (tokenProblem) banner("warn", `Token saved — signed in as <strong>${esc(login)}</strong>, but ${esc(tokenProblem)}.`);
    else banner("ok", `Token saved — signed in as <strong>${esc(login)}</strong>, write access confirmed.`);
  });
  $("#btnClearToken").addEventListener("click", async () => {
    await call("gh:setToken", { token: "" });
    $("#token").value = "";
    await whoami();
    banner("ok", "Token forgotten. Saving is disabled until you set another.");
  });
  $("#btnRecheckToken").addEventListener("click", async () => {
    await whoami();
    banner(tokenProblem ? "err" : "ok", tokenProblem ? `Still a problem: ${esc(tokenProblem)}.` : `Token OK — signed in as <strong>${esc(login)}</strong> with write access.`);
  });
  $("#btnReload").addEventListener("click", () => loadAll());
  $("#btnRosterReload").addEventListener("click", () => loadRoster());
  $("#rosterSearch").addEventListener("input", renderRoster);
  $("#rosterExt").addEventListener("change", renderRoster);
  $("#btnGrant").addEventListener("click", async () => {
    // Firefox grants MV3 host permissions automatically only for temporary
    // add-ons; an installed .xpi needs the user to grant them from a click.
    const origins = [`${cfg.spOrigin}/*`, "https://api.github.com/*", "https://raw.githubusercontent.com/*"];
    const ok = await browser.permissions.request({ origins });
    if (ok) {
      $("#btnGrant").hidden = true;
      banner("ok", "Site access granted — reloading.");
      await loadAll();
    } else banner("warn", "Site access was not granted.");
  });
}

// ── extension cards ───────────────────────────────────────────────────────────

function render(slug) {
  const s = state[slug];
  const c = s.card;
  $(".name", c).textContent = s.name;
  const st = savedState(slug);
  $(".state", c).className = `state pill pill-${st.cls}`;
  $(".state", c).textContent = st.text;
  if (s.error) {
    $(".form", c).hidden = true;
    $(".err", c).hidden = false;
    $(".err", c).textContent = s.error;
    $(".sha", c).textContent = `${slug}/control.json`;
    renderSidebar();
    return;
  }
  $(".form", c).hidden = false;
  $(".err", c).hidden = true;
  const d = s.doc;
  $(".ver", c).textContent = s.latest ? `latest published ${s.latest}` : "no published build";
  $(".latest", c).textContent = s.latest ? `latest published: ${s.latest}` : "no published build found";
  $(".sha", c).textContent = `${slug}/control.json on ${cfg.branch}${s.sha ? ` · sha ${s.sha.slice(0, 7)}` : ""}`;
  $(".f-enabled", c).checked = d.enabled;
  for (const [sel, key] of [[".f-message", "message"], [".f-notice", "notice"], [".f-minver", "minVersion"]]) {
    if (document.activeElement !== $(sel, c)) $(sel, c).value = d[key];
  }
  if (document.activeElement !== $(".f-admins", c)) $(".f-admins", c).value = d.admins.join(", ");

  const rowsOf = (kind) =>
    Object.entries(d[kind])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([k, v]) =>
          `<tr><td><code>${esc(k)}</code></td><td><span class="pill ${v.enabled === false ? "pill-bad" : "pill-good"}">${v.enabled === false ? "disabled" : "allowed"}</span></td><td class="msg">${esc(v.message || "")}</td><td><button type="button" class="btn btn-sm" data-rm="${kind}" data-key="${esc(k)}">Remove</button></td></tr>`
      )
      .join("") || `<tr><td colspan="4" class="muted">none</td></tr>`;
  $(".users tbody", c).innerHTML = rowsOf("users");
  $(".installs tbody", c).innerHTML = rowsOf("installs");
  if (document.activeElement !== $(".raw", c)) $(".raw", c).value = serialize(d);

  const dirty = isDirty(slug);
  c.classList.toggle("dirty", dirty);
  const bar = $(".dirtymsg", c);
  if (dirty) {
    const sum = summarize(s.orig, d);
    const danger = /DISABLE all|minVersion/.test(sum);
    bar.className = `dirtybar dirtymsg${danger ? " danger" : ""}`;
    bar.textContent = `Unsaved: ${sum}${danger ? " — this affects every install." : ""} Nothing changes until you click Save.`;
    bar.hidden = false;
  } else bar.hidden = true;
  $(".f-save", c).disabled = !dirty;
  $(".f-revert", c).disabled = !dirty;
  renderExtRoster(slug);
  renderSidebar();
}

function readForm(slug) {
  const s = state[slug], c = s.card, d = s.doc;
  d.enabled = $(".f-enabled", c).checked;
  d.message = $(".f-message", c).value.trim();
  d.notice = $(".f-notice", c).value.trim();
  d.minVersion = $(".f-minver", c).value.trim();
  d.admins = $(".f-admins", c).value.split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
}

/** Re-render everything that depends on a draft. */
function refresh(slug) {
  render(slug);
  renderRoster();
}

function wire(slug) {
  const s = state[slug], c = s.card;
  const update = () => {
    readForm(slug);
    refresh(slug);
  };
  for (const sel of [".f-enabled", ".f-message", ".f-notice", ".f-minver", ".f-admins"]) $(sel, c).addEventListener("input", update);
  $(".f-minver-latest", c).addEventListener("click", () => {
    if (!s.latest) return;
    s.doc.minVersion = s.latest;
    refresh(slug);
  });
  const add = (kind, keySel, msgSel, enabled) => () => {
    const key = $(keySel, c).value.trim().toLowerCase();
    if (!key) return;
    const entry = { enabled };
    const m = $(msgSel, c).value.trim();
    if (m) entry.message = m;
    s.doc[kind][key] = entry;
    $(keySel, c).value = "";
    $(msgSel, c).value = "";
    refresh(slug);
  };
  $(".f-adduser-off", c).addEventListener("click", add("users", ".f-newuser", ".f-newuser-msg", false));
  $(".f-adduser-on", c).addEventListener("click", add("users", ".f-newuser", ".f-newuser-msg", true));
  $(".f-addinst-off", c).addEventListener("click", add("installs", ".f-newinst", ".f-newinst-msg", false));
  $(".f-addinst-on", c).addEventListener("click", add("installs", ".f-newinst", ".f-newinst-msg", true));
  c.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    delete s.doc[b.dataset.rm][b.dataset.key];
    refresh(slug);
  });
  $(".f-apply-raw", c).addEventListener("click", () => {
    try {
      s.doc = normalize(JSON.parse($(".raw", c).value));
      refresh(slug);
      banner();
    } catch (e) {
      banner("err", `Raw JSON invalid: ${esc(e.message)}`);
    }
  });
  $(".f-revert", c).addEventListener("click", () => {
    s.doc = clone(s.orig);
    refresh(slug);
  });
  $(".f-save", c).addEventListener("click", () => save(slug));
  $(".ext-roster", c).addEventListener("click", onRosterAction);
}

async function save(slug) {
  const s = state[slug];
  if (!login) {
    showView("settings");
    $("#token").focus();
    banner("warn", "Set a GitHub token first — needed to write to the repo.");
    return;
  }
  if (tokenProblem) {
    showView("settings");
    banner("err", `Can't save: ${esc(tokenProblem)}. Fix the token on GitHub, then click <strong>Re-check token</strong>.`);
    return;
  }
  readForm(slug);
  const summary = summarize(s.orig, s.doc);
  if (/DISABLE all/.test(summary)) {
    const allowed = Object.entries(s.doc.users).filter(([, v]) => v.enabled === true).map(([k]) => k);
    const ok = confirm(
      `This will DISABLE ${s.name} for EVERY install${allowed.length ? ` except: ${allowed.join(", ")}` : ""}.\n\nMessage users will see: "${s.doc.message || "(none)"}"\n\nContinue?`
    );
    if (!ok) return;
  }
  if (/minVersion/.test(summary) && s.doc.minVersion && s.latest && cmpVersion(s.doc.minVersion, s.latest) > 0) {
    banner("err", `Minimum version ${esc(s.doc.minVersion)} is higher than the latest published ${esc(s.latest)} — that would block everyone. Not saved.`);
    return;
  }
  $(".f-save", s.card).disabled = true;
  try {
    const out = await call("ctl:save", { slug, doc: s.doc, summary });
    s.sha = out.sha;
    s.latest = out.latest || s.latest;
    s.doc = normalize(out.doc);
    s.orig = clone(s.doc);
    refresh(slug);
    banner("ok", `${esc(s.name)} saved (${esc(summary)}). Installs pick it up within 15 minutes, or on their next Run / Re-check.`);
  } catch (e) {
    banner("err", `Save failed for ${esc(s.name)}: ${esc(e.message)}`);
    render(slug);
  }
}

// ── install roster ────────────────────────────────────────────────────────────

const idOf = (r) => ({ alias: r.alias || null, installId: r.installId, version: r.version });

const age = (iso) => {
  if (!iso) return '<span class="muted">—</span>';
  const h = (Date.now() - Date.parse(iso)) / 3.6e6;
  const cls = h < 24 ? "pill-good" : h < 168 ? "pill-warn" : "pill-muted";
  const t = h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  return `<span class="pill ${cls}" title="${esc(new Date(iso).toLocaleString())}">${t} ago</span>`;
};

/** Preview of the DRAFT verdict for one roster row, plus whether it differs from the saved one. */
function rowState(r) {
  const s = state[r.extension];
  if (!s || s.error) return { txt: "", cls: "pill-muted", off: false, draft: false, blocked: false };
  const v = evaluate(s.doc, idOf(r));
  const saved = evaluate(s.orig, idOf(r));
  const label = (x) => (x.allowed ? (x.override ? "enabled (override)" : "enabled") : x.reason === "version" ? `blocked: needs ≥ ${s.doc.minVersion}` : `disabled (${x.reason})`);
  const cls = v.allowed ? "pill-good" : v.reason === "version" ? "pill-warn" : "pill-bad";
  const off = !v.allowed && (v.reason === "user" || v.reason === "install");
  return { txt: label(v), cls, off, draft: label(v) !== label(saved), blocked: !v.allowed };
}

async function loadRoster() {
  $("#rosterMeta").textContent = "— loading from SharePoint…";
  $("#btnRosterReload").disabled = true;
  try {
    roster = await call("roster:list");
    $("#rosterListLink").href = roster.listUrl;
    $("#rosterMeta").textContent = `— ${roster.rows.length} install(s), read ${new Date(roster.fetchedAt).toLocaleTimeString()}`;
  } catch (e) {
    roster = { rows: [], listUrl: "#", fetchedAt: null };
    $("#rosterMeta").textContent = "— unavailable";
    if (e.permission) $("#btnGrant").hidden = false;
    banner(
      e.expired ? "err" : "warn",
      e.expired
        ? `SharePoint session expired — <a href="${esc(cfg.spOrigin)}" target="_blank" rel="noopener">sign in</a>, then Reload roster. (${esc(e.message)})`
        : `Installs roster: ${esc(e.message)}`
    );
  } finally {
    $("#btnRosterReload").disabled = false;
  }
  renderRoster();
}

function rosterRow(r, { withExt }) {
  const st = rowState(r);
  const known = state[r.extension] && !state[r.extension].error;
  const attrs = `data-ext="${esc(r.extension)}" data-alias="${esc(r.alias)}" data-install="${esc(r.installId)}"`;
  const act = !known
    ? ""
    : st.off
      ? `<button type="button" class="btn btn-sm" data-uact="enable" ${attrs}>Re-enable</button>`
      : `<button type="button" class="btn btn-sm btn-danger" data-uact="disable" ${attrs}>Disable</button>`;
  const rm = `<button type="button" class="btn btn-sm" data-uact="remove" data-id="${esc(r.id)}" ${attrs} title="Delete this roster row (the add-on re-adds itself on its next report)">Remove row</button>`;
  return `<tr class="${st.draft ? "draft" : ""}"><td>${r.alias ? `<code>${esc(r.alias)}</code>` : '<span class="muted">unknown</span>'}</td>${withExt ? `<td>${esc(extName(r.extension))}</td>` : ""}<td>${esc(r.version)}</td><td>${age(r.lastSeen)}</td><td>${age(r.lastRun)}</td><td>${esc(r.runs)}</td><td><code>${esc(r.installId)}</code></td><td>${st.txt ? `<span class="pill ${st.cls}">${esc(st.txt)}${st.draft ? " · draft" : ""}</span>` : ""}</td><td class="row">${act} ${rm}</td></tr>`;
}

const byLastSeen = (a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0);

function renderRoster() {
  const all = (roster && roster.rows) || [];
  const q = $("#rosterSearch").value.trim().toLowerCase();
  const ext = $("#rosterExt").value;
  const rows = all
    .filter((r) => (!ext || r.extension === ext) && (!q || [r.alias, r.version, r.installId, r.extension].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort(byLastSeen);
  const day = Date.now() - DAY;
  const aliases = new Set(all.map((r) => r.alias).filter(Boolean));
  $("#rosterStats").innerHTML = all.length
    ? [kpi(all.length, "installs"), kpi(aliases.size, "known aliases"), kpi(all.filter((r) => Date.parse(r.lastSeen) > day).length, "active last 24 h"), kpi(all.filter((r) => rowState(r).blocked).length, "blocked by draft")].join("")
    : "";
  $("#rosterBody").innerHTML = rows.length
    ? rows.map((r) => rosterRow(r, { withExt: true })).join("")
    : `<tr><td colspan="9" class="muted">${all.length ? "no installs match the filter" : roster ? "no installs reported yet" : "loading…"}</td></tr>`;
  for (const ext of cfg.exts) if (state[ext.slug] && !state[ext.slug].error) renderExtRoster(ext.slug);
  renderSidebar();
  if (view.name === "overview") renderOverview();
}

function renderExtRoster(slug) {
  const s = state[slug];
  if (!s || s.error) return;
  const c = s.card;
  const mine = ((roster && roster.rows) || []).filter((r) => r.extension === slug).sort(byLastSeen);
  const day = Date.now() - DAY;
  const outdated = s.latest ? mine.filter((r) => cmpVersion(r.version || "0", s.latest) < 0).length : 0;
  $(".ext-kpis", c).innerHTML = [
    kpi(mine.length, "installs"),
    kpi(mine.filter((r) => Date.parse(r.lastSeen) > day).length, "active last 24 h"),
    kpi(outdated, s.latest ? `below ${s.latest}` : "outdated"),
    kpi(mine.filter((r) => rowState(r).blocked).length, "blocked by draft"),
    kpi(Object.values(s.doc.users).filter((u) => u.enabled === false).length + Object.values(s.doc.installs).filter((u) => u.enabled === false).length, "overrides off"),
  ].join("");
  $(".ext-roster-meta", c).textContent = roster ? `— ${mine.length}` : "— roster loading";
  $(".ext-roster", c).innerHTML = mine.length
    ? mine.map((r) => rosterRow(r, { withExt: false })).join("")
    : `<tr><td colspan="8" class="muted">${roster ? "no installs reported for this add-on yet" : "loading…"}</td></tr>`;
}

async function onRosterAction(e) {
  const b = e.target.closest("[data-uact]");
  if (!b) return;
  const who = b.dataset.alias || b.dataset.install;
  if (b.dataset.uact === "remove") {
    if (!confirm(`Delete the roster row for ${who}? This does not disable anything — the add-on re-creates the row on its next report.`)) return;
    try {
      await call("roster:remove", { id: Number(b.dataset.id) });
      await loadRoster();
    } catch (err) {
      banner("err", `Remove failed: ${esc(err.message)}`);
    }
    return;
  }
  const s = state[b.dataset.ext];
  if (!s || s.error) return;
  const alias = b.dataset.alias || null, inst = b.dataset.install;
  if (b.dataset.uact === "disable") {
    const msg = prompt(`Message shown to ${who} when they open ${s.name} (optional):`, "");
    if (msg === null) return;
    const entry = { enabled: false };
    if (msg.trim()) entry.message = msg.trim();
    if (alias) s.doc.users[alias] = entry; // alias preferred; install id only when the alias is unknown
    else s.doc.installs[inst] = entry;
  } else {
    if (alias) delete s.doc.users[alias];
    delete s.doc.installs[inst];
  }
  refresh(b.dataset.ext);
  if (view.name !== "ext" || view.slug !== b.dataset.ext) showView("ext", b.dataset.ext);
  banner("warn", `Draft updated for ${esc(s.name)} — click <strong>Save to GitHub</strong> to apply.`);
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  banner();
  $("#btnReload").disabled = true;
  try {
    await whoami();
    const all = await call("ctl:loadAll");
    const host = $("#extCards");
    host.innerHTML = "";
    for (const ext of cfg.exts) {
      const card = $("#tplExt").content.firstElementChild.cloneNode(true);
      card.dataset.slug = ext.slug;
      card.hidden = !(view.name === "ext" && view.slug === ext.slug);
      host.appendChild(card);
      const got = all[ext.slug] || { error: "not loaded" };
      state[ext.slug] = { name: ext.name, card, error: got.error || null, doc: got.doc ? normalize(got.doc) : null, orig: got.doc ? normalize(got.doc) : null, sha: got.sha, latest: got.latest || "" };
      if (!got.error) wire(ext.slug);
      render(ext.slug);
    }
  } catch (e) {
    if (e.permission) $("#btnGrant").hidden = false;
    banner("err", `Couldn't load control files: ${esc(e.message)}`);
  } finally {
    $("#btnReload").disabled = false;
  }
  renderOverview();
  await loadRoster();
}

(async () => {
  cfg = await call("getConfig");
  $("#appVersion").textContent = `v${cfg.version}`;
  $("#branchName").textContent = cfg.branch;
  $("#branchPath").textContent = "<slug>/control.json";
  $("#repoName").textContent = `${cfg.owner}/${cfg.repo}`;
  $("#controlPageLink").href = cfg.controlPage;
  const sel = $("#rosterExt");
  for (const ext of cfg.exts) {
    const o = document.createElement("option");
    o.value = ext.slug;
    o.textContent = ext.name;
    sel.appendChild(o);
  }
  wireChrome();
  renderSidebar();
  $("#rosterBody").addEventListener("click", onRosterAction);
  applyHash();
  await loadAll();
  applyHash(); // cards exist now — honour a deep link to an add-on
})().catch((e) => banner("err", `Startup failed: ${esc(e.message)}`));
