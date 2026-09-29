/**
 * Extension Control — page logic.
 *
 * One card per controlled add-on (draft → Save writes control.json through the
 * background), plus a live install roster from SharePoint whose State column
 * previews the current draft. Everything goes through the background router.
 */
import { normalize, serialize, cmpVersion, evaluate, summarize } from "../shared/controlDoc.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));

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

const extName = (slug) => (cfg && cfg.exts.find((x) => x.slug === slug) || { name: slug }).name;

function banner(kind, html) {
  const b = $("#banner");
  if (!html) {
    b.hidden = true;
    return;
  }
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}

// ── GitHub token ──────────────────────────────────────────────────────────────

async function whoami() {
  const pill = $("#who");
  try {
    const r = await call("gh:whoami");
    login = r.login;
    if (!r.hasToken) {
      pill.className = "pill pill-muted";
      pill.textContent = "read-only (no token)";
    } else {
      pill.className = "pill pill-good";
      pill.textContent = `signed in as ${r.login}`;
    }
  } catch (e) {
    login = null;
    pill.className = "pill pill-bad";
    pill.textContent = `token rejected (${e.message})`;
  }
}

function wireHeader() {
  $("#btnToken").addEventListener("click", () => {
    $("#tokenCard").hidden = !$("#tokenCard").hidden;
    $("#token").value = "";
    if (!$("#tokenCard").hidden) $("#token").focus();
  });
  $("#btnSaveToken").addEventListener("click", async () => {
    const t = $("#token").value.trim();
    if (!t) return banner("warn", "Paste a token first.");
    await call("gh:setToken", { token: t });
    $("#token").value = "";
    $("#tokenCard").hidden = true;
    await whoami();
    banner(login ? "ok" : "err", login ? `Token saved — signed in as <strong>${esc(login)}</strong>.` : "Token saved but GitHub rejected it — check it has access to the repo.");
  });
  $("#btnClearToken").addEventListener("click", async () => {
    await call("gh:setToken", { token: "" });
    $("#token").value = "";
    await whoami();
    banner("ok", "Token forgotten. The page is read-only until you set another.");
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
  if (s.error) {
    $(".form", c).hidden = true;
    $(".err", c).hidden = false;
    $(".err", c).textContent = s.error;
    $(".state", c).className = "pill pill-muted";
    $(".state", c).textContent = "unavailable";
    $(".sha", c).textContent = `${slug}/control.json`;
    return;
  }
  $(".form", c).hidden = false;
  $(".err", c).hidden = true;
  const d = s.doc;
  $(".ver", c).textContent = s.latest ? `latest ${s.latest}` : "";
  $(".latest", c).textContent = s.latest ? `latest published: ${s.latest}` : "no published build found";
  $(".sha", c).textContent = `${slug}/control.json${s.sha ? ` · sha ${s.sha.slice(0, 7)}` : ""}`;
  $(".f-enabled", c).checked = d.enabled;
  for (const [sel, key] of [[".f-message", "message"], [".f-notice", "notice"], [".f-minver", "minVersion"]]) {
    if (document.activeElement !== $(sel, c)) $(sel, c).value = d[key];
  }
  if (document.activeElement !== $(".f-admins", c)) $(".f-admins", c).value = d.admins.join(", ");

  // Saved state pill = what installs currently see.
  const o = s.orig;
  const st = $(".state", c);
  const offUsers = Object.values(o.users).filter((u) => u.enabled === false).length;
  const offInst = Object.values(o.installs).filter((u) => u.enabled === false).length;
  if (!o.enabled) {
    st.className = "pill pill-bad";
    st.textContent = "DISABLED for everyone";
  } else if (offUsers || offInst) {
    st.className = "pill pill-warn";
    st.textContent = `enabled · ${offUsers} user(s), ${offInst} install(s) off`;
  } else {
    st.className = "pill pill-good";
    st.textContent = o.notice ? "enabled · notice shown" : "enabled";
  }

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

  const dirty = serialize(d) !== serialize(o);
  c.classList.toggle("dirty", dirty);
  const bar = $(".dirtymsg", c);
  if (dirty) {
    const sum = summarize(o, d);
    const danger = /DISABLE all|minVersion/.test(sum);
    bar.className = `dirtybar dirtymsg${danger ? " danger" : ""}`;
    bar.textContent = `Unsaved: ${sum}${danger ? " — this affects every install." : ""} Nothing changes until you click Save.`;
    bar.hidden = false;
  } else bar.hidden = true;
  $(".f-save", c).disabled = !dirty;
  $(".f-revert", c).disabled = !dirty;
}

function readForm(slug) {
  const s = state[slug], c = s.card, d = s.doc;
  d.enabled = $(".f-enabled", c).checked;
  d.message = $(".f-message", c).value.trim();
  d.notice = $(".f-notice", c).value.trim();
  d.minVersion = $(".f-minver", c).value.trim();
  d.admins = $(".f-admins", c).value.split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
}

function wire(slug) {
  const s = state[slug], c = s.card;
  const update = () => {
    readForm(slug);
    render(slug);
    renderRoster();
  };
  for (const sel of [".f-enabled", ".f-message", ".f-notice", ".f-minver", ".f-admins"]) $(sel, c).addEventListener("input", update);
  $(".f-minver-latest", c).addEventListener("click", () => {
    if (!s.latest) return;
    s.doc.minVersion = s.latest;
    render(slug);
    renderRoster();
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
    render(slug);
    renderRoster();
  };
  $(".f-adduser-off", c).addEventListener("click", add("users", ".f-newuser", ".f-newuser-msg", false));
  $(".f-adduser-on", c).addEventListener("click", add("users", ".f-newuser", ".f-newuser-msg", true));
  $(".f-addinst-off", c).addEventListener("click", add("installs", ".f-newinst", ".f-newinst-msg", false));
  $(".f-addinst-on", c).addEventListener("click", add("installs", ".f-newinst", ".f-newinst-msg", true));
  c.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    delete s.doc[b.dataset.rm][b.dataset.key];
    render(slug);
    renderRoster();
  });
  $(".f-apply-raw", c).addEventListener("click", () => {
    try {
      s.doc = normalize(JSON.parse($(".raw", c).value));
      render(slug);
      renderRoster();
      banner();
    } catch (e) {
      banner("err", `Raw JSON invalid: ${esc(e.message)}`);
    }
  });
  $(".f-revert", c).addEventListener("click", () => {
    s.doc = clone(s.orig);
    render(slug);
    renderRoster();
  });
  $(".f-save", c).addEventListener("click", () => save(slug));
}

async function save(slug) {
  const s = state[slug];
  if (!login) {
    $("#tokenCard").hidden = false;
    $("#token").focus();
    banner("warn", "Set a GitHub token first (Token… in the header) — needed to write to the repo.");
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
    render(slug);
    renderRoster();
    banner("ok", `${esc(s.name)} saved (${esc(summary)}). Installs pick it up within 15 minutes, or on their next Run / Re-check.`);
  } catch (e) {
    banner("err", `Save failed for ${esc(s.name)}: ${esc(e.message)}`);
    render(slug);
  }
}

// ── install roster ────────────────────────────────────────────────────────────

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
  if (!s || s.error) return { txt: "", cls: "pill-muted", off: false, draft: false };
  const id = { alias: r.alias || null, installId: r.installId, version: r.version };
  const v = evaluate(s.doc, id);
  const saved = evaluate(s.orig, id);
  const label = (x) =>
    x.allowed ? (x.override ? "enabled (override)" : "enabled") : x.reason === "version" ? `blocked: needs ≥ ${s.doc.minVersion}` : `disabled (${x.reason})`;
  const cls = v.allowed ? "pill-good" : v.reason === "version" ? "pill-warn" : "pill-bad";
  const off = !v.allowed && (v.reason === "user" || v.reason === "install");
  return { txt: label(v), cls, off, draft: label(v) !== label(saved) };
}

