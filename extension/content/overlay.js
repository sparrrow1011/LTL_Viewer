/**
 * Overlay content script — the injected UI that reproduces the LTL_Viewer
 * manual-sourcing page on top of the SMC site. Ports table.js + filters.js +
 * the manual-sourcing template controls, but renders into a fixed panel and
 * talks to the background worker instead of Flask /api/*.
 *
 * All data/mutations go through msg() -> background HANDLERS. EML generation
 * uses window.__ltlEml (content/eml.js, injected before this file).
 */
(function () {
  "use strict";

  // rlb1 column set (from table.js pageColumns.rlb1) + orderid — the
  // manual-sourcing view.
  const BASE_COLUMNS = [
    "shippername", "orderid", "tour_id", "vrid", "orig_planned_yard_checkin_time",
    "orig_node", "dest_node", "orig_country", "dest_country",
    "vehicle_carrier", "vehicle_execution_status",
  ];

  // Sign-in URLs for the session blocker's "Open …" buttons. Content scripts
  // can't import config.js, so these mirror Config.FMC_TAB_URL / SP site.
  const FMC_TAB_URL = "https://trans-logistics-eu.amazon.com/fmc/execution";
  const SP_SITE_URL = "https://amazongbr.sharepoint.com/sites/AmazonFreightOperations";
  const SMC_TAB_URL = "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1";
  // Teams with a shipper source-of-truth list also show the shipper group
  // (e.g. CST / CST - ELEX / CST - Mega Shipper) right after the shipper name.
  function columns() {
    if (teamCfg && (teamCfg.shipperList || teamCfg.shipperSource)) {
      return ["shippername", "shipper_group", ...BASE_COLUMNS.slice(1)];
    }
    if (teamCfg && teamCfg.fmcSearch) {
      // FMC-sourced (LTL): lead with the FM/MM tag and show the shipper
      // account, which is what distinguishes the middle-mile runs.
      return ["mile", "shipper_account", ...BASE_COLUMNS];
    }
    return BASE_COLUMNS;
  }

  // ── team selection ────────────────────────────────────────────────────────
  // The panel opens on a team picker. `teamCfg` is the selected entry of
  // Config.TEAMS (fetched from the background via getTeams); every background
  // message is tagged with the team so records go to that team's list.
  const TEAM_STORAGE_KEY = "ltl.lastTeam";
  let teams = null; // { defaultTeam, teams: {KEY: cfg} }
  let teamCfg = null; // selected team config
  let shipperMap = null; // { shipperid: {shipperid, shippername, shipper_group} } for the team
  let shipperInfo = null; // { source: "file"|"list"|"none", path, count, fetchedAt }

  async function ensureTeams() {
    if (teams) return teams;
    teams = await msg("getTeams");
    return teams;
  }
  async function loadLastTeam() {
    try {
      const got = await browser.storage.local.get(TEAM_STORAGE_KEY);
      return got && got[TEAM_STORAGE_KEY] ? String(got[TEAM_STORAGE_KEY]) : null;
    } catch {
      return null;
    }
  }
  async function saveLastTeam(key) {
    try {
      await browser.storage.local.set({ [TEAM_STORAGE_KEY]: key });
    } catch {
      /* storage is a nicety only */
    }
  }

  // Columns rendered as links opening in a new tab (URL patterns from the
  // original app's table.js).
  const LINKS = {
    orderid: (v) => `https://smc-eu-dub.dub.proxy.amazon.com/order/${encodeURIComponent(v)}`,
    vrid: (v) => `https://trans-logistics-eu.amazon.com/fmc/execution/search/${encodeURIComponent(v)}`,
    tour_id: (v) => `https://trans-logistics-eu.amazon.com/fmc/execution/search/${encodeURIComponent(v)}`,
  };

  const state = {
    rows: [], // loads that still need sourcing (SMC + FMC gate)
    covered: [], // tracked runs that got a carrier recently (from records)
    lookup: [], // direct SMC lookup results for IDs not on the list
    lookupInfo: null,
    filtered: [],
    sortKey: null,
    sortDir: "asc",
    search: "",
  };

  // ── debug ─────────────────────────────────────────────────────────────────
  // Off by default (no UI button). Enable from the console when needed:
  //   __ltlDebug.enable() / .disable() / .status()
  const dbg = { enabled: false };
  function dlog(...a) {
    if (dbg.enabled) console.debug("[LTL overlay]", ...a);
  }
  window.__ltlDebug = {
    enable() { dbg.enabled = true; console.info("[LTL overlay] debug ENABLED"); },
    disable() { dbg.enabled = false; console.info("[LTL overlay] debug disabled"); },
    status() { console.info(`[LTL overlay] debug ${dbg.enabled ? "ON" : "OFF"}`); return dbg.enabled; },
  };

  // Logged-in user (SMC requester alias), auto-detected once and cached.
  let currentUser = null;
  async function ensureUser() {
    if (currentUser) return currentUser;
    try {
      currentUser = (await msg("smcRequester")).requester || null;
    } catch {
      currentUser = null;
    }
    return currentUser;
  }

  // ── messaging bridge ──────────────────────────────────────────────────────
  async function msg(action, extra = {}) {
    dlog(`→ ${action}`, extra);
    // Every message carries the selected team so the background scopes its
    // SharePoint lists accordingly (ignored by team-agnostic handlers).
    const team = teamCfg ? teamCfg.key : undefined;
    const resp = await browser.runtime.sendMessage({ action, team, ...extra });
    if (!resp || !resp.ok) {
      // Build a detailed message from whatever the background returned.
      const bits = [(resp && resp.error) || `${action} failed`];
      if (resp && resp.status) bits.push(`(HTTP ${resp.status})`);
      const full = bits.join(" ");
      if (resp && resp.body) console.error(`[LTL overlay] ${action} body:`, resp.body);
      dlog(`✗ ${action}`, resp);
      throw new Error(full);
    }
    dlog(`✓ ${action}`, resp.data);
    return resp.data;
  }

  // Session pre-flight: returns true if all required services are authenticated.
  // If any are expired, shows the persistent banner (with Retry) and returns
  // false so the caller ABORTS the action before doing anything.
  async function ensureSessions(services, onRetry) {
    try {
      const { expired } = await msg("checkSessions", { services });
      if (expired && expired.length) {
        showSessionBanner(expired, onRetry);
        return false;
      }
      dismissSessionBanner();
      return true;
    } catch (e) {
      // If the check itself failed, treat the requested services as expired.
      showSessionBanner(services, onRetry);
      return false;
    }
  }

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function")
        node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  }

  function toast(text, kind = "info") {
    const t = el("div", { class: `ltl-toast ltl-toast-${kind}`, text });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // Persistent banner for expired sessions — stays until the user dismisses it.
  // `services` is a list like ["SharePoint","FMC"]; `onRetry` re-runs the action.
  function showSessionBanner(services, onRetry) {
    dismissSessionBanner();
    const names = services.join(" and ");
    const msg = el("span", {
      class: "ltl-banner-msg",
      text: `${names} session ${services.length > 1 ? "have" : "has"} expired. Open the ${names} tab${
        services.length > 1 ? "s" : ""
      }, sign in, then retry.`,
    });
    const actions = el("div", { class: "ltl-banner-actions" });
    if (typeof onRetry === "function") {
      actions.appendChild(
        el("button", {
          type: "button",
          text: "Retry",
          onclick: async () => {
            dismissSessionBanner();
            await onRetry();
          },
        })
      );
    }
    actions.appendChild(
      el("button", { type: "button", text: "Dismiss", onclick: dismissSessionBanner })
    );
    const banner = el("div", { id: "ltl-banner", class: "ltl-banner" }, [msg, actions]);
    root.querySelector(".ltl-body").appendChild(banner);
  }
  function dismissSessionBanner() {
    root.querySelector("#ltl-banner")?.remove();
  }

  // Bold, CENTERED blocker shown in the middle of the overlay when a required
  // session (SharePoint / FMC) is missing or expired. Unlike the thin banner,
  // this stops the load: nothing is fetched or rendered behind it until the
  // user signs in and hits Retry. `services` = e.g. ["SharePoint","FMC"].
  // `reasons` (optional) = { svc: {message, status, expired} } from the
  // pre-flight. When a service failed for a reason OTHER than a sign-in page
  // (expired:false — bridge unreachable, tab didn't load, network), the blocker
  // says so instead of wrongly telling the user to sign in.
  function showBlocker(services, onRetry, reasons = {}) {
    dismissBlocker();
    const names = services.join(" and ");
    const plural = services.length > 1;
    // Is EVERY failure a positively-detected sign-in problem?
    const allExpired = services.every((s) => !reasons[s] || reasons[s].expired !== false);
    const title = el("div", {
      class: "ltl-blocker-title",
      text: allExpired ? `${names} sign-in required` : `Can't reach ${names}`,
    });
    const body = el("div", {
      class: "ltl-blocker-msg",
      text: allExpired
        ? `Can't validate loads on FMC / save to SharePoint because the ` +
          `${names} session${plural ? "s are" : " is"} not active. ` +
          `Open the ${names} site${plural ? "s" : ""} in a tab, sign in (Midway), then retry.`
        : `The ${names} check failed, but not because of a sign-in problem — ` +
          `the ${names} tab may still be loading or the bridge didn't answer. ` +
          `Make sure the ${names} site is open in a tab, wait for it to finish loading, then retry.`,
    });
    // The actual error(s), verbatim, so a false blocker is diagnosable on the
    // spot without opening the background console.
    const details = services
      .map((s) => reasons[s] && reasons[s].message)
      .filter(Boolean);
    const detailEl = details.length
      ? el("div", { class: "ltl-blocker-detail", text: details.join(" · ") })
      : null;
    const actions = el("div", { class: "ltl-blocker-actions" });
    // Quick links to open each required service so sign-in is one click away.
    for (const svc of services) {
      const url = svc === "FMC" ? FMC_TAB_URL : SP_SITE_URL;
      actions.appendChild(
        el("button", {
          type: "button",
          class: "ltl-btn ltl-gray",
          text: `Open ${svc}`,
          onclick: () => window.open(url, "_blank", "noopener"),
        })
      );
    }
    if (typeof onRetry === "function") {
      actions.appendChild(
        el("button", {
          type: "button",
          class: "ltl-btn ltl-green",
          text: "Retry",
          onclick: async () => {
            dismissBlocker();
            await onRetry();
          },
        })
      );
    }
    const card = el("div", { class: "ltl-blocker-card" }, [title, body, detailEl, actions]);
    const overlay = el("div", { id: "ltl-blocker", class: "ltl-blocker" }, [card]);
    root.querySelector(".ltl-body").appendChild(overlay);
  }
  function dismissBlocker() {
    root.querySelector("#ltl-blocker")?.remove();
  }

  /**
   * Tag-style multi-select with text search. Renders selected values as
   * removable chips + a search input that filters a dropdown of options.
   * Returns a controller: { root, getSelected, setOptions, setSelected }.
   */
  function createMultiSelect({ placeholder = "Select…", onChange } = {}) {
    let options = []; // string[]
    const selected = new Set(); // Set<string>
    let activeIdx = -1;

    const control = el("div", { class: "ltl-ms-control" });
    const input = el("input", { class: "ltl-ms-input", type: "text", placeholder });
    const menu = el("div", { class: "ltl-ms-menu" });
    const wrap = el("div", { class: "ltl-ms" }, [control, menu]);

    function emitChange() {
      if (typeof onChange === "function") onChange([...selected]);
    }

    function renderChips() {
      control.innerHTML = "";
      for (const v of selected) {
        const chip = el("span", { class: "ltl-ms-chip", text: v });
        chip.appendChild(
          el("button", {
            type: "button",
            text: "×",
            title: `Remove ${v}`,
            onclick: (e) => {
              e.stopPropagation();
              selected.delete(v);
              renderChips();
              renderMenu();
              emitChange();
            },
          })
        );
        control.appendChild(chip);
      }
      control.appendChild(input);
      if (!selected.size && !input.value) {
        input.classList.add("ltl-ms-placeholder");
      } else {
        input.classList.remove("ltl-ms-placeholder");
      }
    }

    function visibleOptions() {
      const q = input.value.trim().toLowerCase();
      return options.filter((o) => !q || o.toLowerCase().includes(q));
    }

    function renderMenu() {
      menu.innerHTML = "";
      const vis = visibleOptions();
      if (!vis.length) {
        menu.appendChild(el("div", { class: "ltl-ms-empty", text: "No matches" }));
        return;
      }
      vis.forEach((o, i) => {
        const opt = el("div", {
          class:
            "ltl-ms-option" +
            (selected.has(o) ? " ltl-selected" : "") +
            (i === activeIdx ? " ltl-active" : ""),
          text: o,
          onmousedown: (e) => {
            e.preventDefault(); // keep input focus
            toggle(o);
          },
        });
        menu.appendChild(opt);
      });
    }

    function toggle(v) {
      if (selected.has(v)) selected.delete(v);
      else selected.add(v);
      input.value = "";
      activeIdx = -1;
      renderChips();
      renderMenu();
      emitChange();
    }

    function open() {
      wrap.classList.add("ltl-open");
      renderMenu();
    }
    function close() {
      wrap.classList.remove("ltl-open");
      activeIdx = -1;
    }

    control.addEventListener("click", () => {
      input.focus();
      open();
    });
    input.addEventListener("input", () => {
      activeIdx = -1;
      open();
      renderChips();
    });
    input.addEventListener("keydown", (e) => {
      const vis = visibleOptions();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, vis.length - 1);
        renderMenu();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        renderMenu();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && vis[activeIdx]) toggle(vis[activeIdx]);
      } else if (e.key === "Backspace" && !input.value && selected.size) {
        const last = [...selected].pop();
        selected.delete(last);
        renderChips();
        renderMenu();
        emitChange();
      } else if (e.key === "Escape") {
        close();
      }
    });
    // Close when focus/click leaves the widget.
    document.addEventListener("mousedown", (e) => {
      if (!wrap.contains(e.target)) close();
    });

    renderChips();

    return {
      root: wrap,
      getSelected: () => [...selected],
      setOptions(list) {
        options = [...new Set(list.map(String))].sort((a, b) => a.localeCompare(b));
        renderMenu();
      },
      setSelected(list) {
        selected.clear();
        for (const v of list) selected.add(String(v));
        renderChips();
        renderMenu();
        emitChange();
      },
    };
  }

  function truthy(v) {
    return v === true || ["1", "true", "yes"].includes(String(v).trim().toLowerCase());
  }

  // Local date as YYYY-MM-DD for <input type="date">.
  function isoDay(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function todayIso() {
    return isoDay(new Date());
  }
  function tomorrowIso() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return isoDay(d);
  }

  function fmtDateTime(iso, country) {
    if (!iso) return "";
    const tz = country === "GB" ? "Europe/London" : "Europe/Paris";
    try {
      const raw = String(iso).trim().replace(" ", "T");
      const withZ = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
      const d = new Date(withZ);
      if (Number.isNaN(d.getTime())) throw 0;
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
    } catch {
      const [d, t] = String(iso).split("T");
      return `${d} ${(t || "").slice(0, 5)}`;
    }
  }

  const DATE_COLS = new Set([
    "orig_planned_yard_checkin_time",
    "dest_planned_yard_checkin_time",
    "manual_source_date",
  ]);

  // ── local toolbar filters (applied over the fetched SMC rows) ──────────────
  function toolbarPredicates() {
    const g = (id) => root.querySelector(`#${id}`)?.value?.trim();
    const preds = [];
    const country = g("ltl-country");
    if (country) preds.push((r) => String(r.orig_country ?? "") === country);
    // Status + carrier filters describe "needs sourcing" (PLANNED / RLB1…);
    // covered / looked-up runs have real carriers, so skip both there.
    const gating = viewMode === "sourcing";
    const status = g("ltl-status");
    if (gating && status) preds.push((r) => String(r.vehicle_execution_status ?? "") === status);
    const shipper = g("ltl-shipper");
    if (shipper) preds.push((r) => String(r.shippername ?? "") === shipper);
    // Shipper group (teams with a shipper source-of-truth list only).
    const group = g("ltl-group");
    if (group) preds.push((r) => String(r.shipper_group ?? "") === group);

    // Vehicle carrier: tag multi-select. If any are selected, keep rows whose
    // carrier is one of them (case-insensitive, trimmed).
    const carriers = carrierMs
      ? carrierMs.getSelected().map((v) => v.trim().toUpperCase()).filter(Boolean)
      : [];
    if (gating && carriers.length) {
      const set = new Set(carriers);
      preds.push((r) => set.has(String(r.vehicle_carrier ?? "").trim().toUpperCase()));
    }

    // Status flag filters (Any / Yes / No), from the merged SharePoint records.
    const flag = (id, test) => {
      const v = g(id); // "", "yes", "no"
      if (v === "yes") preds.push((r) => test(r));
      else if (v === "no") preds.push((r) => !test(r));
    };
    flag("ltl-f-ms", (r) => truthy(r.is_manual_source));
    flag("ltl-f-gen", (r) => !!r.email_generated_at);
    flag("ltl-f-sent", (r) => truthy(r.email_sent));

    // NOTE: date range is NOT filtered locally — it drives the SMC fetch window
    // (see dateWindow() / fetchData). country/status/shipper/carrier/flags local.
    return preds;
  }

  // ── record merge ──────────────────────────────────────────────────────────
  const RECORD_FIELDS = [
    "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
    "email_sent", "email_sent_count", "email_sent_confirmed_at", "email_sent_by",
    "email_generated_at",
  ];

  // Overlay SharePoint records onto the given rows (by orderid|vrid). Clears the
  // record fields first so rows without a record show the default state.
  function mergeRecords(rows, records) {
    for (const r of rows) {
      const rec = records[`${r.orderid ?? ""}|${r.vrid ?? ""}`];
      for (const f of RECORD_FIELDS) r[f] = rec ? rec[f] : undefined;
    }
  }

  // ── "Recently covered" view ────────────────────────────────────────────────
  // The real workflow: we find a carrier, FMC gets the assignment, and THEN we
  // tick Manual Source. By then the run has left the sourcing list, so this
  // view lists runs that were tracked and got a carrier in the last N days,
  // with the Manual Source checkbox still live. Untouched = Covered (RLB).
  const COVERED_DAYS = 7;
  let viewMode = "sourcing"; // "sourcing" | "covered"

  function coveredRowsFrom(records) {
    const cutoff = Date.now() - COVERED_DAYS * 86_400_000;
    const out = [];
    for (const rec of Object.values(records || {})) {
      if (!rec.covered_at) continue;
      const t = new Date(String(rec.covered_at).replace(" ", "T")).getTime();
      if (Number.isNaN(t) || t < cutoff) continue;
      out.push({
        ...rec,
        _fromRecord: true, // already holds its snapshot; don't send one back
        // Show the carrier that actually took it, and FMC's status at cover time.
        vehicle_carrier: rec.final_carrier || rec.vehicle_carrier,
        carrier_name: rec.final_carrier_name || rec.carrier_name,
        vehicle_execution_status: rec.final_status || rec.vehicle_execution_status,
      });
    }
    out.sort((a, b) => String(b.covered_at).localeCompare(String(a.covered_at)));
    return out;
  }

  function currentRows() {
    if (viewMode === "covered") return state.covered;
    if (viewMode === "lookup") return state.lookup;
    return state.rows;
  }

  // ── SMC lookup: IDs that aren't on the sourcing list ───────────────────────
  // The list only holds runs with no real carrier. Searching for an order/VRID
  // that already has one finds nothing, so we offer to look it up in SMC
  // directly (wide ±14-day window, FMC-validated) and show it in the table.
  const LOOKUP_DAYS = 14;

  // Exact-ID terms from the search box: every comma-separated term, or a single
  // term with no spaces and ≥ 6 chars (order IDs are 10 digits, VRIDs longer).
  function idTerms() {
    const raw = state.search.trim();
    if (!raw) return [];
    const terms = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (terms.length > 1) return terms;
    return /^\S{6,}$/.test(raw) ? [raw] : [];
  }
  function unmatchedIds(rows) {
    const have = new Set();
    for (const r of rows) {
      have.add(String(r.orderid ?? "").trim().toLowerCase());
      have.add(String(r.vrid ?? "").trim().toLowerCase());
    }
    return idTerms().filter((t) => !have.has(t.toLowerCase()));
  }

  function lookupWindow() {
    const d = LOOKUP_DAYS * 86_400_000;
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, ".000Z");
    return { start: iso(Date.now() - d), end: iso(Date.now() + d) };
  }

  function renderLookupBar() {
    const bar = root.querySelector("#ltl-lookup-bar");
    if (!bar) return;
    bar.innerHTML = "";
    if (viewMode === "lookup") {
      const info = state.lookupInfo || {};
      const found = (info.found || []).length;
      const missing = info.missing || [];
      bar.appendChild(
        el("span", {
          text:
            `SMC lookup: ${state.lookup.length} row(s) for ${found} ID(s)` +
            (missing.length ? ` — not found in SMC (±${LOOKUP_DAYS}d): ${missing.join(", ")}` : "") +
            `. Read-only: these aren't on the sourcing list and nothing is saved for them.`,
        })
      );
      const back = el("button", { class: "ltl-btn ltl-gray", text: "← Back to sourcing list" });
      back.addEventListener("click", () => {
        state.search = "";
        const s = root.querySelector("#ltl-search");
        if (s) s.value = "";
        setViewMode("sourcing");
      });
      bar.appendChild(back);
      bar.style.display = "";
      return;
    }
    const missing = viewMode === "sourcing" ? unmatchedIds(state.rows) : [];
    if (!missing.length) {
      bar.style.display = "none";
      return;
    }
    bar.appendChild(
      el("span", {
        text: `${missing.length} ID(s) not on the sourcing list (probably already covered): ${missing.join(", ")}`,
      })
    );
    const btn = el("button", { class: "ltl-btn", text: `Look up in SMC` });
    btn.addEventListener("click", () => lookupInSmc(missing));
    bar.appendChild(btn);
    bar.style.display = "";
  }

  async function lookupInSmc(ids) {
    if (!teamCfg || !ids.length) return;
    try {
      setBusy(true);
      setLoadingText(`Looking up ${ids.length} ID(s) in SMC…`);
      const res = await msg("smcLookup", { ids, win: lookupWindow(), opts: smcOptions() });
      const rows = res.rows || [];
      if (rows.length) {
        setLoadingText(`Validating ${rows.length} row(s) on FMC…`);
        try {
          await enrichFmcStatuses({ render: false, rows });
        } catch (e) {
          dlog(`lookup FMC enrichment skipped: ${e.message}`);
        }
        try {
          mergeRecords(rows, await msg("getRecords"));
        } catch (e) {
          dlog(`lookup records merge skipped: ${e.message}`);
        }
      }
      for (const r of rows) r._lookup = true; // read-only display rows
      state.lookup = rows;
      state.lookupInfo = { found: res.found, missing: res.missing, source: res.source };
      viewMode = "lookup";
      updateCoveredButton();
      if (!rows.length) showEmptyNotice(`Not found in SMC (±${LOOKUP_DAYS} days): ${ids.join(", ")}`);
      else clearEmptyNotice();
      applySearchAndRender();
      toast(rows.length ? `Found ${rows.length} row(s) in SMC` : "Not found in SMC", rows.length ? "success" : "info");
    } catch (e) {
      toast(`SMC lookup failed: ${e.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function updateCoveredButton() {
    const btn = root.querySelector("#ltl-covered");
    if (!btn) return;
    const n = (state.covered || []).length;
    const unmarked = (state.covered || []).filter((r) => !truthy(r.is_manual_source)).length;
    btn.textContent =
      viewMode === "covered" ? `← Back to sourcing list` : `Recently covered (${n}${unmarked ? `, ${unmarked} unmarked` : ""})`;
    btn.classList.toggle("ltl-active", viewMode === "covered");
    btn.title =
      viewMode === "covered"
        ? "Return to the loads that still need sourcing"
        : `Runs that got a carrier in the last ${COVERED_DAYS} days. Tick Manual Source on the ones you sourced.`;
  }

  function setViewMode(mode) {
    viewMode = mode;
    updateCoveredButton();
    const empty = root.querySelector("#ltl-empty");
    if (mode !== "lookup") {
      state.lookup = [];
      state.lookupInfo = null;
    }
    if (mode === "covered" && !(state.covered || []).length) {
      showEmptyNotice(`No runs covered in the last ${COVERED_DAYS} days yet.`);
    } else if (emptyNotice && /^(No runs covered|Not found in SMC)/.test(emptyNotice)) {
      clearEmptyNotice();
      empty.style.display = "none";
    }
    applySearchAndRender();
  }

  // ── full load: SMC + records ────────────────────────────────────────────────
  // SMC is the read source of truth for the load list (VRID present, no carrier);
  // SharePoint records are merged on top by orderid|vrid.
  // Convert a local "YYYY-MM-DD" + local time-of-day into a UTC ISO string, so
  // the SMC window lines up with the dates the user sees (local), not UTC days.
  function localDayToUtcIso(dateStr, h, m) {
    if (!dateStr) return "";
    const [y, mo, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, (mo || 1) - 1, d || 1, h, m, 0, 0); // local
    return dt.toISOString().replace(/\.\d+Z$/, ".000Z");
  }

  // The SMC fetch window from the date inputs:
  //  - start = selected Start day at 00:00 local
  //  - end   = selected End day at 00:05 local  (per requirement: "tomorrow 12:05am")
  function dateWindow() {
    const g = (id) => root.querySelector(`#${id}`)?.value?.trim() || "";
    const start = g("ltl-start");
    const end = g("ltl-end");
    return {
      start: start ? localDayToUtcIso(start, 0, 0) : "",
      end: end ? localDayToUtcIso(end, 0, 5) : "",
    };
  }

  // Load (and cache per team) the shipper source-of-truth map from SharePoint.
  // Only for teams that have one. `force` bypasses the cache (after an import).
  function teamHasShippers() {
    return !!(teamCfg && (teamCfg.shipperList || teamCfg.shipperSource));
  }

  async function ensureShippers(force = false) {
    if (!teamHasShippers()) {
      shipperMap = null;
      shipperInfo = null;
      return null;
    }
    if (shipperMap && !force) return shipperMap;
    const res = await msg("getShippers", { force });
    shipperMap = (res && res.shippers) || {};
    shipperInfo = res || null;
    return shipperMap;
  }

  // Team-scoped SMC options: query overrides + sourcing knobs (+ shipper
  // allow-list for teams whose scope is defined by a shipper list).
  function smcOptions() {
    const opts = { query: teamCfg.smcQuery, sourcing: teamCfg.sourcing };
    if (teamHasShippers() && shipperMap) {
      opts.shipperIds = Object.keys(shipperMap);
      opts.shipperMap = shipperMap;
    }
    return opts;
  }

  // Sentinel for "a load step showed the blocker and aborted": callers check
  // `state.rows === null` and return without rendering.
  function abortLoad(services, reasons = {}) {
    state.rows = null;
    showBlocker(services, fetchData, reasons);
  }

  // Fail the named pipeline step in place with the real error and abort.
  function failStep(key, e, services) {
    const message = String((e && e.message) || e);
    Loader.fail(key, message, { services, onRetry: fetchData });
    state.rows = null;
  }

  // ── LTL: FMC is the source, SMC enriches, rows tagged FM / MM ─────────────
  async function loadFromFmc() {
    const win = dateWindow();
    const fs = teamCfg.fmcSearch;

    // 1. FMC criteria search → the candidate list.
    Loader.start("fmc", `${fs.shipperAccounts.join(", ")} × ${fs.carriers.join("/")} …`);
    let fmcRecords;
    try {
      ({ records: fmcRecords } = await msg("fmcSearch", {
        criteria: {
          shipperAccounts: fs.shipperAccounts,
          carriers: fs.carriers,
          tenderStatuses: fs.tenderStatuses,
          start: win.start,
          end: win.end,
        },
      }));
    } catch (e) {
      console.error("[LTL overlay] FMC search failed:", e);
      failStep("fmc", e, ["FMC"]);
      return;
    }
    const all = Object.entries(fmcRecords).map(([vrid, rec]) => ({ vrid, ...rec }));
    Loader.done("fmc", `${all.length} run${all.length === 1 ? "" : "s"} on placeholder carriers`);

    // 2. Drop runs FMC itself no longer treats as open: CANCELLED, or an
    //    uncovered-load disruption that is RESOLVED (the run got a carrier or
    //    was killed — either way, not ours to source).
    Loader.start("filter", "");
    const rows = all.filter((r) => {
      if (String(r.vehicle_execution_status || "").toUpperCase() === "CANCELLED") return false;
      if (r.fmc_uncovered && r.fmc_uncovered !== "ACTIVE") return false;
      return true;
    });
    for (const r of rows) r._fmc_validated = true; // they ARE FMC records
    const dropped = all.length - rows.length;
    Loader.done("filter", dropped ? `${rows.length} open · dropped ${dropped} cancelled/resolved` : `${rows.length} open`);

    console.info(
      `[LTL overlay] FMC search: ${all.length} runs → ${rows.length} open ` +
        `(dropped ${dropped} cancelled/resolved). Accounts:`,
      countBy(rows, (r) => r.shipper_account || "(none)"),
      "Carriers:",
      countBy(rows, (r) => r.vehicle_carrier || "(empty)")
    );

    // 3. SMC enrichment + FM/MM tagging. Any VRID SMC knows is FIRST MILE
    //    (it's a shipper order); anything SMC has never heard of is MIDDLE
    //    MILE. SMC only adds shipper/order context — it never gates the list.
    const vrids = rows.map((r) => r.vrid);
    let smcRows = [];
    let found = new Set();
    let smcFailed = null;
    Loader.start("smc", vrids.length ? `looking up ${vrids.length} VRIDs in SMC…` : "no runs to look up");
    if (vrids.length) {
      try {
        // Wide window: the SMC order's origin date may sit outside the FMC
        // planned-dock window (multi-day plans), so look a week either side.
        const wide = widenWindow(win, 7);
        const res = await msg("smcLookup", { ids: vrids, win: wide, opts: smcOptions() });
        smcRows = res.rows || [];
        found = new Set((res.found || []).map(String));
      } catch (e) {
        // SMC was live at pre-flight; if the lookup fails now, don't lose the
        // FMC list — tag everything MM-unknown and say so, rather than block.
        console.error("[LTL overlay] SMC enrichment failed:", e);
        smcFailed = e;
      }
    }
    const smcByVrid = {};
    for (const s of smcRows) if (s.vrid) smcByVrid[String(s.vrid).trim()] = s;

    let fm = 0;
    let mm = 0;
    for (const r of rows) {
      const s = smcByVrid[r.vrid];
      if (s && found.has(r.vrid)) {
        r.mile = "FM";
        fm += 1;
        // SMC owns order/shipper context. FMC owns execution facts, so only
        // fill from SMC where FMC left a gap.
        for (const f of SMC_ENRICH_FIELDS) {
          if ((r[f] == null || r[f] === "") && s[f] != null && s[f] !== "") r[f] = s[f];
        }
        r.orderid = s.orderid || r.orderid || "";
      } else {
        r.mile = "MM";
        mm += 1;
        // No SMC order → identity is the VRID alone. Keep orderid empty rather
        // than fabricating one; rowKey stays "|VRID".
        if (!r.orderid) r.orderid = "";
        if (!r.shippername) r.shippername = r.shipper_account || "";
      }
    }
    console.info(`[LTL overlay] tagged ${fm} FM (in SMC) / ${mm} MM (not in SMC)`);
    if (smcFailed) {
      // Degraded, not fatal: the step is done but the caption says so, and a
      // toast flags it once the table is up.
      Loader.done("smc", `SMC unavailable — all ${rows.length} tagged MM (${smcFailed.message})`);
      toast(`Loaded ${rows.length} runs from FMC, but SMC enrichment failed: ${smcFailed.message}`, "error");
    } else {
      Loader.done("smc", `${fm} FM · ${mm} MM`);
    }

    state.rows = rows;
  }

  // Fields SMC may supply for a first-mile run when FMC's record lacks them.
  const SMC_ENRICH_FIELDS = [
    "shippername", "shipperid", "shipper_group", "shipper_ref",
    "orig_country", "dest_country", "origin", "dest", "lane",
    "origin_code", "dest_code", "orig_node", "dest_node",
    "equipment_type", "freight_type", "isa", "revenue",
  ];

  function widenWindow(win, days) {
    const ms = days * 86400_000;
    const s = win.start ? new Date(new Date(win.start).getTime() - ms) : null;
    const e = win.end ? new Date(new Date(win.end).getTime() + ms) : null;
    const iso = (d) => (d ? d.toISOString().replace(/\.\d+Z$/, ".000Z") : "");
    return { start: iso(s), end: iso(e) };
  }

  function countBy(rows, keyFn) {
    const out = {};
    for (const r of rows) {
      const k = keyFn(r);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  // ── CST: SMC is the source, FMC validates, carrier gate decides ───────────
  async function loadFromSmc() {
    Loader.start("smc", "fetching the team's orders…");
    let smcRows;
    try {
      // Through the background → SMC-tab bridge (this page can't fetch SMC).
      ({ rows: smcRows } = await msg("smcSourcingRows", { win: dateWindow(), opts: smcOptions() }));
    } catch (e) {
      console.error("[LTL overlay] SMC fetch failed:", e);
      failStep("smc", e, ["SMC"]);
      return;
    }
    state.rows = smcRows;
    Loader.done("smc", `${smcRows.length} order row${smcRows.length === 1 ? "" : "s"} with a VRID and no SMC carrier`);

    // Validate on FMC WHILE STILL LOADING (before showing the table).
    // Blocking: the table is only rendered once every load has been checked
    // against live FMC. If FMC can't be reached now, fail in place rather than
    // presenting unvalidated SMC data.
    Loader.start("fmc", smcRows.length ? `validating ${smcRows.length} VRIDs…` : "nothing to validate");
    if (smcRows.length) {
      try {
        await enrichFmcStatuses({ render: false });
      } catch (e) {
        console.error("[LTL overlay] FMC validation failed:", e);
        failStep("fmc", e, ["FMC"]);
        return;
      }
    }
    const validated = state.rows.filter((r) => r._fmc_validated).length;
    Loader.done("fmc", `${validated} of ${smcRows.length} found in FMC`);

    // "Needs sourcing" is CONTROLLED BY FMC's vehicle_carrier: keep only rows
    // whose (now FMC-validated) carrier is empty or a placeholder.
    Loader.start("filter", "");
    const before = state.rows.length;
    const carrierCounts = countBy(state.rows, (r) => String(r.vehicle_carrier ?? "").trim().toUpperCase() || "(empty)");
    console.info(
      `[LTL overlay] FMC validated ${validated}/${before} rows. Carrier breakdown:`,
      carrierCounts,
      `| placeholders treated as "needs sourcing":`,
      [...placeholderCarriers()]
    );
    state.rows = state.rows.filter(needsSourcingByFmcCarrier);
    console.info(`[LTL overlay] FMC carrier gate: ${before} → ${state.rows.length} need sourcing`);
    Loader.done("filter", `${state.rows.length} of ${before} still on a placeholder carrier`);

    // SMC-sourced rows are all shipper orders → first mile.
    for (const r of state.rows) r.mile = "FM";
  }

  async function fetchData() {
    if (!teamCfg) {
      showTeamPicker();
      return;
    }
    try {
      setBusy(true);
      dismissBlocker();

      // The pipeline this team's load will walk through, shown up front.
      const fmcSourced = !!teamCfg.fmcSearch;
      const s = root.querySelector("#ltl-start")?.value || "";
      const e0 = root.querySelector("#ltl-end")?.value || "";
      Loader.begin(
        fmcSourced ? "Loading runs needing sourcing" : "Loading loads needing sourcing",
        fmcSourced
          ? [
              { key: "sessions", label: "Sessions", hint: "SMC · FMC · SharePoint" },
              { key: "fmc", label: "Search FMC", hint: `${teamCfg.fmcSearch.shipperAccounts.length} shipper accounts × ${teamCfg.fmcSearch.carriers.length} placeholder carriers` },
              { key: "filter", label: "Drop closed runs", hint: "cancelled / uncovered-resolved" },
              { key: "smc", label: "Tag FM / MM via SMC", hint: "VRID in SMC = first mile, else middle mile" },
              { key: "records", label: "Merge SharePoint records", hint: "manual-source + email state" },
            ]
          : [
              { key: "sessions", label: "Sessions", hint: "SMC · FMC · SharePoint" },
              { key: "smc", label: "Fetch SMC orders", hint: "the team's shipper orders" },
              { key: "fmc", label: "Validate on FMC", hint: "carrier / status / tour / yard times" },
              { key: "filter", label: "Carrier gate", hint: "keep only placeholder carriers" },
              { key: "records", label: "Merge SharePoint records", hint: "manual-source + email state" },
            ],
        s || e0 ? `Window ${s || "…"} 00:00 → ${e0 || "…"} 00:05` : ""
      );

      // ── Session pre-flight (BEFORE fetching/rendering anything) ───────────
      // We validate every load on FMC and save annotations to SharePoint, so
      // all three sessions must be live. If any is missing, the step fails in
      // place — nothing is fetched or rendered.
      Loader.start("sessions", "checking SMC, FMC and SharePoint…");
      let expired = [];
      let reasons = {};
      try {
        ({ expired, reasons = {} } = await msg("checkSessions", { services: ["SMC", "SharePoint", "FMC"] }));
      } catch (e) {
        // The check itself failed (background unreachable) — not a sign-in
        // problem we can prove, so say so rather than demand a login.
        expired = ["SMC", "SharePoint", "FMC"];
        const m = `session check failed: ${e && e.message ? e.message : e}`;
        reasons = Object.fromEntries(expired.map((x) => [x, { message: m, expired: false }]));
      }
      if (expired && expired.length) {
        console.warn("[LTL overlay] pre-flight blocked:", reasons);
        const allExpired = expired.every((x) => !reasons[x] || reasons[x].expired !== false);
        const detail = expired
          .map((x) => `${x}: ${(reasons[x] && reasons[x].message) || (allExpired ? "sign-in required" : "not reachable")}`)
          .join("  ·  ");
        Loader.fail("sessions", detail, { services: expired, onRetry: fetchData });
        state.rows = null;
        return;
      }
      Loader.done("sessions", "SMC ✓ · FMC ✓ · SharePoint ✓");

      // Teams scoped by a shipper list can't query SMC without it.
      if (teamHasShippers()) {
        try {
          await ensureShippers();
        } catch (e) {
          toast(`Couldn't load ${teamCfg.label} shippers from SharePoint: ${e.message}`, "error");
          return;
        }
        updateShippersButton();
        if (!shipperMap || !Object.keys(shipperMap).length) {
          state.rows = [];
          populateFilters();
          applySearchAndRender();
          const file = teamCfg.shipperSource && teamCfg.shipperSource.file;
          showEmptyNotice(
            file
              ? `Couldn't find “${file}” in SharePoint for ${teamCfg.label}. Make sure ` +
                  `CST_viewer's update_shippers.py has published it to the “Amazon Freight ` +
                  `Operations - CST” library, or use “Shippers · Import” to load the CSV manually.`
              : `No shippers configured for ${teamCfg.label} yet. Import the shipper ` +
                  `source-of-truth CSV (shipperid, shippername, shipper_group) with “Shippers · Import”.`
          );
          return;
        }
      }

      if (teamCfg.fmcSearch) {
        // ══ FMC-SOURCED load list (LTL) ═══════════════════════════════════
        // FMC is the SOURCE: search by shipper account × placeholder carrier ×
        // planned-dock window. Middle-mile runs never touch SMC, so this is the
        // only way to see them. Every returned run is on a placeholder carrier,
        // i.e. it needs sourcing by construction.
        await loadFromFmc();
      } else {
        // ══ SMC-SOURCED load list (CST) ═══════════════════════════════════
        await loadFromSmc();
      }
      if (state.rows === null) return; // a load step showed the blocker and aborted

      // SharePoint annotations (manual-source / email state) merged on top.
      Loader.start("records", "reading manual-source + email state…");
      let records = {};
      try {
        records = await msg("getRecords");
      } catch (e) {
        // SharePoint was live at pre-flight; a failure here is unexpected —
        // fail the step in place rather than silently showing bare rows.
        console.error("[LTL overlay] SharePoint records failed:", e);
        failStep("records", e, ["SharePoint"]);
        return;
      }
      mergeRecords(state.rows, records);
      state.covered = coveredRowsFrom(records);
      viewMode = "sourcing";
      updateCoveredButton();
      clearEmptyNotice();
      const nRec = Object.keys(records || {}).length;
      Loader.done("records", `${nRec} record${nRec === 1 ? "" : "s"} merged`);
      Loader.finish();

      // Single render — table appears already FMC-validated + record-merged.
      populateFilters();
      applySearchAndRender();

      root.querySelector("#ltl-window").textContent =
        s || e0 ? `Window: ${s || "…"} 00:00 → ${e0 || "…"} 00:05` : "";
      root.querySelector("#ltl-updated").textContent =
        `Updated: ${new Date().toLocaleString()} — ${teamCfg.label}: ${state.rows.length} need sourcing`;

      // After the table is up: auto-track every run on the list (so RLB
      // pickups become visible outcomes), then check whether tracked runs got
      // covered. Background, throttled, never blocks the table.
      trackSeenThenSweep();
    } catch (e) {
      // An unexpected throw outside a tracked step: fail whichever step was
      // active so the pipeline still tells the truth about where it stopped.
      console.error("[LTL overlay] fetchData failed:", e);
      Loader.fail(null, String((e && e.message) || e), { onRetry: fetchData });
      state.rows = null;
    } finally {
      setBusy(false);
      autoReset(); // restart the auto-refresh clock after every load
    }
  }

  // ── outcome sweep: mark worked records "covered" once FMC shows a real carrier
  // Runs at most every SWEEP_MIN_INTERVAL_MS per team unless forced. Result is
  // logged; the Dashboard picks the updated records up on its next read.
  const SWEEP_MIN_INTERVAL_MS = 15 * 60_000;
  const _lastSweep = {}; // team key -> timestamp

  // Record every run currently on the list (one write per NEW run; existing
  // ones are bumped at most daily on the background side), then sweep.
  async function trackSeenThenSweep() {
    if (!teamCfg) return;
    try {
      const rows = keysOf(state.rows);
      if (rows.length) {
        const res = await msg("trackSeen", { rows });
        if (res && (res.added || res.updated)) {
          console.info(`[LTL overlay] tracked ${rows.length} runs (${teamCfg.label}): +${res.added} new, ~${res.updated} updated`);
        }
      }
    } catch (e) {
      console.info(`[LTL overlay] trackSeen failed (${teamCfg.label}): ${e.message}`);
    }
    await sweepOutcomes();
  }

  async function sweepOutcomes({ force = false } = {}) {
    if (!teamCfg) return null;
    const last = _lastSweep[teamCfg.key] || 0;
    if (!force && Date.now() - last < SWEEP_MIN_INTERVAL_MS) return null;
    _lastSweep[teamCfg.key] = Date.now();
    try {
      const res = await msg("sweepOutcomes");
      if (res && res.skipped) {
        console.info(`[LTL overlay] outcome sweep skipped (${teamCfg.label}): ${res.skipped}`);
      } else if (res) {
        console.info(
          `[LTL overlay] outcome sweep (${teamCfg.label}): checked ${res.checked}, ` +
            `newly covered ${res.covered} (MS ${res.coveredMs || 0}, RLB ${res.coveredRlb || 0}), ` +
            `still open ${res.open}, expired ${res.expired || 0}`
        );
        if (res.covered) {
          const bits = [];
          if (res.coveredMs) bits.push(`${res.coveredMs} manual sourced`);
          if (res.coveredRlb) bits.push(`${res.coveredRlb} via RLB`);
          toast(`${res.covered} run(s) now covered (${bits.join(", ")})`, "success");
          // Newly covered runs belong in the "Recently covered" view right away.
          await refreshRecords();
        }
      }
      return res;
    } catch (e) {
      console.info(`[LTL overlay] outcome sweep failed (${teamCfg.label}): ${e.message}`);
      return null;
    }
  }

  // ── light refresh after a save: re-merge SharePoint records onto the rows
  // already in memory, WITHOUT re-pulling from SMC. Avoids a full ~3.8k-order
  // re-fetch (and avoids masking a successful save when the SMC/Midway session
  // has expired). ──────────────────────────────────────────────────────────
  async function refreshRecords() {
    try {
      const records = await msg("getRecords");
      mergeRecords(state.rows, records);
      state.covered = coveredRowsFrom(records);
      updateCoveredButton();
      applySearchAndRender();
    } catch (e) {
      toast(`Saved, but couldn't refresh records: ${e.message}`, "error");
    }
  }

  // Live FMC validation of the current VRIDs, merged onto rows.
  // BLOCKING in the load path: fetchData awaits this (render:false) before the
  // table is shown, so rows appear already FMC-validated. Failures are NOT
  // swallowed — they propagate so fetchData can show the session blocker.
  // Fields FMC owns on a row (overwrite SMC's where FMC has a value).
  const FMC_FIELDS = [
    "vehicle_execution_status", "vehicle_carrier", "carrier_name", "tour_id",
    "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
  ];

  // Validate rows against live FMC. Merges FMC's execution status / carrier /
  // tour / yard times onto state.rows in place.
  //
  // `render` controls whether it re-renders on its own (true) or just mutates
  // the rows and lets the caller render (false — used by the blocking load path
  // so the table appears once, already FMC-validated).
  //
  // Throws on bridge/session failure so the caller can surface it (the blocking
  // load path shows the centered session blocker instead of silently skipping).
  async function enrichFmcStatuses({ render = true, rows = state.rows } = {}) {
    const vrids = [
      ...new Set(rows.map((r) => String(r.vrid ?? "").trim()).filter(Boolean)),
    ];
    if (!vrids.length) return 0;
    const { records } = await msg("fmcStatuses", { vrids });
    let changed = 0;
    for (const r of rows) {
      const rec = records[String(r.vrid ?? "").trim()];
      if (!rec) continue;
      for (const f of FMC_FIELDS) {
        if (rec[f] != null && rec[f] !== "" && r[f] !== rec[f]) {
          r[f] = rec[f];
          changed += 1;
        }
      }
      // Mark that FMC actually returned a record for this row (validated).
      r._fmc_validated = true;
      // Stash stop refs for the lazy address lookup at EML time.
      r._fmc_orig_stop = rec._fmc_orig_stop || null;
      r._fmc_dest_stop = rec._fmc_dest_stop || null;
    }
    if (render && changed) {
      populateFilters(); // carrier/status dropdowns now reflect FMC values
      applySearchAndRender();
    }
    dlog(`FMC validation updated ${changed} field(s) across ${vrids.length} vrids`);
    return changed;
  }

  // FMC placeholder carriers meaning "not yet sourced" (from the team config,
  // with the historical CST/FMC defaults as fallback).
  const FALLBACK_PLACEHOLDER_CARRIERS = ["RLB1", "AZNG", "DUMMY"];
  function placeholderCarriers() {
    const list =
      (teamCfg && teamCfg.sourcing && teamCfg.sourcing.placeholderCarriers) ||
      FALLBACK_PLACEHOLDER_CARRIERS;
    return new Set(list.map((c) => String(c).trim().toUpperCase()));
  }

  /**
   * The sourcing decision, controlled by FMC's vehicle_carrier.
   *
   * Runs AFTER enrichFmcStatuses, so `r.vehicle_carrier` is FMC's value when
   * FMC has one (enrichment only overwrites with non-empty values), otherwise
   * SMC's (normally empty). A row still needs sourcing when that carrier is:
   *   - empty          → no carrier at all, or FMC didn't return this VRID
   *                      (kept: don't silently hide loads FMC hasn't indexed)
   *   - a placeholder  → RLB1 / AZNG / DUMMY = FMC's "not yet sourced" marker
   * Any other (real) carrier code means the load is covered → excluded.
   */
  // Optional prefix-based placeholders (e.g. Amazon's internal LTL carriers
  // "XUK8"/"XDE7" all start with "X"). From teamCfg.sourcing.placeholderCarrierPrefixes.
  function placeholderCarrierPrefixes() {
    const list =
      (teamCfg && teamCfg.sourcing && teamCfg.sourcing.placeholderCarrierPrefixes) || [];
    return list.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
  }

  function needsSourcingByFmcCarrier(r) {
    const carrier = String(r.vehicle_carrier ?? "").trim().toUpperCase();
    if (!carrier) return true;
    if (placeholderCarriers().has(carrier)) return true;
    return placeholderCarrierPrefixes().some((p) => carrier.startsWith(p));
  }

  function applySearchAndRender() {
    // 1. toolbar filters (country/status/shipper/date range)
    const preds = toolbarPredicates();
    const source = currentRows() || [];
    let base = preds.length ? source.filter((r) => preds.every((p) => p(r))) : [...source];

    // 2. text search
    const raw = state.search.trim();
    if (!raw) {
      state.filtered = base;
    } else {
      const terms = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (terms.length > 1) {
        state.filtered = base.filter((r) => {
          const vrid = String(r.vrid ?? "").toLowerCase();
          const oid = String(r.orderid ?? r.order_id ?? "").toLowerCase();
          return terms.some((t) => (vrid && vrid === t) || (oid && oid === t));
        });
      } else {
        const term = raw.toLowerCase();
        const cols = columns();
        state.filtered = base.filter((r) =>
          cols.some((c) => String(r[c] ?? "").toLowerCase().includes(term))
        );
      }
    }
    if (state.sortKey) sortRows();
    renderTable();
  }

  function sortRows() {
    const mult = state.sortDir === "asc" ? 1 : -1;
    state.filtered.sort((a, b) => {
      const va = a[state.sortKey] ?? "";
      const vb = b[state.sortKey] ?? "";
      if (va !== "" && vb !== "" && !isNaN(va) && !isNaN(vb)) {
        return (parseFloat(va) - parseFloat(vb)) * mult;
      }
      return String(va).localeCompare(String(vb)) * mult;
    });
  }

  function renderTable() {
    const tbody = root.querySelector("#ltl-tbody");
    const thead = root.querySelector("#ltl-thead");
    tbody.innerHTML = "";
    thead.innerHTML = "";

    // header: select-all + columns + Actions
    const selTh = el("th", {}, [
      el("input", {
        type: "checkbox",
        onchange: (e) => {
          tbody.querySelectorAll(".ltl-row-select").forEach((cb) => (cb.checked = e.target.checked));
          updateSelectedCount();
        },
      }),
    ]);
    thead.appendChild(selTh);
    const cols = columns();
    for (const col of cols) {
      const arrow = state.sortKey === col ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
      thead.appendChild(
        el("th", {
          text: col.replace(/_/g, " ") + arrow,
          onclick: () => {
            state.sortDir = state.sortKey === col && state.sortDir === "asc" ? "desc" : "asc";
            state.sortKey = col;
            applySearchAndRender();
          },
        })
      );
    }
    thead.appendChild(el("th", { text: "Email" }));
    thead.appendChild(el("th", { text: "Manual Source" }));

    const empty = root.querySelector("#ltl-empty");
    if (!state.filtered.length) {
      empty.style.display = "block";
      if (!emptyNotice) empty.textContent = "No data found";
    } else {
      empty.style.display = "none";
    }

    for (const row of state.filtered) {
      const tr = el("tr", row._lookup ? { class: "ltl-row-lookup" } : {});
      // select checkbox (carries full row for EML). Lookup rows are read-only:
      // not selectable, nothing saved for them — they just show what SMC has.
      tr.appendChild(
        el("td", {}, [
          row._lookup
            ? el("span", { class: "ltl-badge ltl-badge-blue", text: "SMC", title: "Direct SMC lookup — not on the sourcing list, read-only" })
            : el("input", {
                type: "checkbox",
                class: "ltl-row-select",
                "data-vrid": row.vrid || "",
                onchange: updateSelectedCount,
              }),
        ])
      );
      // store row for EML retrieval
      tr._ltlRow = row;

      for (const col of cols) {
        const val = row[col];
        const raw = val == null ? "" : String(val);
        if (col === "mile") {
          // FM = first mile (VRID exists in SMC), MM = middle mile (FMC only).
          const isFm = raw === "FM";
          tr.appendChild(
            el("td", {}, [
              el("span", {
                class: `ltl-badge ${isFm ? "ltl-badge-blue" : "ltl-badge-purple"}`,
                text: raw || "?",
                title: isFm
                  ? "First mile — shipper order found in SMC"
                  : "Middle mile — Amazon-internal run, not in SMC",
              }),
            ])
          );
        } else if (LINKS[col] && raw.trim() !== "") {
          const a = el("a", {
            href: LINKS[col](raw),
            target: "_blank",
            rel: "noopener noreferrer",
            class: "ltl-link",
            text: raw,
          });
          tr.appendChild(el("td", {}, [a]));
        } else {
          const text = DATE_COLS.has(col) ? fmtDateTime(val, row.orig_country) : raw;
          // Carrier cell shows the SCAC; the full name (from FMC) is on hover.
          const title = col === "vehicle_carrier" && row.carrier_name ? String(row.carrier_name) : null;
          tr.appendChild(el("td", { text, title }));
        }
      }
      if (row._lookup) {
        // Read-only: show saved state as text (if a record exists), no controls.
        const emailTxt = truthy(row.email_sent) ? "Sent" : row.email_generated_at ? "Pending" : "";
        tr.appendChild(el("td", { text: emailTxt, class: "ltl-muted" }));
        tr.appendChild(el("td", { text: truthy(row.is_manual_source) ? "Yes" : "", class: "ltl-muted" }));
      } else {
        tr.appendChild(el("td", {}, [emailCell(row)]));
        tr.appendChild(el("td", {}, [manualSourceCell(row)]));
      }
      tbody.appendChild(tr);
    }

    root.querySelector("#ltl-count").textContent =
      viewMode === "covered"
        ? `${state.filtered.length} recently covered`
        : viewMode === "lookup"
          ? `${state.filtered.length} from SMC lookup`
          : `${state.filtered.length} rows`;
    renderLookupBar();
    updateSelectedCount();
  }

  // ── email status cell (ports table.js badge logic) ────────────────────────
  function emailCell(row) {
    const wrap = el("div");
    if (truthy(row.email_sent)) {
      wrap.appendChild(
        el("input", {
          type: "checkbox",
          checked: "checked",
          "data-vrid": row.vrid,
          onchange: (e) => onEmailToggle(e, row),
        })
      );
      wrap.appendChild(
        el("span", { class: "ltl-badge ltl-badge-green", text: `Sent ✅ (${row.email_sent_count || 1})` })
      );
    } else if (row.email_generated_at) {
      wrap.appendChild(
        el("input", {
          type: "checkbox",
          "data-vrid": row.vrid,
          onchange: (e) => onEmailToggle(e, row),
        })
      );
      wrap.appendChild(
        el("span", {
          class: "ltl-badge ltl-badge-yellow",
          text: `Pending 📧 (${row.email_sent_count || 0})`,
          title: `Generated at: ${row.email_generated_at}`,
        })
      );
    } else {
      wrap.appendChild(el("span", { class: "ltl-badge ltl-badge-gray", text: "Not Generated" }));
    }
    return wrap;
  }

  async function onEmailToggle(e, row) {
    const newValue = e.target.checked;
    if (!(await ensureSessions(["SharePoint"], () => onEmailToggle(e, row)))) {
      e.target.checked = !newValue;
      return;
    }
    try {
      const res = await msg("toggleEmailSent", {
        orderid: row.orderid, vrid: row.vrid, value: newValue, user: await ensureUser(),
        snapshot: snapshotOf(row),
      });
      if (res.status !== "ok") throw new Error(res.message || "failed");
      toast("Email status updated", "success");
      await refreshRecords();
    } catch (err) {
      e.target.checked = !newValue;
      toast(`Failed to update email: ${err.message}`, "error");
    }
  }

  // ── manual-source cell (ports table.js toggle-manual-source) ──────────────
  function manualSourceCell(row) {
    return el("input", {
      type: "checkbox",
      ...(row.is_manual_source ? { checked: "checked" } : {}),
      "data-vrid": row.vrid,
      onchange: (e) => onManualSourceToggle(e, row),
    });
  }

  async function onManualSourceToggle(e, row) {
    const newValue = e.target.checked;
    let sims = null;
    let ms_cost = null;
    if (newValue) {
      sims = prompt("Enter SIMS value before marking as manual source:");
      if (!sims) {
        alert("SIMS is required!");
        e.target.checked = false;
        return;
      }
      const costInput = prompt("Enter Manual Source Cost (€):");
      if (costInput !== null && costInput !== "") {
        const parsed = parseFloat(costInput);
        if (isNaN(parsed) || parsed < 0) {
          alert("Please enter a valid cost amount.");
          e.target.checked = false;
          return;
        }
        ms_cost = parsed;
      }
    }
    if (!confirm("Are you sure you want to change manual status for this VRID?")) {
      e.target.checked = !newValue;
      return;
    }
    // Don't change anything if SharePoint can't save it.
    if (!(await ensureSessions(["SharePoint"], () => onManualSourceToggle(e, row)))) {
      e.target.checked = !newValue;
      return;
    }
    try {
      const res = await msg("toggleManualSource", {
        orderid: row.orderid, vrid: row.vrid, value: newValue, sims, ms_cost, user: await ensureUser(),
        snapshot: snapshotOf(row),
      });
      if (res.status !== "ok") throw new Error(res.message || "failed");
      toast("Manual source updated", "success");
      await refreshRecords();
    } catch (err) {
      e.target.checked = !newValue;
      toast(`Error updating manual source: ${err.message}`, "error");
    }
  }

  // ── bulk EML ──────────────────────────────────────────────────────────────
  function selectedRows() {
    const out = [];
    root.querySelectorAll("#ltl-tbody tr").forEach((tr) => {
      const cb = tr.querySelector(".ltl-row-select");
      if (cb && cb.checked && tr._ltlRow) out.push(tr._ltlRow);
    });
    return out;
  }

  function updateSelectedCount() {
    const n = root.querySelectorAll("#ltl-tbody .ltl-row-select:checked").length;
    root.querySelector("#ltl-eml-count").textContent = n;
  }

  // Load-context fields snapshotted onto the SharePoint record at save time so
  // history exports still have shipper/lane/dates after the load leaves SMC's
  // sourcing list. Mirrors SNAPSHOT_FIELDS in background/runsService.js.
  const SNAPSHOT_FIELDS = [
    "shippername", "shipper_group", "orig_node", "dest_node", "orig_country",
    "dest_country", "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
    "vehicle_carrier", "tour_id", "freight_type",
  ];
  function snapshotOf(row) {
    const s = {};
    if (row._fromRecord) return s; // record-derived row: snapshot already stored
    for (const f of SNAPSHOT_FIELDS) if (row[f] != null && row[f] !== "") s[f] = row[f];
    return s;
  }

  // Build [{orderid, vrid, ...snapshot}] keys from rows (composite identity for
  // SharePoint plus the load-context snapshot).
  function keysOf(rows) {
    return rows
      .filter((r) => r.orderid && r.vrid)
      .map((r) => ({ orderid: r.orderid, vrid: r.vrid, ...snapshotOf(r) }));
  }

  async function onSendEml() {
    const rows = selectedRows();
    if (!rows.length) {
      toast("Select at least one row", "info");
      return;
    }
    // Pre-flight BOTH sessions the EML needs: FMC (addresses) and SharePoint
    // (recording it). If either is expired, do nothing — no EML is generated —
    // and prompt to re-auth. (Per requirement: don't generate if it can't be
    // recorded.)
    if (!(await ensureSessions(["FMC", "SharePoint"], onSendEml))) return;

    // 1. Resolve addresses + build/download the EML (recipients/subject per team).
    try {
      await resolveAddressesFor(rows);
      await window.__ltlEml.generateBulkEmailEML(rows, null, teamCfg.eml);
    } catch (e) {
      toast(`EML failed: ${e.message}`, "error");
      return;
    }

    // 2. Record it in SharePoint (mark-generated).
    toast(`📧 EML generated (${rows.length} loads)`, "success");
    try {
      await msg("markEmailsGenerated", { keys: keysOf(rows), user: await ensureUser() });
      await refreshRecords();
    } catch (e) {
      toast(`EML generated, but couldn't record it: ${e.message}`, "error");
    }
  }

  // Fetch orig/dest addresses for the given rows (FMC nodeaddressforvr) and
  // merge onto them. Best-effort: rows without stop refs just keep blanks.
  async function resolveAddressesFor(rows) {
    const withRefs = rows.filter((r) => r.vrid && (r._fmc_orig_stop || r._fmc_dest_stop));
    const missingRefs = rows.filter((r) => r.vrid && !r._fmc_orig_stop && !r._fmc_dest_stop);
    if (missingRefs.length) {
      dlog(
        `address: ${missingRefs.length} selected row(s) have NO FMC stop refs ` +
          `(FMC enrichment didn't run for them?):`,
        missingRefs.map((r) => r.vrid)
      );
    }
    if (!withRefs.length) {
      dlog("address: no rows with FMC stop refs — nothing to resolve");
      return;
    }
    const items = withRefs.map((r) => ({
      vrid: r.vrid,
      orig: r._fmc_orig_stop,
      dest: r._fmc_dest_stop,
    }));
    try {
      const { addresses } = await msg("fmcAddresses", { items });
      let ok = 0;
      const errs = [];
      for (const r of rows) {
        const a = addresses[String(r.vrid ?? "").trim()];
        if (!a) continue;
        if (a.orig_address) r.orig_address = a.orig_address;
        if (a.dest_address) r.dest_address = a.dest_address;
        if (a.orig_address || a.dest_address) ok += 1;
        if (a.orig_error) errs.push(`${r.vrid} orig: ${a.orig_error}`);
        if (a.dest_error) errs.push(`${r.vrid} dest: ${a.dest_error}`);
      }
      dlog(`address: resolved ${ok}/${items.length} rows`);
      if (errs.length) {
        console.warn("[LTL overlay] address errors:", errs);
        if (ok === 0) toast(`Address lookup failed (${errs[0]})`, "error");
      }
    } catch (e) {
      dlog(`address resolve failed: ${e.message}`);
      toast(`Address lookup failed: ${e.message}`, "error");
    }
  }

  async function onMarkSent() {
    const rows = selectedRows();
    const keys = keysOf(rows);
    if (!keys.length) {
      toast("Select at least one row", "info");
      return;
    }
    if (!confirm(`Mark ${keys.length} loads as sent?`)) return;
    if (!(await ensureSessions(["SharePoint"], onMarkSent))) return;
    try {
      const res = await msg("markEmailsSent", { keys, user: await ensureUser() });
      if (res.status !== "ok") throw new Error(res.message || "failed");
      toast(`${keys.length} marked as sent`, "success");
      await refreshRecords();
    } catch (e) {
      toast(`Failed: ${e.message}`, "error");
    }
  }

  // ── CSV export (current filtered rows, incl. who worked on each) ──────────
  const CSV_COLUMNS = [
    "orderid", "vrid", "shippername", "tour_id",
    "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
    "orig_node", "dest_node", "orig_country", "dest_country",
    "vehicle_carrier", "vehicle_execution_status",
    "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
    "email_generated_at", "email_sent", "email_sent_count",
    "email_sent_confirmed_at", "email_sent_by",
  ];

  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function onDownloadCsv() {
    const rows = state.filtered;
    if (!rows.length) {
      toast("No rows to export", "info");
      return;
    }
    // Teams with a shipper list get shipper_group right after shippername.
    const csvCols = teamHasShippers()
      ? CSV_COLUMNS.flatMap((c) => (c === "shippername" ? [c, "shipper_group"] : [c]))
      : CSV_COLUMNS;
    const header = csvCols.join(",");
    const lines = rows.map((r) => csvCols.map((c) => csvCell(r[c])).join(","));
    const csv = [header, ...lines].join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const today = new Date().toISOString().split("T")[0];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${teamCfg.key}_Manual_Sourcing_${rows.length}_${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    toast(`Exported ${rows.length} rows`, "success");
  }

  // ── filter dropdown population ────────────────────────────────────────────
  // Derive dropdown options from the fetched SMC rows (no SharePoint yet).
  function populateFilters() {
    const fill = (id, field, firstLabel) => {
      const sel = root.querySelector(`#${id}`);
      if (!sel) return;
      const current = sel.value;
      const vals = [
        ...new Set(
          state.rows
            .map((r) => r[field])
            .filter((v) => v != null && String(v).trim() !== "")
            .map(String)
        ),
      ].sort((a, b) => a.localeCompare(b));
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "", text: firstLabel }));
      for (const v of vals) sel.appendChild(el("option", { value: v, text: v }));
      if (current && vals.includes(current)) sel.value = current;
    };
    fill("ltl-country", "orig_country", "All Countries");
    fill("ltl-status", "vehicle_execution_status", "All Statuses");
    fill("ltl-shipper", "shippername", "All Shippers");
    fill("ltl-group", "shipper_group", "All Groups");

    // Team status default (e.g. CST → PLANNED): make sure it's an option even
    // before FMC enrichment has populated statuses, and apply it once per team.
    const statusSel = root.querySelector("#ltl-status");
    const statusDefault = teamCfg ? teamCfg.statusDefault || "" : "";
    if (statusSel && statusDefault) {
      if (![...statusSel.options].some((o) => o.value === statusDefault)) {
        statusSel.appendChild(el("option", { value: statusDefault, text: statusDefault }));
      }
      if (!statusInit) {
        statusInit = true;
        statusSel.value = statusDefault;
      }
    }

    // Carrier multi-select: options = union of row carriers + the team defaults
    // (so RLB1/AZNG/DUMMY are always selectable). Apply defaults once per team.
    if (carrierMs) {
      const defaults = carrierDefaults();
      const rowCarriers = state.rows
        .map((r) => r.vehicle_carrier)
        .filter((v) => v != null && String(v).trim() !== "")
        .map(String);
      carrierMs.setOptions([...defaults, ...rowCarriers]);
      if (!carrierInit) {
        carrierInit = true;
        carrierMs.setSelected(defaults);
      }
    }
  }

  // ── empty-state notice (e.g. "no shippers configured") ────────────────────
  let emptyNotice = null;
  function showEmptyNotice(text) {
    emptyNotice = text;
    const empty = root.querySelector("#ltl-empty");
    empty.textContent = text;
    empty.style.display = "block";
  }
  function clearEmptyNotice() {
    emptyNotice = null;
  }

  // Shipper button for teams with a shipper source of truth. When the shippers
  // came from the SharePoint CSV it's a refresh button; otherwise (file not
  // found / list only) it offers the manual CSV import as the fallback.
  function updateShippersButton() {
    const btn = root.querySelector("#ltl-shippers");
    if (!btn) return;
    const has = teamHasShippers();
    btn.style.display = has ? "" : "none";
    const group = root.querySelector("#ltl-group");
    if (group) group.style.display = has ? "" : "none";
    if (!has) return;
    const n = shipperMap ? Object.keys(shipperMap).length : 0;
    const src = shipperInfo ? shipperInfo.source : "none";
    if (src === "file") {
      btn.textContent = `Shippers (${n}) ↻`;
      btn.title =
        `${teamCfg.label} shippers read automatically from SharePoint:\n${shipperInfo.path}\n` +
        `Loaded ${new Date(shipperInfo.fetchedAt).toLocaleTimeString()}. Click to re-read.`;
    } else {
      btn.textContent = `Shippers (${n}) · Import`;
      btn.title =
        (src === "list"
          ? `${teamCfg.label} shippers from the SharePoint list "${teamCfg.shipperList}" (the CSV file wasn't found). `
          : `No ${teamCfg.label} shippers loaded. `) + "Click to import/replace from a CSV.";
    }
  }

  async function onShippersClick() {
    if (!teamHasShippers()) return;
    if (shipperInfo && shipperInfo.source === "file") {
      // Re-read the CSV from SharePoint and reload the table.
      try {
        setBusy(true);
        await ensureShippers(true);
        updateShippersButton();
        toast(`Shippers refreshed: ${Object.keys(shipperMap || {}).length}`, "success");
      } catch (e) {
        toast(`Couldn't refresh shippers: ${e.message}`, "error");
        return;
      } finally {
        setBusy(false);
      }
      await fetchData();
      return;
    }
    await onImportShippers();
  }

  // ── shipper CSV import (port of source_of_truth_crawler.csv) ──────────────
  // Minimal RFC4180-ish parser: handles quoted cells with commas/newlines.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQ = false;
    const s = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i++;
          } else inQ = false;
        } else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  // Header aliases → canonical shipper fields.
  const SHIPPER_HEADER_ALIASES = {
    shipperid: "shipperid", "shipper id": "shipperid", shipper_id: "shipperid",
    shippername: "shippername", "shipper name": "shippername", shipper_name: "shippername", shipper: "shippername",
    shipper_group: "shipper_group", "shipper group": "shipper_group", group: "shipper_group", dept: "shipper_group",
  };

  function shipperRowsFromCsv(text) {
    const table = parseCsv(text);
    if (!table.length) return [];
    const header = table[0].map((h) => SHIPPER_HEADER_ALIASES[String(h).trim().toLowerCase()] || null);
    if (!header.includes("shipperid")) {
      throw new Error("CSV needs a 'shipperid' column (plus shippername, shipper_group)");
    }
    const out = [];
    for (const r of table.slice(1)) {
      const obj = {};
      header.forEach((k, i) => {
        if (k) obj[k] = String(r[i] ?? "").trim();
      });
      out.push(obj);
    }
    return out;
  }

  async function onImportShippers() {
    if (!teamCfg || !teamCfg.shipperList) return;
    const input = root.querySelector("#ltl-shippers-file");
    input.value = "";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let rows;
      try {
        rows = shipperRowsFromCsv(await file.text());
      } catch (e) {
        toast(`Couldn't read CSV: ${e.message}`, "error");
        return;
      }
      const valid = rows.filter((r) => /^\d+$/.test(String(r.shipperid || "")));
      if (!valid.length) {
        toast("No rows with a numeric shipperid found", "error");
        return;
      }
      if (
        !confirm(
          `Replace the ${teamCfg.label} shipper list ("${teamCfg.shipperList}") with ${valid.length} shipper(s) from ${file.name}?\n\n` +
            `Shippers not in this file will be removed from the list.`
        )
      )
        return;
      if (!(await ensureSessions(["SharePoint"], onImportShippers))) return;
      try {
        setBusy(true);
        const res = await msg("importShippers", { rows: valid });
        if (res.status !== "ok") throw new Error(res.message || "failed");
        toast(`Shippers imported: +${res.added} ~${res.updated} -${res.deleted}`, "success");
        // Re-read (the CSV file still wins if it has since become reachable).
        await ensureShippers(true);
        updateShippersButton();
      } catch (e) {
        toast(`Import failed: ${e.message}`, "error");
        return;
      } finally {
        setBusy(false);
      }
      await fetchData();
    };
    input.click();
  }

  // ── pipeline loader ───────────────────────────────────────────────────────
  // The load is a fixed sequence of steps across three systems and can take
  // 20s+ (FMC may have to open a tab). Rather than one caption that keeps
  // changing, show the whole pipeline: every step listed up front, each marked
  // pending → active → done/failed, with live counts and an elapsed timer so a
  // stall is obvious. A failure is shown IN PLACE on the step that broke, with
  // the exact error and retry/open actions — completed steps stay green so you
  // can see exactly how far the load got. This replaces the separate blocker.
  const Loader = (() => {
    let steps = []; // [{ key, label, hint, state: "pending"|"active"|"done"|"failed", detail }]
    let startedAt = 0;
    let timer = null;
    let title = "Loading…";

    const $ = (sel) => root?.querySelector(sel);

    function fmtElapsed() {
      const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const m = Math.floor(s / 60);
      return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }

    function render() {
      const list = $("#ltl-pipe-steps");
      if (!list) return;
      list.innerHTML = "";
      steps.forEach((st, i) => {
        const li = el("li", { class: `ltl-pipe-step ltl-pipe-${st.state}` });
        const dot = el("span", { class: "ltl-pipe-dot", "aria-hidden": "true" });
        dot.textContent = st.state === "done" ? "✓" : st.state === "failed" ? "✕" : "";
        const body = el("div", { class: "ltl-pipe-body" });
        body.appendChild(
          el("div", {
            class: "ltl-pipe-label",
            text: st.state === "failed" ? `${st.label} — failed` : st.label,
          })
        );
        const sub = st.detail || st.hint || "";
        if (sub) {
          body.appendChild(
            el("div", {
              class: st.state === "failed" ? "ltl-pipe-error" : "ltl-pipe-hint",
              text: sub,
            })
          );
        }
        li.appendChild(dot);
        li.appendChild(body);
        if (i < steps.length - 1) li.appendChild(el("span", { class: "ltl-pipe-rail", "aria-hidden": "true" }));
        list.appendChild(li);
      });

      const done = steps.filter((s) => s.state === "done").length;
      const failedIdx = steps.findIndex((s) => s.state === "failed");
      const activeIdx = steps.findIndex((s) => s.state === "active");
      const cur = failedIdx >= 0 ? failedIdx + 1 : activeIdx >= 0 ? activeIdx + 1 : done;
      const pct = steps.length ? Math.round(((failedIdx >= 0 ? failedIdx : done) / steps.length) * 100) : 0;

      const fill = $("#ltl-pipe-fill");
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle("ltl-pipe-fill-failed", failedIdx >= 0);
      }
      const stepno = $("#ltl-pipe-stepno");
      if (stepno) {
        stepno.textContent =
          failedIdx >= 0 ? `failed at step ${failedIdx + 1} of ${steps.length}` : `step ${cur} of ${steps.length}`;
      }
      const t = $("#ltl-pipe-title");
      if (t) t.textContent = failedIdx >= 0 ? "Loading stopped" : title;
      $("#ltl-pipe-card")?.classList.toggle("ltl-pipe-failed", failedIdx >= 0);
      $("#ltl-loading .ltl-pipe-card")?.classList.toggle("ltl-pipe-failed", failedIdx >= 0);
      const foot = $("#ltl-pipe-foot");
      if (foot) foot.style.display = failedIdx >= 0 ? "none" : "";
    }

    function tick() {
      const meta = $("#ltl-pipe-meta");
      if (meta) meta.textContent = `${metaPrefix} · elapsed ${fmtElapsed()}`;
    }
    let metaPrefix = "";

    return {
      /** Start a new load with the given steps. */
      begin(loadTitle, stepDefs, meta = "") {
        title = loadTitle;
        metaPrefix = meta;
        steps = stepDefs.map((s) => ({ ...s, state: "pending", detail: "" }));
        startedAt = Date.now();
        const actions = $("#ltl-pipe-actions");
        if (actions) actions.innerHTML = "";
        render();
        tick();
        clearInterval(timer);
        timer = setInterval(tick, 1000);
      },
      /** Mark a step active, optionally with a live caption. */
      start(key, detail) {
        for (const s of steps) if (s.state === "active") s.state = "done";
        const st = steps.find((s) => s.key === key);
        if (st) {
          st.state = "active";
          if (detail != null) st.detail = detail;
        }
        render();
      },
      /** Update the active step's caption (live counts / paging). */
      note(detail) {
        const st = steps.find((s) => s.state === "active");
        if (st) {
          st.detail = detail;
          render();
        }
      },
      /** Mark a step done with a final summary. */
      done(key, detail) {
        const st = steps.find((s) => s.key === key);
        if (st) {
          st.state = "done";
          if (detail != null) st.detail = detail;
        }
        render();
      },
      /** Mark a step failed in place; show the error + actions; stop the clock. */
      fail(key, message, { services = [], onRetry } = {}) {
        const st = steps.find((s) => s.key === key) || steps.find((s) => s.state === "active");
        if (st) {
          st.state = "failed";
          st.detail = message || "failed";
        }
        clearInterval(timer);
        timer = null;
        tick();
        render();
        const actions = $("#ltl-pipe-actions");
        if (actions) {
          actions.innerHTML = "";
          for (const svc of services) {
            const url = svc === "FMC" ? FMC_TAB_URL : svc === "SMC" ? SMC_TAB_URL : SP_SITE_URL;
            actions.appendChild(
              el("button", {
                type: "button",
                class: "ltl-btn ltl-gray",
                text: `Open ${svc}`,
                onclick: () => window.open(url, "_blank", "noopener"),
              })
            );
          }
          if (typeof onRetry === "function") {
            actions.appendChild(
              el("button", { type: "button", class: "ltl-btn ltl-green", text: "Retry", onclick: () => onRetry() })
            );
          }
          actions.appendChild(
            el("button", { type: "button", class: "ltl-btn ltl-gray", text: "Dismiss", onclick: () => Loader.hide() })
          );
        }
      },
      /** Everything finished — stop the clock (caller hides via setBusy). */
      finish() {
        for (const s of steps) if (s.state === "active") s.state = "done";
        clearInterval(timer);
        timer = null;
        render();
      },
      hide() {
        clearInterval(timer);
        timer = null;
        $("#ltl-loading")?.classList.remove("ltl-show");
        // Reset so the next load (pipeline or ad-hoc) starts from a clean card
        // instead of inheriting this one's finished/failed steps.
        steps = [];
        const list = $("#ltl-pipe-steps");
        if (list) list.innerHTML = "";
        const actions = $("#ltl-pipe-actions");
        if (actions) actions.innerHTML = "";
      },
      show() {
        $("#ltl-loading")?.classList.add("ltl-show");
      },
      isFailed() {
        return steps.some((s) => s.state === "failed");
      },
    };
  })();

  // Simple (non-pipeline) loads — ID lookup, outcome sweep — still call these.
  // They run as a single-step pipeline so the same card is used everywhere.
  let busy = false;
  function setBusy(b) {
    busy = b;
    root.querySelector("#ltl-refresh").disabled = b;
    const apply = root.querySelector("#ltl-apply");
    if (apply) apply.disabled = b;
    if (b) {
      Loader.show();
    } else if (!Loader.isFailed()) {
      // Keep a failed pipeline on screen so the user can read it; a normal
      // finish hides it.
      Loader.hide();
    }
  }

  // Update the active step's caption. If no pipeline is running, start a
  // one-step one so ad-hoc loads (lookup / sweep) get the same card.
  function setLoadingText(text) {
    if (!root) return;
    if (!root.querySelector("#ltl-pipe-steps")?.children.length) {
      Loader.begin("Working…", [{ key: "work", label: text }], "");
      Loader.start("work", "");
      return;
    }
    Loader.note(text);
  }

  // ── build the panel DOM ───────────────────────────────────────────────────
  let root;
  let carrierMs = null; // carrier multi-select controller
  let carrierInit = false; // whether team carrier defaults have been applied yet
  let statusInit = false; // whether the team status default has been applied yet
  const FALLBACK_CARRIER_DEFAULTS = ["RLB1", "AZNG", "DUMMY"];
  function carrierDefaults() {
    return (teamCfg && teamCfg.carrierDefaults) || FALLBACK_CARRIER_DEFAULTS;
  }
  function buildUI() {
    // Standalone page (ui/app.html): the panel IS the page — no floating
    // toggle, no close button, always open.
    root = el("div", { id: "ltl-overlay", class: "ltl-open ltl-page" });
    root.innerHTML = `
      <div class="ltl-header">
        <button id="ltl-team-badge" class="ltl-team-badge" title="Switch team">Choose team ▾</button>
        <div class="ltl-tabs">
          <button id="ltl-tab-sourcing" class="ltl-tab ltl-tab-active">Manual Sourcing</button>
          <button id="ltl-tab-dashboard" class="ltl-tab">Dashboard</button>
        </div>
        <span class="ltl-spacer"></span>
        <div class="ltl-theme" role="group" aria-label="Colour theme" title="Theme">
          <button type="button" data-mode="light" aria-pressed="false" title="Light">☀ Light</button>
          <button type="button" data-mode="dark" aria-pressed="false" title="Dark">☾ Dark</button>
          <button type="button" data-mode="system" aria-pressed="false" title="Follow the system setting">System</button>
        </div>
        <span class="ltl-brand" title="Manual Sourcing Viewer">MS Viewer</span>
      </div>
      <div id="ltl-toolbar" class="ltl-toolbar">
        <input type="search" id="ltl-search" placeholder="Search (comma = VRID/order exact)" />
        <input type="date" id="ltl-start" title="Start date" />
        <input type="date" id="ltl-end" title="End date" />
        <select id="ltl-country"><option value="">All Countries</option></select>
        <select id="ltl-status"><option value="">All Statuses</option></select>
        <select id="ltl-shipper"><option value="">All Shippers</option></select>
        <select id="ltl-group" style="display:none"><option value="">All Groups</option></select>
        <span id="ltl-carrier-mount"></span>
        <select id="ltl-f-ms" title="Manual sourced">
          <option value="">MS: Any</option>
          <option value="yes">MS: Yes</option>
          <option value="no">MS: No</option>
        </select>
        <select id="ltl-f-gen" title="Email generated">
          <option value="">Generated: Any</option>
          <option value="yes">Generated: Yes</option>
          <option value="no">Generated: No</option>
        </select>
        <select id="ltl-f-sent" title="Email sent">
          <option value="">Sent: Any</option>
          <option value="yes">Sent: Yes</option>
          <option value="no">Sent: No</option>
        </select>
        <button id="ltl-apply" class="ltl-btn">Apply</button>
        <button id="ltl-clear" class="ltl-btn ltl-gray">Clear</button>
        <span class="ltl-spacer"></span>
        <button id="ltl-covered" class="ltl-btn ltl-gray">Recently covered (0)</button>
        <button id="ltl-shippers" class="ltl-btn ltl-gray" style="display:none">Shippers · Import</button>
        <input type="file" id="ltl-shippers-file" accept=".csv,text/csv" style="display:none" />
        <button id="ltl-eml" class="ltl-btn ltl-green">Send Selected via EML (<span id="ltl-eml-count">0</span>)</button>
        <button id="ltl-marksent" class="ltl-btn">Mark Selected Sent</button>
        <button id="ltl-csv" class="ltl-btn ltl-gray">Download CSV</button>
      </div>
      <div id="ltl-lookup-bar" class="ltl-lookup-bar" style="display:none"></div>
      <div class="ltl-body">
        <div id="ltl-team-view" class="ltl-team-view" style="display:none"></div>
        <table class="ltl-grid">
          <thead><tr id="ltl-thead"></tr></thead>
          <tbody id="ltl-tbody"></tbody>
        </table>
        <div id="ltl-empty" class="ltl-empty" style="display:none">No data found</div>
        <div id="ltl-dash-view" style="display:none"></div>
      </div>
      <div id="ltl-loading" class="ltl-loading" role="status" aria-live="polite">
        <div class="ltl-pipe-card">
          <div class="ltl-pipe-head">
            <div id="ltl-pipe-title" class="ltl-pipe-title">Loading…</div>
            <div id="ltl-pipe-meta" class="ltl-pipe-meta"></div>
          </div>
          <div class="ltl-pipe-bar"><div id="ltl-pipe-fill" class="ltl-pipe-fill"></div></div>
          <div id="ltl-pipe-stepno" class="ltl-pipe-stepno"></div>
          <ol id="ltl-pipe-steps" class="ltl-pipe-steps"></ol>
          <div id="ltl-pipe-foot" class="ltl-pipe-foot">Table appears once every step is complete.</div>
          <div id="ltl-pipe-actions" class="ltl-pipe-actions"></div>
        </div>
      </div>
      <div id="ltl-footer" class="ltl-footer">
        <span id="ltl-count">0 rows</span>
        <span id="ltl-window"></span>
        <span id="ltl-updated"></span>
        <span class="ltl-spacer" style="flex:1"></span>
        <select id="ltl-auto" class="ltl-auto" title="Automatically re-pull the sourcing list from SMC">
          <option value="0">Auto-refresh: off</option>
          <option value="5">Auto-refresh: 5 min</option>
          <option value="10">Auto-refresh: 10 min</option>
          <option value="15">Auto-refresh: 15 min</option>
          <option value="20">Auto-refresh: 20 min</option>
          <option value="30">Auto-refresh: 30 min</option>
          <option value="60">Auto-refresh: 60 min</option>
        </select>
        <span id="ltl-auto-next" class="ltl-auto-next"></span>
        <button id="ltl-refresh" class="ltl-btn ltl-gray">Refresh</button>
      </div>
    `;
    document.body.appendChild(root);

    // Default window: today 00:00 → tomorrow 00:05 (narrow = fast load).
    root.querySelector("#ltl-start").value = todayIso();
    root.querySelector("#ltl-end").value = tomorrowIso();

    // Mount the tag-style carrier multi-select. Filtering is local, so re-render
    // on change (no SMC re-fetch).
    carrierMs = createMultiSelect({
      placeholder: "Vehicle carrier…",
      onChange: () => applySearchAndRender(),
    });
    root.querySelector("#ltl-carrier-mount").appendChild(carrierMs.root);

    // wire controls. Dates drive the SMC query window; changing a date
    // auto-fetches. country/status/shipper + search filter locally.
    root.querySelectorAll(".ltl-theme button").forEach((b) =>
      b.addEventListener("click", () => setTheme(b.dataset.mode))
    );
    applyTheme();
    root.querySelector("#ltl-auto").addEventListener("change", (e) => setAuto(e.target.value));
    root.querySelector("#ltl-apply").addEventListener("click", fetchData);
    root.querySelector("#ltl-clear").addEventListener("click", () => {
      ["ltl-search", "ltl-country", "ltl-status", "ltl-shipper", "ltl-group", "ltl-f-ms", "ltl-f-gen", "ltl-f-sent"].forEach((id) => {
        const n = root.querySelector(`#${id}`);
        if (n) n.value = "";
      });
      // Reset the carrier multi-select + status back to the team defaults.
      if (carrierMs) carrierMs.setSelected(carrierDefaults());
      statusInit = false; // populateFilters() re-applies the team status default
      // Reset dates back to the default window (today → tomorrow), not empty.
      root.querySelector("#ltl-start").value = todayIso();
      root.querySelector("#ltl-end").value = tomorrowIso();
      state.search = "";
      fetchData();
    });
    // Changing either date re-fetches from SMC with the new window.
    root.querySelector("#ltl-start").addEventListener("change", fetchData);
    root.querySelector("#ltl-end").addEventListener("change", fetchData);
    // (Carrier multi-select re-renders locally via its own onChange callback.)
    // Status flag filters + shipper group re-render locally on change.
    ["ltl-f-ms", "ltl-f-gen", "ltl-f-sent", "ltl-group"].forEach((id) => {
      root.querySelector(`#${id}`)?.addEventListener("change", applySearchAndRender);
    });
    root.querySelector("#ltl-refresh").addEventListener("click", fetchData);
    root.querySelector("#ltl-shippers").addEventListener("click", onShippersClick);
    root.querySelector("#ltl-covered").addEventListener("click", () =>
      setViewMode(viewMode === "covered" ? "sourcing" : "covered")
    );
    root.querySelector("#ltl-team-badge").addEventListener("click", showTeamPicker);
    root.querySelector("#ltl-eml").addEventListener("click", onSendEml);
    root.querySelector("#ltl-marksent").addEventListener("click", onMarkSent);
    root.querySelector("#ltl-csv").addEventListener("click", onDownloadCsv);
    root.querySelector("#ltl-tab-sourcing").addEventListener("click", () => setTab("sourcing"));
    root.querySelector("#ltl-tab-dashboard").addEventListener("click", () => setTab("dashboard"));

    let searchTimer;
    root.querySelector("#ltl-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value;
        // Clearing the search while viewing SMC lookup results goes back.
        if (viewMode === "lookup" && !state.search.trim()) {
          setViewMode("sourcing");
          return;
        }
        applySearchAndRender();
      }, 300);
    });
    // Enter in the search box: if the IDs aren't on the list, look them up now.
    root.querySelector("#ltl-search").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      clearTimeout(searchTimer);
      state.search = e.target.value;
      if (viewMode === "sourcing") {
        const missing = unmatchedIds(state.rows);
        if (missing.length) {
          lookupInSmc(missing);
          return;
        }
      }
      applySearchAndRender();
    });
  }

  // ── tab switching (Manual Sourcing | Dashboard) ─────────────────────────────
  let currentTab = "sourcing";

  function setTab(tab) {
    if (!teamCfg) {
      showTeamPicker();
      return;
    }
    currentTab = tab;
    const isDash = tab === "dashboard";
    root.querySelector("#ltl-team-view").style.display = "none";
    root.querySelector(".ltl-tabs").style.display = "";
    root.querySelector("#ltl-tab-sourcing").classList.toggle("ltl-tab-active", !isDash);
    root.querySelector("#ltl-tab-dashboard").classList.toggle("ltl-tab-active", isDash);
    // Toolbar/footer + table belong to sourcing; hide on dashboard.
    root.querySelector("#ltl-toolbar").style.display = isDash ? "none" : "";
    if (isDash) root.querySelector("#ltl-lookup-bar").style.display = "none";
    root.querySelector("#ltl-footer").style.display = isDash ? "none" : "";
    root.querySelector(".ltl-grid").style.display = isDash ? "none" : "";
    root.querySelector("#ltl-empty").style.display = "none";
    root.querySelector("#ltl-dash-view").style.display = isDash ? "block" : "none";
    if (isDash) loadDashboard();
    else applySearchAndRender(); // restore the table view
  }

  async function loadDashboard({ sweep = true } = {}) {
    const view = root.querySelector("#ltl-dash-view");
    try {
      setBusy(true);
      // Dashboard reads SharePoint records; block + prompt if the session is out.
      if (!(await ensureSessions(["SharePoint"], loadDashboard))) return;
      if (!window.__ltlDashboard) {
        throw new Error("dashboard module not loaded — reload the extension (about:debugging → Reload)");
      }
      // Refresh outcomes first so "covered" reflects FMC right now (forced:
      // the user explicitly asked for the dashboard / hit Refresh). Skipped
      // for the quick re-render after a Manual Source tick.
      if (sweep) {
        setLoadingText("Checking outcomes on FMC…");
        await sweepOutcomes({ force: true });
      }
      setLoadingText("Loading SharePoint records…");
      const records = await msg("getRecords");
      state.covered = coveredRowsFrom(records);
      updateCoveredButton();
      window.__ltlDashboard.render(view, records, {
        onRefresh: () => loadDashboard(),
        // Manual Source tick from the Runs tab: same prompt flow as the table,
        // then re-render from fresh records (no FMC sweep needed).
        onManualSourceToggle: async (e, rec) => {
          await onManualSourceToggle(e, rec);
          await loadDashboard({ sweep: false });
        },
        team: teamCfg,
        // Live section: the rows currently loaded in Manual Sourcing (this
        // team's SMC window, FMC-enriched), so the dashboard can break down
        // status / country / shipper group without any extra storage.
        liveRows: state.rows,
      });
    } catch (e) {
      view.innerHTML = "";
      view.appendChild(el("div", { class: "ltl-dash-empty", text: `Failed to load dashboard: ${e.message}` }));
    } finally {
      setBusy(false);
    }
  }

  // ── team picker (the panel's landing page) ──────────────────────────────────
  // Shown on first open (per page load) and whenever the header badge is
  // clicked. Picking a team resets the per-team UI state and loads its data.
  async function showTeamPicker() {
    const view = root.querySelector("#ltl-team-view");
    // Hide everything else.
    root.querySelector("#ltl-toolbar").style.display = "none";
    root.querySelector("#ltl-lookup-bar").style.display = "none";
    root.querySelector("#ltl-footer").style.display = "none";
    root.querySelector(".ltl-grid").style.display = "none";
    root.querySelector("#ltl-empty").style.display = "none";
    root.querySelector("#ltl-dash-view").style.display = "none";
    root.querySelector(".ltl-tabs").style.display = "none";
    view.style.display = "block";
    view.innerHTML = "";
    view.appendChild(el("div", { class: "ltl-team-title", text: "Which team are you working for?" }));

    let data;
    try {
      data = await ensureTeams();
    } catch (e) {
      view.appendChild(
        el("div", { class: "ltl-dash-empty", text: `Couldn't load teams from the extension: ${e.message}` })
      );
      return;
    }
    const last = await loadLastTeam();
    const grid = el("div", { class: "ltl-team-grid" });
    for (const cfg of Object.values(data.teams)) {
      const card = el("button", {
        class: "ltl-team-card" + (teamCfg && teamCfg.key === cfg.key ? " ltl-team-current" : ""),
        type: "button",
        onclick: () => selectTeam(cfg.key),
      });
      card.appendChild(el("div", { class: "ltl-team-key", text: cfg.label }));
      card.appendChild(el("div", { class: "ltl-team-desc", text: cfg.description || "" }));
      const meta = [];
      meta.push(`Records: ${cfg.spList}`);
      if (cfg.shipperList) meta.push(`Shippers: ${cfg.shipperList}`);
      card.appendChild(el("div", { class: "ltl-team-meta", text: meta.join(" · ") }));
      if (last === cfg.key) card.appendChild(el("span", { class: "ltl-team-last", text: "Last used" }));
      grid.appendChild(card);
    }
    view.appendChild(grid);
  }

  async function selectTeam(key) {
    const data = await ensureTeams();
    const cfg = data.teams[key];
    if (!cfg) {
      toast(`Unknown team: ${key}`, "error");
      return;
    }
    const changed = !teamCfg || teamCfg.key !== cfg.key;
    teamCfg = cfg;
    saveLastTeam(cfg.key);

    root.querySelector("#ltl-team-badge").textContent = `Team: ${cfg.label} ▾`;
    document.title = `MS Viewer · ${cfg.label}`;

    if (changed) {
      // Per-team state: rows, shipper map, filter defaults, selection.
      state.rows = [];
      state.filtered = [];
      state.search = "";
      shipperMap = null;
      shipperInfo = null;
      carrierInit = false;
      statusInit = false;
      clearEmptyNotice();
      const search = root.querySelector("#ltl-search");
      if (search) search.value = "";
      ["ltl-country", "ltl-status", "ltl-shipper", "ltl-group"].forEach((id) => {
        const n = root.querySelector(`#${id}`);
        if (n) n.value = "";
      });
      root.querySelector("#ltl-tbody").innerHTML = "";
      root.querySelector("#ltl-dash-view").innerHTML = "";
    }
    updateShippersButton();

    // Land on Manual Sourcing and load the team's data.
    currentTab = "sourcing";
    setTab("sourcing");
    await fetchData();
  }

  // Page load: build the UI, then land on the team picker. If a team was used
  // before, it's highlighted as "Last used"; picking one loads its data.
  async function openPanel() {
    ensureUser(); // fire-and-forget; needed for manual_source_by / email_sent_by
    await showTeamPicker();
  }

  // ── auto-refresh ──────────────────────────────────────────────────────────
  // Re-pulls the sourcing list on a timer so the board doesn't go stale.
  // Interval is user-editable in the footer (off / 5–60 min, default 20) and
  // saved in browser.storage. It only ever fires on the Manual Sourcing tab in
  // the normal sourcing view, and never mid-action: a load in progress, a
  // session blocker, selected rows (pending EML), the Recently-covered / SMC
  // lookup views, the Dashboard, or a hidden tab all defer it to the next tick.
  const AUTO_KEY = "ltl.autoRefreshMin";
  const AUTO_DEFAULT_MIN = 20;
  const AUTO_TICK_MS = 5_000;
  let autoMin = AUTO_DEFAULT_MIN;
  let nextAutoAt = 0;

  function autoReset() {
    nextAutoAt = autoMin > 0 ? Date.now() + autoMin * 60_000 : 0;
    renderAutoStatus();
  }

  function autoEligible() {
    return (
      autoMin > 0 &&
      !!teamCfg &&
      currentTab === "sourcing" &&
      viewMode === "sourcing" &&
      !busy &&
      !document.hidden &&
      !root.querySelector("#ltl-blocker") &&
      !root.querySelector("#ltl-tbody .ltl-row-select:checked")
    );
  }

  function renderAutoStatus() {
    const n = root?.querySelector("#ltl-auto-next");
    if (!n) return;
    if (!autoMin || !nextAutoAt) {
      n.textContent = "";
      return;
    }
    const ms = nextAutoAt - Date.now();
    n.textContent = ms <= 0 ? "refreshing…" : `next in ${Math.max(1, Math.ceil(ms / 60_000))}m`;
  }

  function autoTick() {
    if (!autoMin) return;
    renderAutoStatus();
    if (!nextAutoAt || Date.now() < nextAutoAt) return;
    if (!autoEligible()) return; // deferred — re-checked on the next tick
    dlog(`auto-refresh firing (every ${autoMin}m)`);
    fetchData(); // resets the timer when it finishes
  }

  function setAuto(min) {
    autoMin = Number(min) || 0;
    browser.storage.local.set({ [AUTO_KEY]: autoMin }).catch(() => {});
    const sel = root?.querySelector("#ltl-auto");
    if (sel) sel.value = String(autoMin);
    autoReset();
  }

  async function loadAuto() {
    try {
      const got = await browser.storage.local.get(AUTO_KEY);
      const v = got && got[AUTO_KEY];
      if (v != null) autoMin = Number(v) || 0;
    } catch {
      /* default: 20 min */
    }
    const sel = root?.querySelector("#ltl-auto");
    if (sel) sel.value = String(autoMin);
    autoReset();
  }

  // ── theme: light | dark | system ─────────────────────────────────────────
  // Resolved to data-theme="light|dark" on <html>; overlay.css has the dark
  // overrides. "system" follows prefers-color-scheme and tracks changes live.
  const THEME_KEY = "ltl.theme";
  let themeMode = "system";
  const darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applyTheme() {
    const dark = themeMode === "dark" || (themeMode === "system" && !!(darkMq && darkMq.matches));
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    root?.querySelectorAll(".ltl-theme button").forEach((b) => {
      const on = b.dataset.mode === themeMode;
      b.classList.toggle("ltl-theme-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function setTheme(mode) {
    themeMode = ["light", "dark", "system"].includes(mode) ? mode : "system";
    browser.storage.local.set({ [THEME_KEY]: themeMode }).catch(() => {});
    applyTheme();
  }
  async function loadTheme() {
    try {
      const got = await browser.storage.local.get(THEME_KEY);
      if (got && got[THEME_KEY]) themeMode = String(got[THEME_KEY]);
    } catch {
      /* default: system */
    }
    applyTheme();
  }
  if (darkMq) {
    darkMq.addEventListener("change", () => {
      if (themeMode === "system") applyTheme();
    });
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function start() {
    applyTheme(); // system default straight away (avoids a light flash)
    buildUI();
    loadTheme(); // then the saved preference
    loadAuto();
    setInterval(autoTick, AUTO_TICK_MS);
    // Coming back to the tab: if a refresh fell due while it was hidden, run it now.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) autoTick();
    });
    openPanel();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
