"""
FMC API replay scraper.

Mirrors the pattern used in scrapers/smc.py:
  1. Open the FMC search page in a persistent browser context (Amazon SSO).
  2. Listen for the real XHR the UI fires to /fmc/search/execution/by-id
     so we capture its CSRF/auth headers AND payload template.
  3. Replay the same POST via page.evaluate(fetch(...)) for our VRID batches,
     so cookies, CSRF, and the corp cert chain just work.

Returns the parsed `records` list from the response — no CSV download, no
gear-menu clicking, no popover scraping for the columns we already need.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Optional

from playwright.sync_api import sync_playwright

# =========================
# CONFIG
# =========================

USER_DATA_DIR = os.path.join(
    os.path.expanduser("~"), "AppData", "Local", "UserData"
)

# FMC search-by-id endpoint discovered from the live UI.
API_URL = "https://trans-logistics-eu.amazon.com/fmc/search/execution/by-id"

# The UI fires a search when you hit /fmc/execution/search/<ids>. We seed with
# the first VRID in the batch so the listener captures real headers + payload.
SEED_URL_TMPL = "https://trans-logistics-eu.amazon.com/fmc/execution/search/{seed}"

HEADLESS = False

# Mirror the UI: pageSize 50 per request. searchByIds returns the full set
# in one page when len(searchIds) <= pageSize, so this also acts as the
# batch size — keep it ≤ 50 to avoid losing records to pagination.
BATCH_SIZE = 50

# Where to dump the last captured payload for debugging.
DEBUG_DIR = Path(__file__).resolve().parent.parent / "debug"

# CREATE USER cst_user WITH PASSWORD 'tuvgat-vYmhom-datxud';

# CREATE DATABASE cst_viewer OWNER cst_user;

# \q




# =========================
# PUBLIC API
# =========================

def run_fmc_api_search(
    vrids: Iterable[str],
    batch_size: Optional[int] = None,
    page_size: Optional[int] = None,
) -> List[dict]:
    """
    Fetch FMC records for `vrids` by replaying the UI's by-id search call.
    Returns a list of `records` dicts (one per VRID found). VRIDs the API
    doesn't recognise are silently dropped — same as the UI.

    `batch_size` / `page_size` override the defaults. Needed when searching
    by TOUR ids: one tour returns many VRs, so the page size must be larger
    than the number of ids per request or the response silently truncates.
    """
    clean: List[str] = sorted({str(v).strip() for v in vrids if str(v).strip()})
    if not clean:
        print("⚠️ No VRIDs supplied to FMC API search")
        return []

    effective_batch = batch_size or BATCH_SIZE
    effective_page_size = page_size or effective_batch

    print(
        f"\n🚀 FMC API search started @ {datetime.now():%Y-%m-%d %H:%M} "
        f"({len(clean)} IDs, batch={effective_batch}, pageSize={effective_page_size})"
    )

    captured_headers: dict[str, str] = {}
    captured_payload: dict = {}
    csrf_token = {"value": None}
    all_records: List[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=HEADLESS,
            # Corp proxy chain isn't trusted by Playwright's HTTP client —
            # browser navigation works, but page.request.post() would fail
            # without this. Required for the fetch() replay path too.
            ignore_https_errors=True,
        )
        page = browser.new_page()

        def on_request(request):
            # Best-effort CSRF capture from any request that carries it.
            if csrf_token["value"] is None:
                token = (
                    request.headers.get("anti-csrftoken-a2z")
                    or request.headers.get("x-csrf-token")
                )
                if token:
                    csrf_token["value"] = token
            # Capture headers + body from the search endpoint itself.
            if request.url.startswith(API_URL):
                if not captured_headers:
                    captured_headers.update(request.headers)
                if not captured_payload:
                    try:
                        body = request.post_data
                        if body:
                            captured_payload.update(json.loads(body))
                    except Exception:
                        pass

        page.on("request", on_request)

        # Seed with the first VRID so the UI immediately fires a real
        # by-id search and we capture its auth + payload shape.
        seed_url = SEED_URL_TMPL.format(seed=clean[0])
        page.goto(seed_url, wait_until="domcontentloaded")

        # Wait actively for the by-id call to fly. The page sometimes serves
        # cached state, so fall back to waiting for any request to API_URL.
        try:
            page.wait_for_event(
                "request",
                predicate=lambda r: r.url.startswith(API_URL),
                timeout=20_000,
            )
        except Exception:
            pass

        # Settle the page so async XHRs that come after initial load also fire.
        try:
            page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass

        if not captured_headers:
            print("⚠️ No live FMC request observed — falling back to minimal headers")
        else:
            print(f"📡 Captured {len(captured_headers)} headers from live FMC request")

        if captured_payload:
            print("🧬 Captured live payload — replaying with same shape")
            try:
                DEBUG_DIR.mkdir(parents=True, exist_ok=True)
                (DEBUG_DIR / "fmc_last_payload.json").write_text(
                    json.dumps(captured_payload, indent=2)
                )
            except Exception as e:
                print(f"   ⚠️ Could not save debug payload: {e}")
        else:
            print("⚠️ No live FMC payload captured — using built-in template")

        # Walk the IDs in batches.
        total_batches = (len(clean) + effective_batch - 1) // effective_batch
        for idx in range(0, len(clean), effective_batch):
            batch = clean[idx:idx + effective_batch]
            batch_no = idx // effective_batch + 1

            payload = _build_payload(
                batch, captured_payload or None, page_size=effective_page_size
            )
            data = _post_via_browser(
                page, API_URL, payload, captured_headers, csrf_token["value"]
            )
            if data is None:
                print(f"❌ Batch {batch_no}/{total_batches} returned no data — skipping")
                continue

            returned = (data.get("returnedObject") or {})
            records = returned.get("records") or []
            all_records.extend(records)
            print(
                f"  Batch {batch_no}/{total_batches}: "
                f"{len(records)}/{len(batch)} records "
                f"(total so far: {len(all_records)})"
            )

            # Small pause so we don't hammer the endpoint.
            time.sleep(0.2)

        browser.close()

    print(f"✅ FMC API search done — {len(all_records)} records fetched")
    return all_records


# =========================
# INTERNALS
# =========================

def _build_payload(
    vrids: List[str], template: Optional[dict], page_size: Optional[int] = None
) -> dict:
    """
    Build the by-id search payload. If `template` (the live UI payload) is
    provided, use it as the base so we mirror sort order and any future
    filters automatically. Then override our explicit knobs.
    """
    base: dict = json.loads(json.dumps(template)) if template else {
        "searchByIds": True,
        "page": 0,
        "pageSize": BATCH_SIZE,
        "sortOrder": [{"field": "first_dock_arrival_time", "dir": "asc"}],
        "bookmarkedSavedSearch": False,
        "executionViewModePreference": "vrs",
    }

    base["searchIds"] = list(vrids)
    base["searchByIds"] = True
    base["page"] = 0
    base["pageSize"] = max(page_size or BATCH_SIZE, len(vrids))
    # `originalCriteria` is what FMC echoes back in the response — keep it in
    # sync with the actual search so server-side caching keys match.
    base["originalCriteria"] = json.dumps(
        {"searchIds": list(vrids), "pageSize": base["pageSize"]}
    )
    return base


def _post_via_browser(page, url: str, payload: dict, base_headers: dict, csrf: Optional[str]):
    """
    POST `payload` to `url` from inside the browser using fetch(), so cookies
    and any session bootstrap come along the same as for the real UI.
    Returns the parsed JSON or None on error.
    """
    headers: dict[str, str] = {}
    drop = {
        ":method", ":path", ":scheme", ":authority",
        "host", "content-length", "cookie", "connection",
    }
    for k, v in (base_headers or {}).items():
        if k.lower() in drop:
            continue
        headers[k] = v
    headers.setdefault("content-type", "application/json")
    headers.setdefault("accept", "application/json, text/plain, */*")
    if csrf:
        headers.setdefault("anti-csrftoken-a2z", csrf)
        headers.setdefault("x-csrf-token", csrf)

    try:
        result = page.evaluate(
            """
            async ({url, headers, body}) => {
                const resp = await fetch(url, {
                    method: "POST",
                    credentials: "include",
                    headers,
                    body: JSON.stringify(body),
                });
                const text = await resp.text();
                return { status: resp.status, body: text };
            }
            """,
            {"url": url, "headers": headers, "body": payload},
        )
    except Exception as e:
        print(f"❌ Browser fetch threw: {e}")
        return None

    status = result.get("status")
    if status != 200:
        snippet = (result.get("body") or "")[:300]
        print(f"❌ API error: HTTP {status} — {snippet}")
        return None

    try:
        return json.loads(result["body"])
    except Exception as e:
        print(f"❌ Could not parse JSON response: {e}")
        return None
