import os
import json
import time
from pathlib import Path
from typing import List, Optional, Dict

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError
from playwright.sync_api import Page, TimeoutError as PWTimeoutError


_LTL_MS_DIR = Path(os.getenv("LTL_MS_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS"))

DOWNLOAD_DIR = _LTL_MS_DIR
EXPORT_NAME = "fmc_search_results.csv"

USER_DATA_DIR = os.path.join(os.path.expanduser("~"), "AppData", "Local", "UserData")

HEADLESS = False


TEMP_DIR = _LTL_MS_DIR / "JSON_Output"
try:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
except Exception as _e:
    print(f"[fmc] could not create TEMP_DIR {TEMP_DIR}: {_e}")

FMC_ADDR_JSON = TEMP_DIR / "fmc_addresses.json"
FMC_DRIVER_JSON = TEMP_DIR / "fmc_driver_ids.json"

def save_driver_json(driver_map: dict, path: Path = FMC_DRIVER_JSON) -> str:
    path.write_text(json.dumps(driver_map, indent=2), encoding="utf-8")
    return str(path)

def load_driver_json(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))

def save_fmc_addresses_json(data: dict, path: Path = FMC_ADDR_JSON) -> str:
    """
    data shape:
      {
        "VRID1": [{"stop_name": "...", "address": "..."}, {"stop_name": "...", "address": "..."}],
        "VRID2": [...]
      }
    """
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(path)



# =========================
# HELPERS
# =========================

def _build_fmc_url(vrids: List[str]) -> str:
    query = ",".join(vrids)
    return f"https://trans-logistics-eu.amazon.com/fmc/execution/search/{query}"


# =========================
# PLAYWRIGHT
# =========================

def _open_browser():
    pw = sync_playwright().start()
    browser = pw.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=HEADLESS,
        accept_downloads=True,
    )
    return pw, browser


def _run_single_batch(page, vrids: List[str]) -> Path:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    output = DOWNLOAD_DIR / EXPORT_NAME

    url = _build_fmc_url(vrids)
    page.goto(url, wait_until="domcontentloaded")
    time.sleep(2)

    # Expand sidebar if collapsed (safe-guarded)
    try:
        collapsible = page.locator("div.collapsible-button.collapsible-closed")
        if collapsible.count() > 0 and collapsible.first.is_visible():
            collapsible.first.click()
            time.sleep(0.5)
    except Exception:
        pass  # not critical

    # Submit search
    search_btn = '#a-autoid-26 input[type="submit"]'
    page.wait_for_selector(search_btn, timeout=20000)
    page.click(search_btn)
    time.sleep(1)

    # Download CSV
    with page.expect_download(timeout=60000) as dl_info:
        page.click('#download-csv-btn input[type="submit"]')

    download = dl_info.value

    if output.exists():
        output.unlink()

    download.save_as(output)
    return output




def _is_checked(col_item) -> bool:
    """
    FMC shows a ✓ inside div.col-vis-check when enabled.
    """
    try:
        check_div = col_item.locator("div.col-vis-check").first
        txt = (check_div.inner_text() or "").strip()
        return "✓" in txt
    except Exception:
        return False


def ensure_driver_column_enabled(page: Page) -> bool:
    """
    Ensures 'Driver' column (data-colind="36") is enabled in FMC.
    Returns True if enabled (already or after click), False if we couldn't.
    """
    # Click gear button
    gear_btn = page.locator('button.a-button-text:has(i.fa-gear)').first
    if gear_btn.count() == 0:
        print("❌ Gear button not found")
        return False

    gear_btn.click()
    print("✅ Gear clicked")

    # Wait for columns menu
    menu = page.locator("ul.fmc-columns-list").first
    try:
        menu.wait_for(state="visible", timeout=5000)
    except PWTimeoutError:
        print("❌ Columns list did not open")
        return False

    # Find Driver column item
    driver_item = menu.locator('li.column-item.fmc-main-colvis[data-colind="36"]').first
    if driver_item.count() == 0:
        print("❌ Driver column item (data-colind=36) not found")
        # close menu
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        return False

    # Enable if not checked
    if _is_checked(driver_item):
        print("ℹ️ Driver column already enabled")
    else:
        print("⚙️ Enabling Driver column…")
        driver_item.click()
        # wait until ✓ appears
        try:
            page.wait_for_timeout(250)  # quick UI update
        except Exception:
            pass

        if _is_checked(driver_item):
            print("✅ Driver column enabled")
        else:
            print("⚠️ Clicked Driver column but it still looks unchecked")

    # Close menu (click outside + escape fallback)
    try:
        page.mouse.click(5, 5)
    except Exception:
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass

    # Wait for menu to hide (best effort)
    try:
        menu.wait_for(state="hidden", timeout=2000)
    except Exception:
        pass

    return True



