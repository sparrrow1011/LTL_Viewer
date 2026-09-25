/**
 * Paragon bridge — a content script injected into paragon-eu.amazon.com.
 *
 * WHY: the extension UI/background can't call Paragon with the user's Midway
 * session cross-origin, so this runs ON the Paragon page and fetches
 * same-origin (credentials:"include") — the same trick MS Viewer uses for
 * FMC/SharePoint.
 *
 * Ports the direct-API helpers of CST_viewer scrapers/paragon.py:
 *   _get_csrf_token   → pgn_csrf_token cookie (document.cookie, or supplied by
 *                       the background via browser.cookies when HttpOnly)
 *   _search_api_page  → POST /hz/api/search, CASE contentType, 100/page
 *   _fetch_all_pages  → paginate until totalCount
 *   _fetch_batch      → split a batch in half + retry when the API 400s
 *   _case_to_row      → 14 KEEP_COLS + raw epoch-ms timestamps
 *
 * Message contract (from background):
 *   { action:"paragon:ping",   csrf? }                       -> { bridge, ok, status }
 *   { action:"paragon:query",  query, csrf? }                -> { bridge, ok, rows }
 *   { action:"paragon:sweep",  queries:string[], batchSize, csrf? }
 *                                                            -> { bridge, ok, rows, failedBatches }
 */
