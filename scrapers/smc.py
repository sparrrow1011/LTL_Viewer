import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

# =========================
# CONFIG
# =========================

SOT_DIR = Path(
    os.getenv("LTL_MS_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS")
) / "source_of_truth_crawler.csv"

USER_DATA_DIR = os.path.join(
    os.path.expanduser("~"), "AppData", "Local", "UserData"
)

SMC_URL = "https://smc-eu-dub.dub.proxy.amazon.com/orders/list/tab/1"
API_URL = "https://smc-eu-dub.dub.proxy.amazon.com/shipper/order/search"

HEADLESS = False
PAGE_SIZE = 200

# Rolling date window for the API filter (days relative to "now").
DATE_WINDOW_DAYS_BACK = 14
DATE_WINDOW_DAYS_FORWARD = 14

# Hard cap so a misconfigured filter can't pull the whole archive.
MAX_PAGES = 100

# Where to dump the captured live payload for debugging / discovering the
# date field name the API expects. Stored inside the workspace so it's easy
# to inspect.
DEBUG_DIR = Path(__file__).resolve().parent.parent / "debug"

# =========================
# HELPERS
# =========================

def _read_shipper_ids() -> list[str]:
    text = SOT_DIR.read_text()
    lines = text.strip().split("\n")
    columns = [c.strip().lower() for c in lines[0].split(",")]
    if "shipperid" not in columns:
        raise ValueError("source_of_truth_crawler.csv missing 'shipperid' column")
    idx = columns.index("shipperid")
    ids = []
    for line in lines[1:]:
        row = [c.strip() for c in line.split(",")]
        if len(row) > idx and row[idx]:
            ids.append(row[idx])
    return ids[:1000]


