"""
SMC → JSON update. Ports update_cst_fields_from_json() from CST_viewer to the
JSON store (no Postgres). Maps SMC API order dicts to run rows, upserts them
into cst_runs.json keyed on (orderid, vrid or ''), drops LTL rows, and removes
stale VRIDs no longer reported by SMC for each returned order.
"""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd

from app import store
from app.sync_status.service import record_sync

CHUNK_SIZE = 50

_LTL_MS_DIR = Path(os.getenv("LTL_MS_DIR", r"\\ant\dept-eu\BHX2\Public\AF-CST\LTL_MS"))
SHIPPER_FILE = _LTL_MS_DIR / "source_of_truth_crawler.csv"


def load_shipper_group_map() -> dict:
    """Map shipperid → shipper_group from the source-of-truth CSV, if present."""
    try:
        df = pd.read_csv(SHIPPER_FILE, dtype=str).fillna("")
        df["shipperid"] = df["shipperid"].astype(str).str.strip()
        df["shipper_group"] = df["shipper_group"].astype(str).str.strip()
        return dict(zip(df["shipperid"], df["shipper_group"]))
    except Exception as e:
        print(f"[smc_update] could not load shipper group map: {e}")
        return {}


def _extract_revenue(order: dict):
    pricing = (order.get("shipperPricing") or {}).get("pricing") or []
    if not pricing:
        return None
    for p in pricing:
        if p.get("type") == "LINE_HAUL":
            return p.get("price", {}).get("value")
    return pricing[0].get("price", {}).get("value")


def _order_to_rows(order: dict, shipper_group_map: dict) -> list[dict]:
    stops = order.get("stops") or []
    stop1 = stops[0] if stops else {}
    stop2 = stops[-1] if len(stops) > 1 else {}

    vrid_list = [v for v in (order.get("vehicleRunIds") or []) if v] or [None]

    shipper = order.get("shipperDetails") or {}
    shipperid = str(shipper.get("shipperId") or "").strip()
    orig_addr = stop1.get("address") or {}
    dest_addr = stop2.get("address") or {}
    create_audit = ((order.get("auditDetails") or {}).get("createAudit")) or {}
    carrier_details = order.get("carrierDetails") or {}
    orig_loc = stop1.get("stopLocationCode")
    dest_loc = stop2.get("stopLocationCode")

    base = {
        "orderid":                        str(order["orderIdentifier"]["id"]),
        "shipperid":                      shipperid,
        "shippername":                    shipper.get("shipperName"),
        "shipper_group":                  shipper_group_map.get(shipperid, ""),
        "shipper_ref":                    order.get("shipperReferenceId"),
        "orig_country":                   orig_addr.get("countryCode"),
        "dest_country":                   dest_addr.get("countryCode"),
        "origin":                         stop1.get("stopName"),
        "dest":                           stop2.get("stopName"),
        "lane":                           f"{stop1.get('stopName', '')} → {stop2.get('stopName', '')}",
        "origin_code":                    orig_loc,
        "dest_code":                      dest_loc,
        "orig_node":                      orig_loc,
        "dest_node":                      dest_loc,
        "equipment_type":                 order.get("equipmentType"),
        "smc_equipment_type":             order.get("equipmentType"),
        "freight_type":                   order.get("freightType"),
        "vehicle_carrier":                carrier_details.get("carrierId"),
        "revenue":                        _extract_revenue(order),
        "distance_value":                 (order.get("totalDistance") or {}).get("value"),
        "orig_planned_yard_checkin_time": stop1.get("startTime"),
        "dest_planned_yard_checkin_time": stop2.get("startTime"),
        "status":                         order.get("orderStatus"),
        "execution_status":               order.get("executionStatus"),
        "vehicle_execution_status":       order.get("vrExecutionStatus") or order.get("executionStatus"),
        "invoice_status":                 order.get("invoiceStatus"),
        "isa":                            stop2.get("appointmentId"),
        "createdat":                      create_audit.get("timestamp"),
        "createdby":                      create_audit.get("requester"),
    }

    rows = []
    for vrid in vrid_list:
        row = base.copy()
        row["vrid"] = vrid
        rows.append(row)
    return rows