def extract_driver_ids(page, vrids: List[str]) -> Dict[str, Optional[str]]:
    """
    Returns a map: { vrid: driver_id_or_None }
    """
    driver_map: Dict[str, Optional[str]] = {}

    for vrid in vrids:
        url = f"https://trans-logistics-eu.amazon.com/fmc/execution/search/{vrid}"
        print(f"\n=== VRID {vrid} ===")
        page.goto(url, wait_until="domcontentloaded")
        time.sleep(3)

        # Scope to the cell area (optional, but safer)
        driver_span = page.locator("span.clickable-text.driver-container").first

        if driver_span.count() == 0:
            print("ℹ️ No driver container found")
            driver_map[vrid] = None
            continue

        try:
            driver_id = driver_span.get_attribute("data-driver-id")
            driver_id = driver_id.strip() if driver_id else None
            print(f"✅ driver-id: {driver_id}")
            driver_map[vrid] = driver_id
        except Exception as e:
            print(f"⚠️ Failed to read data-driver-id: {e}")
            driver_map[vrid] = None

    return driver_map


def _run_pick_address(page, vrids: List[str]) -> str:
    """
    Extracts stop popover addresses for each vrid and writes temp JSON.
    Returns JSON file path.
    """
    all_results: Dict[str, List[Dict[str, str]]] = {}

    for vrid in vrids:
        url = f"https://trans-logistics-eu.amazon.com/fmc/execution/search/{vrid}"
        print(f"\n=== VRID {vrid} ===")
        page.goto(url)
        time.sleep(0.2)

        tables = page.locator("table.expanded-child-table")
        if tables.count() == 0:
            print("⚠️ No expanded-child-table found")
            all_results[vrid] = []
            continue

        table = tables.first
        stop_rows = table.locator("tbody tr.stop-start")
        row_count = stop_rows.count()
        print(f"Found {row_count} stop-start rows")

        results: List[Dict[str, str]] = []

        for i in range(row_count):
            row = stop_rows.nth(i)
            stop_span = row.locator("span.vr-stop-name").first

            try:
                stop_name = stop_span.inner_text().strip()
            except Exception:
                stop_name = ""

            # open popover
            try:
                stop_span.scroll_into_view_if_needed()
            except Exception:
                pass

            opened = False
            try:
                stop_span.click(force=True, timeout=3000)
                opened = True
                time.sleep(0.5)
            except PWTimeoutError:
                pass
            except Exception:
                pass

            if not opened:
                try:
                    stop_span.hover(timeout=3000)
                    opened = True
                    time.sleep(0.5)
                except Exception:
                    opened = False

            if not opened:
                results.append({"stop_name": stop_name, "address": ""})
                continue

            popover = page.locator("div.ui-tooltip.fmt-popover:visible").first

            try:
                popover.wait_for(state="visible", timeout=5000)
            except Exception:
                results.append({"stop_name": stop_name, "address": ""})
                continue

            content_el = popover.locator("div.ui-tooltip-content.fmt-popover-content").first
            try:
                content_el.wait_for(state="visible", timeout=5000)
                address_text = content_el.inner_text().strip()
            except Exception:
                address_text = ""

            results.append({"stop_name": stop_name, "address": address_text})

            # close popover
            close_btn = popover.locator("button.fmt-popover-titlebar-close").first
            try:
                close_btn.click(timeout=3000)
            except Exception:
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass

            try:
                popover.wait_for(state="hidden", timeout=3000)
            except Exception:
                try:
                    page.mouse.click(5, 5)
                except Exception:
                    pass

            time.sleep(0.2)

        all_results[vrid] = results

        # debug
        print("\n=== PICK ADDRESS RESULTS ===")
        for res in results:
            print(f"Stop: {res['stop_name']}\nAddress:\n{res['address']}\n")

    json_path = save_fmc_addresses_json(all_results)
    print(f"✅ Saved FMC addresses JSON → {json_path}")
    return json_path


def run_address_scrap(vrids: List[str]):
    pw, browser = _open_browser()
    try:
        page = browser.new_page()
        _run_pick_address(page, vrids)
    except Exception as e:
        print(f"❌ FMC pick address failed: {e}")
    finally:
        try:
            browser.close()
        finally:
            pw.stop()       


def run_driver_scrap(vrids: List[str]) -> Dict[str, Optional[str]]:
    """
    Opens FMC and extracts driver ids for the provided VRIDs.
    Returns {vrid: driver_id_or_None}.
    """
    if not vrids:
        return {}

    pw, browser = _open_browser()
    try:
        page = browser.new_page()
        return extract_driver_ids(page, vrids)
    except Exception as e:
        print(f"❌ FMC driver extraction failed: {e}")
        return {}
    finally:
        try:
            browser.close()
        finally:
            pw.stop()
    

# =========================
# PUBLIC API
# =========================

def run_fmc_export(vrids: List[str]) -> Optional[Path]:
    """
    Run FMC export for up to 1000 VRIDs.
    Returns Path to downloaded CSV, or None on failure.
    """
    if not vrids:
        print("⚠️ No VRIDs supplied to FMC")
        return None

    vrids = vrids[:1000]
    print(f"🚀 FMC export started ({len(vrids)} VRIDs)")

    pw, browser = _open_browser()
    try:
        page = browser.new_page()
        output = _run_single_batch(page, vrids)
        print(f"✅ FMC export downloaded → {output}")
        return output

    except Exception as e:
        print(f"❌ FMC export failed: {e}")
        return None

    finally:
        try:
            browser.close()
        finally:
            pw.stop()