def _iso_window() -> tuple[str, str]:
    """Return (start, end) ISO-8601 timestamps for the rolling date window."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=DATE_WINDOW_DAYS_BACK)
    end = now + timedelta(days=DATE_WINDOW_DAYS_FORWARD)
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"
    return start.strftime(fmt), end.strftime(fmt)


def _build_payload(shipper_ids: list[str], page: int, template: dict | None = None) -> dict:
    """
    Build the search payload. If `template` (the live UI payload) is provided,
    use it as the base so we mirror sort order and any new filters
    automatically. Then override our explicit knobs.
    """
    base: dict = json.loads(json.dumps(template)) if template else {
        "sortCriteria": [{"field": "ORDER_CREATION_DATE", "sortDirection": "DESC"}],
        "andCriteria": {},
        "orCriteria": {},
        "pageCriteria": {"page": page, "size": PAGE_SIZE, "totalRecords": 0},
    }

    base.setdefault("sortCriteria", [{"field": "ORDER_CREATION_DATE", "sortDirection": "DESC"}])
    base.setdefault("orCriteria", {})
    and_c = base.setdefault("andCriteria", {})

    # Filters we always control.
    and_c["orderSources"] = ["SMC", "R4S", "EDI", "AFAPI"]
    and_c["freightTypes"] = ["LESS_THAN_TRUCKLOAD", "TRUCKLOAD", "INTERMODAL"]
    and_c["orderExecutionStatuses"] = [
        "IN_DRAFT", "NOT_PLANNED", "PENDING_CARRIER_ACCEPTANCE",
        "CARRIER_TENDER_ACCEPTED", "DRIVER_DISPATCHED", "LATE_TO_ARRIVE",
        "ARRIVED", "LATE_TO_DEPART", "DEPARTED",
        "PENDING_DELIVERY_CONFIRMATION", "DELIVERY_CONFIRMED",
        "PENDING_PAYMENT", "PAID", "CANCELLED", "REJECTED",
    ]
    # All countries — empty list means "no channel filter".
    and_c["shipperBusinessChannels"] = []
    and_c["shipperIds"] = shipper_ids
    # Don't restrict to the "ready for scheduling" bucket: orders that already
    # have a VRID assigned graduate out of that tab and would otherwise be
    # missed on subsequent syncs (causing stale VRIDs to linger in cst_runs).
    and_c.pop("readyForScheduling", None)

    # Date window: filter on origin stop date. Field/shape mirrors what the
    # SMC UI sends: andCriteria.originDateRange = {start, end} (ISO Z),
    # with a companion null `originDateRangeLabel`.
    start, end = _iso_window()
    and_c["originDateRangeLabel"] = None
    and_c["originDateRange"] = {"start": start, "end": end}

    base["pageCriteria"] = {"page": page, "size": PAGE_SIZE, "totalRecords": 0}
    return base


# =========================
# PUBLIC API
# =========================

def run_smc_export() -> list[dict] | None:
    """
    Fetches all orders from the SMC API using the persistent browser session
    (Amazon SSO auth) and returns them as a list of order dicts.
    Handles pagination automatically.
    """
    print(f"\n🚀 SMC API export started @ {datetime.now():%Y-%m-%d %H:%M}")

    shipper_ids = _read_shipper_ids()
    print(f"ℹ️ Loaded {len(shipper_ids)} shipper IDs")

    all_orders = []
    csrf_token = {"value": None}
    # Headers captured from the live SMC UI request to /shipper/order/search.
    # Used as the source of truth for replaying API calls — keeps us in sync
    # with whatever auth/CSRF scheme the UI is currently using.
    captured_headers: dict[str, str] = {}
    # Body captured from the live SMC UI request. Used as a payload template
    # so we mirror the date-range field name and any new filters automatically.
    captured_payload: dict = {}

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=HEADLESS,
            # The Amazon corp proxy chain isn't trusted by Playwright's own
            # HTTP client. The browser itself trusts it via the OS store, so
            # navigation works, but `page.request.post(...)` fails with
            # "self-signed certificate in certificate chain" without this.
            ignore_https_errors=True,
        )
        page = browser.new_page()

        # Capture headers AND body from any request that the page makes to the
        # order-search endpoint. These are the canonical auth/CSRF headers and
        # the payload shape the UI is currently using.
        def on_request(request):
            if csrf_token["value"] is None:
                token = (
                    request.headers.get("x-csrf-token")
                    or request.headers.get("anti-csrftoken-a2z")
                )
                if token:
                    csrf_token["value"] = token
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
        page.goto(SMC_URL)
        page.wait_for_load_state("networkidle")

        # Fallback 1: wait actively for a request that carries the header,
        # in case the listing tab was served from cache and the listener
        # didn't fire during goto().
        if not csrf_token["value"]:
            try:
                req = page.wait_for_event(
                    "request",
                    predicate=lambda r: bool(
                        r.headers.get("x-csrf-token")
                        or r.headers.get("anti-csrftoken-a2z")
                    ),
                    timeout=15_000,
                )
                csrf_token["value"] = (
                    req.headers.get("x-csrf-token")
                    or req.headers.get("anti-csrftoken-a2z")
                )
            except Exception:
                pass

        # Fallback 2: pull it from the page's meta tags or cookies.
        if not csrf_token["value"]:
            try:
                csrf_token["value"] = page.evaluate(
                    """
                    () => {
                        const m = document.querySelector(
                            'meta[name="csrf-token"], meta[name="x-csrf-token"], meta[name="anti-csrftoken-a2z"]'
                        );
                        if (m) return m.getAttribute('content');
                        const cookie = document.cookie
                            .split(';')
                            .map(s => s.trim())
                            .find(s => /csrf|xsrf/i.test(s));
                        return cookie ? cookie.split('=').slice(1).join('=') : null;
                    }
                    """
                )
            except Exception:
                pass

        if not csrf_token["value"]:
            print("⚠️ Could not capture CSRF token — requests may be rejected")
        else:
            print(f"🔑 CSRF token captured ({len(csrf_token['value'])} chars)")

        # Trigger a real search if the page hasn't fired one yet, so we can
        # capture the exact request headers the UI uses (auth scheme can change
        # between subdomains and we want to mirror it precisely).
        if not captured_headers:
            try:
                page.wait_for_event(
                    "request",
                    predicate=lambda r: r.url.startswith(API_URL),
                    timeout=20_000,
                )
            except Exception:
                pass

        if captured_headers:
            print(f"📡 Captured {len(captured_headers)} headers from live SMC request")
        else:
            print("⚠️ No live SMC request observed — falling back to minimal headers")

        if captured_payload:
            and_keys = list((captured_payload.get("andCriteria") or {}).keys())
            print(f"🧬 Captured live payload — andCriteria keys: {and_keys}")
            try:
                DEBUG_DIR.mkdir(parents=True, exist_ok=True)
                dump_path = DEBUG_DIR / "smc_last_payload.json"
                dump_path.write_text(json.dumps(captured_payload, indent=2))
                print(f"   💾 Saved live payload to {dump_path}")
            except Exception as e:
                print(f"   ⚠️ Could not save debug payload: {e}")
        else:
            print("⚠️ No live SMC payload captured — using built-in template")

        win_start, win_end = _iso_window()
        print(
            f"📅 Date window (originDateRange): {win_start} → {win_end} "
            f"(±{DATE_WINDOW_DAYS_BACK}/{DATE_WINDOW_DAYS_FORWARD}d)"
        )

        current_page = 1

        while True:
            payload = _build_payload(shipper_ids, current_page, captured_payload or None)

            data = _post_via_browser(page, API_URL, payload, captured_headers, csrf_token["value"])
            if data is None:
                break

            orders = data.get("orders", [])
            all_orders.extend(orders)

            pr = data["pageResult"]
            total = pr["totalRecords"]
            print(f"  Page {current_page}: {len(orders)} orders (total: {total})")

            if current_page * PAGE_SIZE >= total:
                break
            if current_page >= MAX_PAGES:
                print(
                    f"⚠️ Hit MAX_PAGES={MAX_PAGES} cap at total={total}. "
                    f"Tighten the date window or filters if this looks wrong."
                )
                break
            current_page += 1

        browser.close()

    print(f"✅ Fetched {len(all_orders)} orders total")
    return all_orders if all_orders else None


def _post_via_browser(page, url: str, payload: dict, base_headers: dict, csrf: str | None):
    """
    POST `payload` to `url` from inside the browser using fetch(), so cookies,
    CSRF headers, and any session bootstrap come along the same as for the
    real UI. Returns the parsed JSON, or None on error.
    """
    # Build the headers we send: start from what the UI sends, then layer on
    # JSON content-type and (optionally) the captured CSRF token.
    headers: dict[str, str] = {}
    drop = {
        # Pseudo-headers and ones the browser will set itself.
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
        headers.setdefault("x-csrf-token", csrf)
        headers.setdefault("anti-csrftoken-a2z", csrf)

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