# Columns FMC/manual-source own once set — don't let SMC clobber them with empty.
_PRESERVE_COLS = {
    "vehicle_carrier",
    "origin_code",
    "dest_code",
    "vehicle_execution_status",
}
# Columns owned by manual sourcing — never overwritten by an SMC sync.
_MS_OWNED_COLS = {
    "is_manual_source", "sims", "ms_cost", "manual_source_by", "manual_source_date",
    "email_sent", "email_sent_count", "email_sent_confirmed_at", "email_sent_by",
    "email_generated_at", "orig_address", "dest_address",
}


def _is_empty(v) -> bool:
    return v is None or str(v).strip() == ""


def update_cst_fields_from_json(orders: list[dict], chunk_size: int = CHUNK_SIZE) -> int:
    """Upsert SMC order data into the JSON runs store."""
    shipper_group_map = load_shipper_group_map()

    incoming: list[dict] = []
    for order in orders or []:
        try:
            incoming.extend(_order_to_rows(order, shipper_group_map))
        except (KeyError, TypeError) as e:
            print(f"[smc_update] skipping malformed order: {e}")

    existing = store.load_runs()

    if not incoming:
        # Even with nothing incoming, scrub any pre-existing LTL rows.
        before = len(existing)
        existing = [
            r for r in existing
            if str(r.get("freight_type") or "").upper() != "LESS_THAN_TRUCKLOAD"
        ]
        if len(existing) != before:
            store.save_runs(existing)
            print(f"🧹 Removed {before - len(existing)} pre-existing LTL row(s).")
        record_sync("smc", rows_affected=0)
        return 0

    # Dedupe incoming on (orderid, vrid or '') — last wins.
    seen: dict[tuple, dict] = {}
    for r in incoming:
        seen[store.row_key(r)] = r
    deduped = list(seen.values())

    index = store.index_by_key(existing)

    for new in deduped:
        key = store.row_key(new)
        cur = index.get(key)
        if cur is None:
            index[key] = new
            continue
        # Merge: keep MS-owned columns, respect preserve rules.
        for col, val in new.items():
            if col in _MS_OWNED_COLS:
                continue
            if col in _PRESERVE_COLS:
                if _is_empty(cur.get(col)):
                    cur[col] = val
            else:
                cur[col] = val

    merged = list(index.values())

    # Stale VRID cleanup: for each orderid SMC returned, drop rows whose vrid
    # isn't in the set SMC just reported for that orderid.
    returned_by_order: dict[str, set[str]] = {}
    for r in deduped:
        returned_by_order.setdefault(str(r.get("orderid") or ""), set()).add(
            str(r.get("vrid") or "")
        )

    stale_deleted = 0
    kept = []
    for r in merged:
        oid = str(r.get("orderid") or "")
        if oid in returned_by_order:
            if str(r.get("vrid") or "") not in returned_by_order[oid]:
                stale_deleted += 1
                continue
        kept.append(r)
    merged = kept

    # Drop LTL rows after the upsert.
    before = len(merged)
    merged = [
        r for r in merged
        if str(r.get("freight_type") or "").upper() != "LESS_THAN_TRUCKLOAD"
    ]
    ltl_deleted = before - len(merged)

    store.save_runs(merged)

    print(f"✅ Upserted {len(deduped)} SMC rows into cst_runs.json.")
    if stale_deleted:
        print(f"🧹 Removed {stale_deleted} stale VRID row(s).")
    if ltl_deleted:
        print(f"🧹 Removed {ltl_deleted} LTL row(s).")

    record_sync("smc", rows_affected=len(deduped))
    return len(deduped)


if __name__ == "__main__":
    from scrapers.smc import run_smc_export
    orders = run_smc_export()
    if orders:
        update_cst_fields_from_json(orders)