(function () {
  "use strict";

  // No "already injected" guard on purpose. After an extension reload the
  // previous copy of this script is still in the page but orphaned (its
  // browser.runtime is dead), so a window flag would make the background's
  // re-injection a silent no-op → "Receiving end does not exist". The
  // background only injects when messaging failed, so duplicates don't occur.

  const ORIGIN = "https://paragon-eu.amazon.com";
  const API_SEARCH_URL = `${ORIGIN}/hz/api/search`;
  const CSRF_COOKIE = "pgn_csrf_token";
  const CASE_PAGE_SIZE = 100;
  const DEFAULT_BATCH_SIZE = 30;
  const MAX_SPLIT_DEPTH = 4;

  // Every dlog line also lands in `trace`, which is returned with each reply so
  // the background can relay it into the page's Log tab.
  let trace = [];
  const dlog = (...a) => {
    const line = a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
    trace.push(line);
    console.debug("[LobbySweeper paragon]", ...a);
  };

  // ── session / csrf ─────────────────────────────────────────────────────────

  function cookieCsrf() {
    const hit = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${CSRF_COOKIE}=`));
    return hit ? decodeURIComponent(hit.slice(CSRF_COOKIE.length + 1)) : null;
  }

  // Prefer the token the background read via browser.cookies (works even when
  // the cookie is HttpOnly); fall back to document.cookie.
  function resolveCsrf(supplied) {
    return supplied || cookieCsrf() || null;
  }

  /**
   * Expired Midway sessions don't come back as 401 — Paragon redirects to the
   * sign-in page and fetch follows it, yielding an HTML 200. Only a JSON reply
   * that stayed on the Paragon origin counts as authenticated.
   */
  function assertApiResponse(res) {
    const onOrigin = !res.url || res.url.startsWith(ORIGIN);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const expired = (why, status = 401) => {
      const err = new Error(`Paragon session expired — ${why}`);
      err.status = status;
      err.expired = true;
      return err;
    };
    if (res.redirected && !onOrigin) throw expired(`redirected to ${res.url}`);
    if (res.status === 401 || res.status === 403) throw expired(`HTTP ${res.status}`, res.status);
    if (res.status === 200 && !ctype.includes("json")) {
      throw expired(`non-JSON reply (${ctype || "no content-type"})`);
    }
  }

  // ── API ────────────────────────────────────────────────────────────────────

  async function searchPage(query, pageNum, csrf) {
    const payload = {
      typeAhead: false,
      query,
      contentTypes: [
        {
          contentType: "CASE",
          pageSize: CASE_PAGE_SIZE,
          pageNum,
          sortOrder: "desc",
          sortField: "creationDate",
        },
      ],
      searchAllTenants: false,
    };
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
    };
    if (csrf) headers["pgn-csrf-token"] = csrf;

    dlog(`POST /hz/api/search page ${pageNum} (query len ${query.length}, csrf ${csrf ? "yes" : "NO"})`);
    const res = await fetch(API_SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload),
    });
    dlog(
      `← HTTP ${res.status} ${res.redirected ? `(redirected to ${res.url}) ` : ""}content-type=${
        res.headers.get("content-type") || "none"
      }`
    );
    assertApiResponse(res);
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      dlog(`body: ${snippet}`);
      const err = new Error(`HTTP ${res.status}: ${snippet}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    const block =
      (body && body.payload && body.payload.resultsByContentType && body.payload.resultsByContentType.CASE) ||
      null;
    if (!block) {
      dlog(`unexpected body shape: ${JSON.stringify(body).slice(0, 300)}`);
      return { results: [], totalCount: 0 };
    }
    const results = block.results || [];
    const totalCount = block.totalCount != null ? block.totalCount : results.length;
    dlog(`page ${pageNum}: ${results.length} results, totalCount ${totalCount}`);
    return { results, totalCount };
  }

  const epochToStr = (ms) => {
    if (ms == null || ms === "") return "";
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}:${p(d.getSeconds())}`;
  };
  const epochOrNull = (ms) => {
    if (ms == null || ms === "") return null;
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // paragon.py html.unescape(subject) — subjects come back entity-encoded.
  function unescapeHtml(s) {
    if (!s) return "";
    try {
      return new DOMParser().parseFromString(String(s), "text/html").documentElement.textContent || "";
    } catch (_) {
      return String(s);
    }
  }

  // paragon.py _case_to_row (+ raw epoch fields for the SLA math).
  function caseToRow(c) {
    const doc = (c && c.document) || {};
    return {
      ID: doc.caseId || "",
      Subject: unescapeHtml(doc.subject || ""),
      Partner: doc.platform || "",
      "Merchant ID": doc.merchantId || "",
      Owner: doc.owner || "",
      Severity: doc.severity ?? "",
      Status: doc.status || "",
      "Creation Date": epochToStr(doc.creationDate),
      "Last Inbound Date": epochToStr(doc.lastInboundDate),
      "Last Outbound Date": epochToStr(doc.lastOutboundDate),
      Queue: doc.queue || "",
      "Status SLA": epochToStr(doc.statusSlaExpirationDate),
      "Outbound SLA": epochToStr(doc.nextResponseExpirationDate),
      "Oldest Active Follow-up Date": epochToStr(doc.oldestActiveFollowUpDueDate),
      _creationMs: epochOrNull(doc.creationDate),
      _lastInboundMs: epochOrNull(doc.lastInboundDate),
      _lastOutboundMs: epochOrNull(doc.lastOutboundDate),
    };
  }

  async function fetchAllPages(query, csrf) {
    const rows = [];
    let pageNum = 1;
    for (;;) {
      const { results, totalCount } = await searchPage(query, pageNum, csrf);
      rows.push(...results.map(caseToRow));
      if (rows.length >= totalCount || !results.length) break;
      pageNum += 1;
    }
    return rows;
  }

  // paragon.py _fetch_batch: split in half on failure, up to MAX_SPLIT_DEPTH.
  async function fetchBatch(batch, csrf, depth = 0) {
    try {
      return { rows: await fetchAllPages(batch.join(" "), csrf), ok: true };
    } catch (e) {
      if (e && e.expired) throw e; // never mask an expired session as a bad batch
      if (batch.length <= 1 || depth >= MAX_SPLIT_DEPTH) {
        console.warn(`[LobbySweeper paragon] giving up on ${batch.length} pair(s):`, e.message);
        return { rows: [], ok: false };
      }
      const mid = Math.floor(batch.length / 2);
      dlog(`batch of ${batch.length} failed (${e.message}); splitting ${mid} + ${batch.length - mid}`);
      const left = await fetchBatch(batch.slice(0, mid), csrf, depth + 1);
      const right = await fetchBatch(batch.slice(mid), csrf, depth + 1);
      return { rows: left.rows.concat(right.rows), ok: left.ok && right.ok };
    }
  }

  // paragon.py run_search_batches: batch, fetch, dedupe by case ID.
  async function sweep(queries, batchSize, csrf) {
    const clean = [...new Set((queries || []).map((q) => String(q).trim()).filter(Boolean))];
    const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
    const seen = new Set();
    const rows = [];
    const failedBatches = [];
    const total = Math.ceil(clean.length / size);
    for (let i = 0; i < clean.length; i += size) {
      const n = i / size + 1;
      const batch = clean.slice(i, i + size);
      const { rows: batchRows, ok } = await fetchBatch(batch, csrf);
      if (!ok) failedBatches.push(n);
      let fresh = 0;
      for (const r of batchRows) {
        if (r.ID && seen.has(r.ID)) continue;
        seen.add(r.ID);
        rows.push(r);
        fresh += 1;
      }
      dlog(`batch ${n}/${total}: ${batchRows.length} cases (${fresh} new)`);
    }
    return { rows, failedBatches, batches: total };
  }

  // Cheap authenticated probe: 1-result search for a nonsense term. Any JSON
  // 200 that stayed on the Paragon origin = live session.
  async function ping(csrf) {
    const res = await fetch(API_SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        ...(csrf ? { "pgn-csrf-token": csrf } : {}),
      },
      body: JSON.stringify({
        typeAhead: false,
        query: '"__lobby_sweeper_ping__"',
        contentTypes: [{ contentType: "CASE", pageSize: 1, pageNum: 1, sortOrder: "desc", sortField: "creationDate" }],
        searchAllTenants: false,
      }),
    });
    assertApiResponse(res);
    return res.status;
  }

  // ── message handling ───────────────────────────────────────────────────────

  const takeTrace = () => {
    const t = trace;
    trace = [];
    return t;
  };
  const ok = (extra) => ({ bridge: true, ok: true, trace: takeTrace(), ...extra });
  const fail = (err) => {
    dlog(`FAILED: ${err && err.message ? err.message : err}`);
    return {
      bridge: true,
      ok: false,
      status: (err && err.status) || 0,
      expired: !!(err && err.expired),
      error: String(err && err.message ? err.message : err),
      trace: takeTrace(),
    };
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.action !== "string" || !msg.action.startsWith("paragon:")) return;
    trace = [];
    const csrf = resolveCsrf(msg.csrf);
    dlog(
      `${msg.action} on ${location.href} — csrf: ${
        msg.csrf ? "from background (cookies API)" : csrf ? "from document.cookie" : "NONE (cookie HttpOnly or not set)"
      }`
    );

    if (msg.action === "paragon:ping") {
      return ping(csrf)
        .then((status) =>
          status === 200 ? ok({ status, hasCsrf: !!csrf }) : fail(Object.assign(new Error(`ping HTTP ${status}`), { status }))
        )
        .catch(fail);
    }
    if (msg.action === "paragon:query") {
      dlog(`lobby query: ${String(msg.query || "").slice(0, 200)}…`);
      return fetchAllPages(String(msg.query || ""), csrf)
        .then((rows) => ok({ rows }))
        .catch(fail);
    }
    // One page of one query (the background paginates, so each round-trip is
    // a single HTTP call — keeps the MV3 event page alive).
    if (msg.action === "paragon:page") {
      return searchPage(String(msg.query || ""), Number(msg.pageNum) || 1, csrf)
        .then(({ results, totalCount }) => ok({ rows: results.map(caseToRow), totalCount }))
        .catch(fail);
    }
    // One batch of id terms, with the split-on-400 retry. Same reason.
    if (msg.action === "paragon:batch") {
      const batch = (msg.terms || []).map((q) => String(q).trim()).filter(Boolean);
      dlog(`batch of ${batch.length} terms`);
      return fetchBatch(batch, csrf)
        .then((r) => ok({ rows: r.rows, batchOk: r.ok }))
        .catch(fail);
    }
    if (msg.action === "paragon:sweep") {
      dlog(`sweep: ${(msg.queries || []).length} pair terms, batch size ${msg.batchSize}`);
      return sweep(msg.queries, msg.batchSize, csrf)
        .then((r) => ok(r))
        .catch(fail);
    }
    return fail(new Error(`Unknown paragon action: ${msg.action}`));
  });

  browser.runtime.sendMessage({ action: "paragon:bridge-ready", href: location.href }).catch(() => {});
  console.info("[LobbySweeper] Paragon bridge ready on", location.origin);
})();