async function loadRoster() {
  $("#rosterMeta").textContent = "— loading from SharePoint…";
  $("#btnRosterReload").disabled = true;
  try {
    roster = await call("roster:list");
    $("#rosterListLink").href = roster.listUrl;
    $("#rosterMeta").textContent = `— ${roster.rows.length} install(s), read ${new Date(roster.fetchedAt).toLocaleTimeString()}`;
  } catch (e) {
    roster = { rows: [], listUrl: "#" };
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

function renderRoster() {
  const all = (roster && roster.rows) || [];
  const q = $("#rosterSearch").value.trim().toLowerCase();
  const ext = $("#rosterExt").value;
  const rows = all
    .filter((r) => (!ext || r.extension === ext) && (!q || [r.alias, r.version, r.installId, r.extension].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0));

  const day = Date.now() - 86_400_000;
  const aliases = new Set(all.map((r) => r.alias).filter(Boolean));
  const stat = (label, n, sub) => `<div class="stat"><b>${esc(n)}</b>${esc(label)}${sub ? ` <span class="muted">· ${esc(sub)}</span>` : ""}</div>`;
  $("#rosterStats").innerHTML = all.length
    ? [
        stat("installs", all.length, `${aliases.size} known alias(es)`),
        stat("active last 24 h", all.filter((r) => Date.parse(r.lastSeen) > day).length),
        stat("disabled by draft", all.filter((r) => !rowState(r).txt.startsWith("enabled") && rowState(r).txt).length),
      ].join("")
    : "";

  $("#rosterBody").innerHTML = rows.length
    ? rows
        .map((r) => {
          const st = rowState(r);
          const known = state[r.extension] && !state[r.extension].error;
          const act = !known
            ? ""
            : st.off
              ? `<button type="button" class="btn btn-sm" data-uact="enable" data-ext="${esc(r.extension)}" data-alias="${esc(r.alias)}" data-install="${esc(r.installId)}">Re-enable</button>`
              : `<button type="button" class="btn btn-sm btn-danger" data-uact="disable" data-ext="${esc(r.extension)}" data-alias="${esc(r.alias)}" data-install="${esc(r.installId)}">Disable</button>`;
          const rm = `<button type="button" class="btn btn-sm" data-uact="remove" data-id="${esc(r.id)}" data-alias="${esc(r.alias)}" data-install="${esc(r.installId)}" title="Delete this roster row (the add-on re-adds itself on its next report)">Remove row</button>`;
          return `<tr class="${st.draft ? "draft" : ""}"><td>${r.alias ? `<code>${esc(r.alias)}</code>` : '<span class="muted">unknown</span>'}</td><td>${esc(extName(r.extension))}</td><td>${esc(r.version)}</td><td>${age(r.lastSeen)}</td><td>${age(r.lastRun)}</td><td>${esc(r.runs)}</td><td><code>${esc(r.installId)}</code></td><td>${st.txt ? `<span class="pill ${st.cls}">${esc(st.txt)}${st.draft ? " · draft" : ""}</span>` : ""}</td><td class="row">${act} ${rm}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="muted">${all.length ? "no installs match the filter" : "no installs reported yet"}</td></tr>`;
}

function wireRoster() {
  $("#rosterBody").addEventListener("click", async (e) => {
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
    render(b.dataset.ext);
    renderRoster();
    s.card.scrollIntoView({ behavior: "smooth", block: "start" });
    banner("warn", `Draft updated for ${esc(s.name)} — click <strong>Save to GitHub</strong> on its card to apply.`);
  });
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  banner();
  $("#btnReload").disabled = true;
  try {
    await whoami();
    const all = await call("ctl:loadAll");
    const main = $("#main");
    main.innerHTML = "";
    for (const ext of cfg.exts) {
      const card = $("#tplExt").content.firstElementChild.cloneNode(true);
      main.appendChild(card);
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
  await loadRoster();
}

(async () => {
  cfg = await call("getConfig");
  $("#appVersion").textContent = `v${cfg.version}`;
  $("#branchName").textContent = cfg.branch;
  $("#repoName").textContent = `${cfg.owner}/${cfg.repo}`;
  const sel = $("#rosterExt");
  for (const ext of cfg.exts) {
    const o = document.createElement("option");
    o.value = ext.slug;
    o.textContent = ext.name;
    sel.appendChild(o);
  }
  wireHeader();
  wireRoster();
  await loadAll();
})().catch((e) => banner("err", `Startup failed: ${esc(e.message)}`));
