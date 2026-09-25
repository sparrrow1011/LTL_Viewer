/**
 * FMC bridge — a content script injected into the FMC origin
 * (trans-logistics-eu.amazon.com).
 *
 * WHY: FMC is a different origin from the SMC overlay page, so the overlay
 * can't call FMC directly (cross-origin + FMC's own session/CSRF). Like the
 * SharePoint bridge, this runs ON the FMC page and fetches same-origin.
 *
 * Ports scrapers/fmc_api.py (read path): POST /fmc/search/execution/by-id with
 * { searchByIds:true, searchIds:[...], pageSize } in batches of ≤50, reads
 * `returnedObject.records`, and returns a { vrid: executionStatus } map.
 *
 * Message contract (from background):
 *   { action: "fmc:req", vrids: string[] }  ->  { bridge:true, ok, statuses, error }
 */
(function () {
  "use strict";

  const FMC_ORIGIN = "https://trans-logistics-eu.amazon.com";
  // By-ID lookups. This endpoint REQUIRES searchIds ("searchIds must not be
  // null or empty") — it cannot run a criteria search.
  const API_URL = `${FMC_ORIGIN}/fmc/search/execution/by-id`;
  // Criteria (filter) search — what the FMC UI posts when searchByIds:false.
  // Candidate URLs in order; the first that doesn't reject the payload for
  // lacking searchIds is remembered for the rest of the session.
  const CRITERIA_URL_CANDIDATES = [
    `${FMC_ORIGIN}/fmc/search/execution`,
    `${FMC_ORIGIN}/fmc/search/execution/by-criteria`,
    `${FMC_ORIGIN}/fmc/search/execution/search`,
  ];
  let _criteriaUrl = null; // resolved on first successful criteria call
  const BATCH_SIZE = 50;

  /**
   * Session-expiry detection.
   *
   * When the Midway session is gone, FMC does NOT return 401/403 — it
   * REDIRECTS to the Midway sign-in page. `fetch` follows that redirect, so we
   * end up with an HTTP 200 whose body is the login HTML. Checking only
   * `status === 200` therefore reports "authenticated" when it isn't.
   *
   * A real authenticated API reply must (a) still be on the FMC origin (not
   * redirected to Midway) and (b) be JSON. Anything else is treated as an
   * expired session and surfaced as an error carrying `.expired = true` so the
   * pre-flight can block the load and show the sign-in blocker.
   */
  // Markers that positively identify an Amazon sign-in page in an HTML body.
  // We look for these rather than trusting "it's HTML": FMC also serves HTML
  // for a 404/405/500 on an unknown path, and treating that as "expired" sent
  // users to log in while their session was perfectly fine.
  const LOGIN_MARKERS = /midway|sign[\s-]?in|log[\s-]?in|authenticat|sentry|<title>[^<]*(?:login|sign in)/i;

  /**
   * Is this response positively a sign-in page? Async because deciding for an
   * on-origin HTML reply means reading the body.
   *   - redirected OFF the FMC origin (Midway lives on midway-auth.amazon.com) → yes
   *   - on-origin HTML with status 200 AND login markers in the body       → yes
   *   - anything else (JSON/JS of any status, or non-200 HTML like a 404
   *     page for a wrong URL)                                              → no
   */
  async function looksLikeLoginPage(res) {
    const onOrigin = !res.url || res.url.startsWith(FMC_ORIGIN);
    if (res.redirected && !onOrigin) return true;
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("text/html")) return false;
    // A login page is served as a successful document. An HTML 404/405/500 is
    // an ordinary error page (typically: we hit a path that doesn't exist).
    if (res.status !== 200) return false;
    const text = await res.clone().text().catch(() => "");
    return LOGIN_MARKERS.test(text.slice(0, 20_000));
  }

  async function assertApiResponse(res) {
    if (await looksLikeLoginPage(res)) {
      const err = new Error(
        `FMC session expired — ${res.redirected ? `redirected to ${res.url}` : "got a sign-in page"}`
      );
      err.status = 401;
      err.expired = true;
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`FMC session expired — HTTP ${res.status}`);
      err.status = res.status;
      err.expired = true;
      throw err;
    }
    // Any other status/content-type (400 for a bad id, text/javascript JSON,
    // an HTML 404 for a wrong path, etc.) is an authenticated reply — the
    // caller judges the status.
  }

  // Best-effort CSRF capture from the live FMC page. The token is sent as the
  // `anti-csrftoken-a2z` request header by the UI; Amazon apps typically also
  // surface it somewhere readable — a meta tag, a hidden input, or a global.
  // We check the common spots. (If none is found, see captureCsrfLive below.)
  function captureCsrf() {
    // 1. meta tags
    const meta = document.querySelector(
      'meta[name="anti-csrftoken-a2z"], meta[name="csrf-token"], meta[name="x-csrf-token"]'
    );
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");

    // 2. hidden input
    const input = document.querySelector(
      'input[name="anti-csrftoken-a2z"], input[name="csrfToken"], input[name="csrf-token"]'
    );
    if (input && input.value) return input.value;

    // 3. common globals some Amazon apps expose
    for (const key of ["antiCsrfToken", "csrfToken", "CSRF_TOKEN", "anti_csrftoken_a2z"]) {
      try {
        if (window[key]) return String(window[key]);
      } catch (_) {
        /* ignore */
      }
    }

    // 4. scan inline scripts for an anti-csrftoken-a2z assignment
    try {
      for (const s of document.scripts) {
        const m =
          s.textContent &&
          s.textContent.match(/anti-?csrftoken-?a2z["'\s:=]+([A-Za-z0-9+/=]{20,})/i);
        if (m) return m[1];
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function buildPayload(vrids) {
    const pageSize = Math.max(BATCH_SIZE, vrids.length);
    // Mirrors the live UI request shape (see captured POST). sortOrder/
    // dashboardPreferences are optional server-side; searchIds + searchByIds +
    // pageSize + originalCriteria are the load-bearing fields.
    return {
      searchIds: vrids,
      searchByIds: true,
      page: 0,
      pageSize,
      bookmarkedSavedSearch: false,
      executionViewModePreference: "vrs",
      originalCriteria: JSON.stringify({ searchIds: vrids, pageSize }),
    };
  }

  async function postBatch(vrids, csrf) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
    };
    if (csrf) {
      headers["anti-csrftoken-a2z"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    const res = await fetch(API_URL, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(buildPayload(vrids)),
    });
    // Detect an expired session (redirect-to-Midway / HTML 200) BEFORE trusting
    // the status code — see assertApiResponse.
    await assertApiResponse(res);
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      const err = new Error(`FMC by-id HTTP ${res.status} — ${snippet}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return (data.returnedObject && data.returnedObject.records) || [];
  }

  const epochToIso = (ms) =>
    ms == null ? null : new Date(Number(ms)).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  // Compact stop descriptor kept for the lazy address lookup (nodeaddressforvr).
  function stopRef(stop, planId) {
    if (!stop) return null;
    const addr = stop.address || {};
    return {
      locationId: stop.locationId || stop.stopCode || stop.displayName || null,
      stopCode: stop.stopCode || null,
      addressId: addr.addressId || null,
      marketplaceId: addr.marketplaceId || null,
      planId: planId || null,
    };
  }

  // FMC's own "this run still needs a carrier" signal: an ACTIVE
  // UNCOVERED_LOAD_VEHICLE_RUN disruption. RESOLVED = it got covered (or was
  // cancelled). Absent = FMC never flagged it.
  function uncoveredFlag(rec) {
    const ds = (rec && rec.disruptions) || [];
    const d = ds.find((x) => x && x.type === "UNCOVERED_LOAD_VEHICLE_RUN");
    return d ? (d.status === "ACTIVE" ? "ACTIVE" : String(d.status || "")) : null;
  }

  // record -> [vrid, mappedFields]. VRID field is `vehicleRunId`.
  // Used both for by-id enrichment (fields overlay SMC's) and for the criteria
  // search, where the record IS the row — so it carries lane/country/account.
  function mapRecord(rec) {
    const vrid = rec && rec.vehicleRunId ? String(rec.vehicleRunId).trim() : "";
    if (!vrid) return null;
    const stops = rec.aggregatedStops || [];
    const first = stops[0];
    const last = stops.length ? stops[stops.length - 1] : null;
    const accounts = rec.shipperAccounts || [];
    const origNode = (first && (first.stopCode || first.displayName)) || null;
    const destNode = (last && (last.stopCode || last.displayName)) || null;
    return [
      vrid,
      {
        vehicle_execution_status: rec.executionStatus ?? null,
        vehicle_carrier: rec.carrierId ?? null,
        carrier_name: rec.carrierName ?? null,
        tour_id: rec.tourId ?? null,
        orig_planned_yard_checkin_time: epochToIso(rec.firstYardArrival),
        dest_planned_yard_checkin_time: epochToIso(rec.lastYardArrival),
        // Lane + geography straight from the stops.
        orig_node: origNode,
        dest_node: destNode,
        orig_country: (first && first.country) || null,
        dest_country: (last && last.country) || null,
        lane: rec.simpleFacilityLane || rec.facilityLaneString || null,
        equipment_type: rec.equipmentType ?? null,
        // Business context — this is what distinguishes middle-mile runs.
        shipper_account: accounts[0] || rec.clientContract || null,
        shipper_accounts: accounts,
        tender_status: rec.tenderStatus ?? null,
        // FMC's uncovered-load disruption: "ACTIVE" | "RESOLVED" | null.
        fmc_uncovered: uncoveredFlag(rec),
        // origin/dest stop refs for the lazy address lookup at EML time.
        _fmc_orig_stop: stopRef(first, rec.planId),
        _fmc_dest_stop: stopRef(last, rec.planId),
      },
    ];
  }

  // ── criteria search (FMC as the SOURCE of the load list) ────────────────────
  // Mirrors the payload the FMC UI sends when you filter by shipper account +
  // carrier + planned-dock date range with searchByIds:false. Only the fields
  // that carry our filters are set; the rest are the UI's neutral defaults.
  // Dates are "MM/DD/YYYY" + "HH:mm" in `searchTimeZone` (we use UTC).
  const CRITERIA_PAGE_SIZE = 100;
  const CRITERIA_MAX_PAGES = 50; // hard cap: 5k runs

  function fmtCriteriaDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
  }
  function fmtCriteriaTime(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  function buildCriteriaPayload({ shipperAccounts, carriers, tenderStatuses, start, end }, page) {
    const from = new Date(start);
    const to = new Date(end);
    const pageSize = CRITERIA_PAGE_SIZE;
    return {
      stopLocationType: "facility",
      dateRangeType: "PLANNED_DOCK",
      stopStatuses: [],
      onlyDelayed: false,
      delayTypes: "LATE_ARRIVAL_OR_DEPARTURE",
      delayReason: "ALL",
      disruptionTypes: [],
      executionStatuses: [],
      planStatuses: [],
      shipperAccounts: shipperAccounts || [],
      stopActionType: "ALL",
      carriers: carriers || [],
      searchByIds: false,
      assetOwner: "",
      stopFacilities: [],
      stopFacilityCodes: [],
      facilityLanes: [],
      contractIds: [],
      caseStatuses: [],
      onlyWithCases: false,
      poContractTypes: [],
      trContainerIds: [],
      useRelativeTime: false,
      driverState: "ANY",
      driverIds: [],
      tenderStatuses: tenderStatuses || ["PLANNED", "APPROVED"],
      subcarrier: "",
      assetStatus: "ANY",
      assetId: "",
      searchTimeZone: "UTC",
      page,
      pageSize,
      fromDate: fmtCriteriaDate(from),
      fromTime: fmtCriteriaTime(from),
      toDate: fmtCriteriaDate(to),
      toTime: fmtCriteriaTime(to),
      bookmarkedSavedSearch: false,
      executionViewModePreference: "vrs",
      originalCriteria: JSON.stringify({
        stopLocationType: "facility",
        dateRangeType: "PLANNED_DOCK",
        shipperAccounts: shipperAccounts || [],
        carriers: carriers || [],
        tenderStatuses: tenderStatuses || ["PLANNED", "APPROVED"],
        searchTimeZone: "UTC",
        fromDateTime: from.getTime(),
        toDateTime: to.getTime(),
        pageSize,
      }),
    };
  }

  /**
   * Search FMC by criteria (not by id) and return every matching record,
   * mapped, keyed by vrid. Pages until totalRecords is exhausted.
   * @param {{shipperAccounts:string[], carriers:string[], tenderStatuses?:string[], start:string|number, end:string|number}} criteria
   */
  function criteriaHeaders(csrf) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
    };
    if (csrf) {
      headers["anti-csrftoken-a2z"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    return headers;
  }

  // Does this 400 body say the endpoint wanted searchIds? That's the by-id
  // endpoint rejecting a criteria payload — i.e. wrong URL, try the next one.
  function isWrongEndpointFor400(text) {
    return /searchIds must not be null or empty/i.test(text || "");
  }

  /**
   * POST a criteria payload to FMC, resolving the correct endpoint on first
   * use. Tries CRITERIA_URL_CANDIDATES in order; a candidate is rejected only
   * when it answers 400 "searchIds must not be null or empty" (the by-id
   * endpoint's complaint) or 404. Any other response — success or a genuine
   * error — pins that URL and is returned to the caller to judge.
   * @returns {Promise<Response>}
   */
  async function postCriteria(payload, csrf) {
    const body = JSON.stringify(payload);
    const candidates = _criteriaUrl ? [_criteriaUrl] : CRITERIA_URL_CANDIDATES;
    let lastErr = null;
    for (const url of candidates) {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: criteriaHeaders(csrf),
        body,
      });
      await assertApiResponse(res); // sign-in page / 401 / 403 → throws .expired
      // A wrong path comes back as an HTML error page (404 not found, 405
      // method not allowed, …) or a JSON 404. None of those are answers from
      // the search API — move to the next candidate.
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      // Any HTML reply here is not the search API (a login page would already
      // have thrown above): 404/405 error pages, or an unrelated 200 document.
      if (res.status === 404 || res.status === 405 || ctype.includes("text/html")) {
        lastErr = `HTTP ${res.status} (${ctype || "no content-type"}) at ${url}`;
        console.debug(`[LTL fmc-bridge] ${url} → HTTP ${res.status} (${ctype || "no content-type"}) — not the search API, trying next`);
        continue;
      }
      if (res.status === 400) {
        // Peek at the body without consuming the caller's stream twice.
        const text = await res.clone().text().catch(() => "");
        if (isWrongEndpointFor400(text)) {
          lastErr = `HTTP 400 (needs searchIds) at ${url}`;
          console.debug(`[LTL fmc-bridge] ${url} is the by-id endpoint — trying next candidate`);
          continue;
        }
      }
      if (_criteriaUrl !== url) {
        _criteriaUrl = url;
        console.info(`[LTL fmc-bridge] criteria endpoint resolved: ${url}`);
      }
      return res;
    }
    // If we only tried a previously-pinned URL and it now rejects, the pin is
    // stale: forget it and retry the full candidate list once.
    if (_criteriaUrl && candidates.length === 1) {
      console.warn(`[LTL fmc-bridge] pinned criteria endpoint ${_criteriaUrl} rejected — re-resolving`);
      _criteriaUrl = null;
      return postCriteria(payload, csrf);
    }
    const err = new Error(
      `No FMC criteria-search endpoint accepted the request (${lastErr}). ` +
        `Tried: ${candidates.join(", ")}`
    );
    err.status = 404;
    throw err;
  }

  async function searchByCriteria(criteria) {
    const csrf = captureCsrf();
    const out = {};
    let page = 0;
    let total = null;
    let fetched = 0;
    while (page < CRITERIA_MAX_PAGES) {
      const res = await postCriteria(buildCriteriaPayload(criteria, page), csrf);
      if (res.status !== 200) {
        const snippet = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`FMC criteria search HTTP ${res.status} — ${snippet}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const ro = data.returnedObject || {};
      const records = ro.records || [];
      if (total == null) total = Number(ro.totalRecords ?? records.length) || 0;
      for (const rec of records) {
        const pair = mapRecord(rec);
        if (pair) out[pair[0]] = pair[1];
      }
      fetched += records.length;
      console.debug(
        `[LTL fmc-bridge] criteria page ${page + 1}: ${records.length} records (total ${total}, so far ${fetched})`
      );
      if (!records.length || fetched >= total) break;
      page += 1;
    }
    return out;
  }

  async function fetchRecords(vrids) {
    const clean = [
      ...new Set((vrids || []).map((v) => String(v).trim()).filter(Boolean)),
    ];
    const out = {};
    if (!clean.length) return out;
    const csrf = captureCsrf();
    console.debug(
      "[LTL fmc-bridge]",
      csrf ? `csrf captured (len=${csrf.length})` : "no csrf token on page",
      `— ${clean.length} vrids`
    );
    for (let i = 0; i < clean.length; i += BATCH_SIZE) {
      const batch = clean.slice(i, i + BATCH_SIZE);
      const records = await postBatch(batch, csrf);
      for (const rec of records) {
        const pair = mapRecord(rec);
        if (pair) out[pair[0]] = pair[1];
      }
    }
    return out;
  }

  const ADDR_URL = "https://trans-logistics-eu.amazon.com/fmc/nodeaddressforvr";

  // Lazy address resolution via /fmc/nodeaddressforvr, one call per stop.
  // `tag` is "orig"/"dest" for logging. Returns {address|null, error|null}.
  async function resolveAddress(stopRefObj, vrid, csrf, tag) {
    if (!stopRefObj) {
      console.warn(`[LTL fmc-bridge] ${vrid} ${tag}: no stop ref`);
      return { address: null, error: "no stop ref" };
    }
    if (!stopRefObj.addressId || !stopRefObj.locationId) {
      console.warn(
        `[LTL fmc-bridge] ${vrid} ${tag}: missing ids`,
        { locationId: stopRefObj.locationId, addressId: stopRefObj.addressId }
      );
      return { address: null, error: "missing locationId/addressId" };
    }
    const body = {
      locationIdentifier: {
        locationId: stopRefObj.locationId,
        address: {
          marketplaceId: stopRefObj.marketplaceId,
          addressId: stopRefObj.addressId,
        },
      },
      vehicleRunId: vrid,
      planId: stopRefObj.planId,
    };
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
    };
    if (csrf) {
      headers["anti-csrftoken-a2z"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    console.debug(`[LTL fmc-bridge] ${vrid} ${tag}: POST nodeaddressforvr`, body);
    let res;
    try {
      res = await fetch(ADDR_URL, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(`[LTL fmc-bridge] ${vrid} ${tag}: fetch threw`, e);
      return { address: null, error: String(e && e.message ? e.message : e) };
    }
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[LTL fmc-bridge] ${vrid} ${tag}: HTTP ${res.status}`, snippet);
      return { address: null, error: `HTTP ${res.status}: ${snippet}` };
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.error(`[LTL fmc-bridge] ${vrid} ${tag}: bad JSON`, e);
      return { address: null, error: "bad JSON" };
    }
    const a = data.returnedObject;
    if (!a) {
      console.warn(
        `[LTL fmc-bridge] ${vrid} ${tag}: no returnedObject`,
        { success: data.success, errorMessage: data.errorMessage, validationErrors: data.validationErrors }
      );
      return { address: null, error: data.errorMessage || "no returnedObject" };
    }
    const formatted = [
      a.fullName, a.addressLine1, a.addressLine2, a.addressLine3, a.city, a.postalCode, a.countryCode,
    ]
      .filter((x) => x && String(x).trim())
      .join(", ");
    console.debug(`[LTL fmc-bridge] ${vrid} ${tag}: ✓`, formatted);
    return { address: formatted, error: null };
  }

  // Resolve orig + dest addresses for a set of {vrid, orig, dest} stop refs.
  async function fetchAddresses(items) {
    const csrf = captureCsrf();
    console.debug(
      "[LTL fmc-bridge] fetchAddresses:",
      csrf ? `csrf len=${csrf.length}` : "NO CSRF",
      `${(items || []).length} items`
    );
    const out = {};
    let okCount = 0;
    let errCount = 0;
    for (const it of items || []) {
      const vrid = String(it.vrid || "").trim();
      if (!vrid) continue;
      try {
        const [orig, dest] = await Promise.all([
          resolveAddress(it.orig, vrid, csrf, "orig"),
          resolveAddress(it.dest, vrid, csrf, "dest"),
        ]);
        out[vrid] = {
          orig_address: orig.address,
          dest_address: dest.address,
          orig_error: orig.error,
          dest_error: dest.error,
        };
        if (orig.address) okCount += 1;
        else errCount += 1;
        if (dest.address) okCount += 1;
        else errCount += 1;
      } catch (e) {
        errCount += 1;
        console.error("[LTL fmc-bridge] address resolve failed for", vrid, e);
        out[vrid] = { orig_address: null, dest_address: null, orig_error: String(e), dest_error: String(e) };
      }
    }
    console.debug(`[LTL fmc-bridge] fetchAddresses done: ${okCount} ok, ${errCount} failed`);
    return out;
  }

  // Cheap authenticated probe. The ONLY thing that means "not signed in" is a
  // sign-in page (redirect to Midway, or HTML) or a 401/403. Any other reply —
  // whatever its status — proves the session is live: an authenticated API
  // answered us. In particular we must NOT require status===200: an empty
  // criteria search can legitimately return other codes, and requiring 200
  // produced false "FMC sign-in required" blockers while the session was fine.
  //
  // The probe is a real, harmless criteria search (no ids, no filters, a
  // 1-minute window, pageSize 1) rather than a by-id search with a fake id,
  // so it exercises exactly the endpoint + auth path the real load uses.
  async function ping() {
    const csrf = captureCsrf();
    const now = Date.now();
    // Same endpoint-resolving path as the real search, so a working ping also
    // pins the criteria URL for the load that follows.
    const res = await postCriteria(
      {
        ...buildCriteriaPayload(
          { shipperAccounts: [], carriers: [], start: now, end: now + 60_000 },
          0
        ),
        pageSize: 1,
      },
      csrf
    );
    // postCriteria already threw (.expired) on a sign-in page / 401 / 403.
    const ctype = res.headers.get("content-type") || "";
    console.debug(`[LTL fmc-bridge] ping → HTTP ${res.status} (${ctype || "no content-type"}) — authenticated`);
    return res.status;
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.action === "fmc:ping") {
      // Reaching .then at all means assertApiResponse didn't throw, i.e. we got
      // an authenticated API reply. ok is therefore true regardless of status.
      return ping()
        .then((status) => ({ bridge: true, ok: true, status }))
        .catch((err) => ({
          bridge: true, ok: false, status: err.status || 0,
          expired: !!(err && err.expired),
          error: String(err && err.message ? err.message : err),
        }));
    }
    if (msg.action === "fmc:req") {
      return fetchRecords(msg.vrids)
        .then((records) => ({ bridge: true, ok: true, records }))
        .catch((err) => ({
          bridge: true, ok: false, status: err.status || 0,
          expired: !!(err && err.expired),
          error: String(err && err.message ? err.message : err),
        }));
    }
    if (msg.action === "fmc:search") {
      return searchByCriteria(msg.criteria || {})
        .then((records) => ({ bridge: true, ok: true, records }))
        .catch((err) => ({
          bridge: true, ok: false, status: err.status || 0,
          expired: !!(err && err.expired),
          error: String(err && err.message ? err.message : err),
        }));
    }
    if (msg.action === "fmc:addresses") {
      return fetchAddresses(msg.items)
        .then((addresses) => ({ bridge: true, ok: true, addresses }))
        .catch((err) => ({
          bridge: true, ok: false, status: err.status || 0,
          error: String(err && err.message ? err.message : err),
        }));
    }
    return; // not for us
  });

  browser.runtime
    .sendMessage({ action: "fmc:bridge-ready", href: location.href })
    .catch(() => {});

  console.info("[LTL] FMC bridge ready on", location.origin);
})();
