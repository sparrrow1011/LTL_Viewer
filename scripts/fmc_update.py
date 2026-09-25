"""
FMC → JSON update. Ports update_fmc_fields_from_api() and
update_fmc_address_fields() from CST_viewer to the JSON store (no Postgres).

Updates existing run rows in cst_runs.json matched by vrid. Uses COALESCE-style
semantics: a field is only overwritten when the incoming value is non-empty.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

from app import store
from app.sync_status.service import record_sync

# Path to the FMC address JSON the scraper writes. Computed locally so this
# module can be imported/tested without importing the Playwright-backed
# scrapers.fmc (which requires the playwright package at import time).
_LTL_MS_DIR = Path(os.getenv("LTL_MS_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS"))
FMC_ADDR_JSON = _LTL_MS_DIR / "JSON_Output" / "fmc_addresses.json"


# ── helpers ───────────────────────────────────────────────────────────────────
def _epoch_ms_to_iso(value) -> Optional[str]:
    if value is None:
        return None
    try:
        dt = datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None
    return dt.isoformat(sep=" ")


def _split_lane(lane: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    if not lane or "->" not in lane:
        return None, None
    try:
        orig, dest = [p.strip() or None for p in lane.split("->", 1)]
        return orig, dest
    except ValueError:
        return None, None


def _planned_driver_id(record: dict) -> Optional[str]:
    drivers = record.get("assignedDrivers") or []
    if not drivers:
        return None
    planned = next((d for d in drivers if d.get("isPlanned") and d.get("assetId")), None)
    chosen = planned or next((d for d in drivers if d.get("assetId")), None)
    if not chosen:
        return None
    asset_id = chosen.get("assetId")
    return str(asset_id).strip() if asset_id else None


def _is_empty(v) -> bool:
    return v is None or str(v).strip() == ""


def _record_to_update(record: dict) -> Optional[dict]:
    vrid = record.get("vehicleRunId")
    if not vrid:
        return None
    orig_node, dest_node = _split_lane(
        record.get("simpleFacilityLane") or record.get("facilityLaneString")
    )
    shipper_accounts = record.get("shipperAccounts") or []
    shipper_account = shipper_accounts[0] if shipper_accounts else None
    return {
        "vrid": str(vrid).strip(),
        "scac": record.get("carrierId"),
        "vehicle_carrier": record.get("carrierId"),
        "equipment_type": record.get("equipmentType"),
        "orig_planned_yard_checkin_time": _epoch_ms_to_iso(record.get("firstYardArrival")),
        "dest_planned_yard_checkin_time": _epoch_ms_to_iso(record.get("lastYardArrival")),
        "vehicle_execution_status": record.get("executionStatus"),
        "orig_node": orig_node,
        "dest_node": dest_node,
        "tour_id": record.get("tourId"),
        "driver": _planned_driver_id(record),
        "shipper_account": shipper_account,
    }


def update_fmc_fields_from_api(records: List[dict], record: bool = True) -> int:
    """Push FMC API records into cst_runs.json, matched by vrid (COALESCE-style)."""
    if not records:
        print("⚠️ No FMC records supplied — nothing to update.")
        return 0

    updates = [u for u in (_record_to_update(r) for r in records) if u]
    if not updates:
        print("⚠️ No usable FMC records (missing vehicleRunId).")
        return 0

    by_vrid: dict[str, dict] = {u["vrid"]: u for u in updates}
    rows = store.load_runs()

    updated = 0
    for r in rows:
        vrid = str(r.get("vrid") or "").strip()
        upd = by_vrid.get(vrid)
        if not upd:
            continue
        for col, val in upd.items():
            if col == "vrid":
                continue
            if not _is_empty(val):
                r[col] = val
        updated += 1

    store.save_runs(rows)
    print(f"🎯 FMC updated {updated} row(s) in cst_runs.json.")
    if record:
        record_sync("fmc", rows_affected=updated)
    return updated


def load_fmc_addresses(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[fmc_update] could not read addresses json: {e}")
        return {}


def _resolve_orig_dest_address(vrid: str, addr_map: dict):
    stops = addr_map.get(vrid) or []
    orig = stops[0]["address"].strip() if len(stops) >= 1 and stops[0].get("address") else None
    dest = stops[1]["address"].strip() if len(stops) >= 2 and stops[1].get("address") else None
    return orig, dest


def update_fmc_address_fields() -> int:
    """Fill orig_address / dest_address on matching runs from the FMC addr JSON."""
    addr_map = load_fmc_addresses(str(FMC_ADDR_JSON))
    if not addr_map:
        print("⚠️ FMC address JSON is empty — nothing to update.")
        return 0

    resolved = {}
    for vrid in addr_map:
        v = str(vrid).strip()
        if not v:
            continue
        orig, dest = _resolve_orig_dest_address(vrid, addr_map)
        resolved[v] = (orig or None, dest or None)

    rows = store.load_runs()
    updated = 0
    for r in rows:
        vrid = str(r.get("vrid") or "").strip()
        if vrid not in resolved:
            continue
        orig, dest = resolved[vrid]
        if orig is not None:
            r["orig_address"] = orig
        if dest is not None:
            r["dest_address"] = dest
        updated += 1

    store.save_runs(rows)
    print(f"🎯 FMC addresses updated {updated} row(s).")
    return updated
