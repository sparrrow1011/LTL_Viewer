"""
Manual-sourcing services — reimplemented over JSON storage (no Postgres).

get_rows() reads the runs (or ms) JSON array and applies the same filters the
original SQL layer supported, in pure Python. The manual-source and email
toggles mutate the JSON arrays and save them back atomically.

No auth: the acting user is always "DesktopUser".
"""

from __future__ import annotations

from datetime import datetime, timedelta
from dateutil.parser import parse as parse_any_date

from flask import jsonify, request

from app import store

# Field snapshotted into ms_runs when a run is marked manual-source.
MS_SNAPSHOT_FIELDS = [
    "vrid", "orderid", "shipperid", "shippername", "orig_country", "orig_node",
    "dest_country", "dest_node", "origin", "dest", "lane", "equipment_type",
    "vehicle_carrier", "revenue", "cost_eur", "distance_value",
    "orig_planned_yard_checkin_time", "dest_planned_yard_checkin_time",
    "execution_status", "vehicle_execution_status", "schedule_date",
    "email_sent", "email_sent_count", "email_sent_confirmed_at",
    "email_sent_by", "email_generated_at", "sims", "ms_cost",
    "is_manual_source", "manual_source_by", "manual_source_date",
    # extra address fields the email builder needs
    "orig_address", "dest_address", "origin_code", "dest_code", "tour_id",
]


def get_logged_in_user() -> str:
    # Free for all — no users.
    return "DesktopUser"


# ── date helpers ──────────────────────────────────────────────────────────────
def _parse_date(value):
    """Parse a stored date string into a date, tolerating multiple formats."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M",
                "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        return parse_any_date(s).date()
    except (ValueError, TypeError, OverflowError):
        return None


def ensure_list(val):
    if isinstance(val, list):
        return val
    if val:
        return [val]
    return []


def _get_values(src, key):
    """Return list of values for a key from a MultiDict or plain dict."""
    if hasattr(src, "getlist"):
        return src.getlist(key)
    return ensure_list(src.get(key)) if isinstance(src, dict) else ensure_list(src)


def _truthy(val) -> bool:
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("1", "true", "yes")


# ── read ──────────────────────────────────────────────────────────────────────
def get_rows(filters=None):
    """
    Return run rows matching `filters` (a MultiDict/dict). Mirrors the filter
    set the original SQL get_rows supported, evaluated in Python over JSON.
    """
    use_ms = bool(filters and _truthy(filters.get("is_manual_source"))
                  if hasattr(filters, "get") else False)
    rows = store.load_ms() if use_ms else store.load_runs()

    if not filters:
        return _finalize(rows)

    def norm_upper(v):
        return str(v or "").strip().upper()

    # multi-value equality (upper-cased) filters
    def keep_in(field, key, upper=True, trim=True):
        vals = [(_u(x) if upper else x.strip() if trim else x)
                for x in _get_values(filters, key) if str(x).strip()]
        if not vals:
            return None
        vals_set = set(vals)
        return lambda r: (norm_upper(r.get(field)) if upper
                          else str(r.get(field) or "").strip()) in vals_set

    def _u(x):
        return str(x).strip().upper()

    predicates = []

    if "vehicle_carrier" in filters:
        p = keep_in("vehicle_carrier", "vehicle_carrier")
        if p:
            predicates.append(p)
    if "orig_country" in filters:
        p = keep_in("orig_country", "orig_country")
        if p:
            predicates.append(p)
    if "vehicle_execution_status" in filters:
        p = keep_in("vehicle_execution_status", "vehicle_execution_status")
        if p:
            predicates.append(p)
    if "shippername" in filters:
        names = [s.strip() for s in _get_values(filters, "shippername") if s.strip()]
        if names:
            names_set = set(names)
            predicates.append(lambda r: str(r.get("shippername") or "").strip() in names_set)
    if "orig_node" in filters:
        p = keep_in("orig_node", "orig_node")
        if p:
            predicates.append(p)
    if "dest_node" in filters:
        p = keep_in("dest_node", "dest_node")
        if p:
            predicates.append(p)
    if "shipper_account" in filters:
        p = keep_in("shipper_account", "shipper_account")
        if p:
            predicates.append(p)

    if filters.get("orig_planned_yard_checkin_time_today"):
        today = datetime.today().date()
        predicates.append(
            lambda r: _parse_date(r.get("orig_planned_yard_checkin_time")) == today
        )

    if "is_manual_source" in filters:
        want = _truthy(filters.get("is_manual_source"))
        predicates.append(lambda r: bool(_truthy(r.get("is_manual_source"))) == want)

    if "email_sent_confirmed_at" in filters:
        want = _truthy(filters.get("email_sent_confirmed_at"))
        predicates.append(
            lambda r: bool(r.get("email_sent_confirmed_at")) == want
        )

    if "email_sent" in filters:
        want = _truthy(filters.get("email_sent"))
        predicates.append(lambda r: bool(_truthy(r.get("email_sent"))) == want)

    # date range on orig planned checkin
    start_date = filters.get("start_date")
    end_date = filters.get("end_date")
    if start_date:
        sd = _parse_date(start_date)
        if sd:
            predicates.append(
                lambda r, sd=sd: (_parse_date(r.get("orig_planned_yard_checkin_time")) or None)
                and _parse_date(r.get("orig_planned_yard_checkin_time")) >= sd
            )
    if end_date:
        ed = _parse_date(end_date)
        if ed:
            predicates.append(
                lambda r, ed=ed: (_parse_date(r.get("orig_planned_yard_checkin_time")) or None)
                and _parse_date(r.get("orig_planned_yard_checkin_time")) <= ed
            )

    # manual-source week (Sunday–Saturday) on manual_source_date
    week_start_raw = filters.get("manual_source_week_start")
    week_iso = filters.get("manual_source_week")
    week_range = None
    if week_start_raw:
        try:
            parsed = parse_any_date(week_start_raw).date()
            ws = parsed - timedelta(days=(parsed.weekday() + 1) % 7)
            week_range = (ws, ws + timedelta(days=6))
        except (ValueError, TypeError):
            week_range = None
    elif week_iso:
        try:
            wy, wn = week_iso.split("-W")
            iso_mon = datetime.fromisocalendar(int(wy), int(wn), 1).date()
            ws = iso_mon - timedelta(days=1)
            week_range = (ws, ws + timedelta(days=6))
        except (ValueError, TypeError):
            week_range = None
    if week_range:
        ws, we = week_range
        predicates.append(
            lambda r: (_parse_date(r.get("manual_source_date")) is not None)
            and ws <= _parse_date(r.get("manual_source_date")) <= we
        )

    filtered = [r for r in rows if all(p(r) for p in predicates)]
    return _finalize(filtered)


def _finalize(rows):
    """Return plain dicts (already JSON-friendly)."""
    return [dict(r) for r in rows]


# ── manual-source toggle ───────────────────────────────────────────────────────
def toggle_manual_source(data=None):
    if data is None:
        data = request.get_json()

    vrid = data.get("vrid")
    new_value = bool(data.get("value", False))
    sims = data.get("sims")
    ms_cost = data.get("ms_cost")
    username = get_logged_in_user()

    if not vrid:
        return jsonify({"status": "error", "message": "VRID is required"}), 400
    if new_value and not sims:
        return jsonify({
            "status": "error",
            "message": "SIMS is required when enabling manual source",
        }), 400

    try:
        runs = store.load_runs()
        ms = store.load_ms()
        vrid = str(vrid).strip()
        now_iso = datetime.utcnow().isoformat()

        matched = [r for r in runs if str(r.get("vrid") or "").strip() == vrid]
        for r in matched:
            r["is_manual_source"] = 1 if new_value else 0
            r["sims"] = sims if new_value else None
            r["ms_cost"] = ms_cost if new_value else None
            r["manual_source_by"] = username if new_value else None
            if new_value and not r.get("manual_source_date"):
                r["manual_source_date"] = now_iso

        if new_value:
            # snapshot each matched run into ms_runs (upsert by vrid+orderid)
            ms_index = store.index_by_key(ms)
            for r in matched:
                snap = {k: r.get(k) for k in MS_SNAPSHOT_FIELDS}
                snap["orderid"] = r.get("orderid")
                snap["vrid"] = r.get("vrid")
                snap["is_manual_source"] = 1
                snap["sims"] = sims
                snap["ms_cost"] = ms_cost
                snap["manual_source_by"] = username
                snap.setdefault("manual_source_date", r.get("manual_source_date") or now_iso)
                ms_index[store.row_key(snap)] = snap
            store.save_ms(list(ms_index.values()))
        else:
            # remove snapshot(s) for this vrid
            ms = [r for r in ms if str(r.get("vrid") or "").strip() != vrid]
            store.save_ms(ms)

        store.save_runs(runs)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ── email toggles ───────────────────────────────────────────────────────────────
def _apply_email_sent(rows, vrid, username, sent: bool):
    for r in rows:
        if str(r.get("vrid") or "").strip() != vrid:
            continue
        if sent:
            already = bool(_truthy(r.get("email_sent")))
            r["email_sent"] = True
            if not already:
                r["email_sent_count"] = int(r.get("email_sent_count") or 0) + 1
                r["email_sent_confirmed_at"] = datetime.utcnow().isoformat()
            r["email_sent_by"] = username
        else:
            r["email_sent"] = False


def toggle_email_sent(data=None):
    if data is None:
        data = request.get_json()
    vrid = data.get("vrid")
    new_value = _truthy(data.get("value", False))
    username = get_logged_in_user()

    if not vrid:
        return jsonify({"status": "error", "message": "VRID is required"}), 400

    try:
        vrid = str(vrid).strip()
        runs = store.load_runs()
        ms = store.load_ms()
        _apply_email_sent(runs, vrid, username, new_value)
        _apply_email_sent(ms, vrid, username, new_value)
        store.save_runs(runs)
        store.save_ms(ms)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def mark_emails_sent(vrids: list[str]):
    if not vrids:
        return jsonify({"status": "error", "message": "No VRIDs provided"}), 400
    username = get_logged_in_user()
    try:
        vrid_set = {str(v).strip() for v in vrids if str(v).strip()}
        runs = store.load_runs()
        ms = store.load_ms()
        for v in vrid_set:
            _apply_email_sent(runs, v, username, True)
            _apply_email_sent(ms, v, username, True)
        store.save_runs(runs)
        store.save_ms(ms)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def mark_emails_generated(vrids: list[str]):
    if not vrids:
        return jsonify({"status": "error", "message": "No VRIDs provided"}), 400
    username = get_logged_in_user()
    try:
        vrid_set = {str(v).strip() for v in vrids if str(v).strip()}
        now_iso = datetime.utcnow().isoformat()

        def apply(rows):
            for r in rows:
                if str(r.get("vrid") or "").strip() in vrid_set:
                    r["email_sent"] = False
                    r["email_sent_by"] = username
                    r["email_sent_confirmed_at"] = None
                    r["email_generated_at"] = now_iso

        runs = store.load_runs()
        ms = store.load_ms()
        apply(runs)
        apply(ms)
        store.save_runs(runs)
        store.save_ms(ms)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ── distinct dropdown helpers ─────────────────────────────────────────────────
def get_distinct_values(column: str) -> list[str]:
    seen = []
    seen_set = set()
    for r in store.load_runs():
        val = r.get(column)
        if val is None or str(val).strip() == "":
            continue
        if val not in seen_set:
            seen_set.add(val)
            seen.append(val)
    return sorted(seen, key=lambda x: str(x))


def distinct_countries():
    return get_distinct_values("orig_country")


def distinct_execution_status():
    return get_distinct_values("vehicle_execution_status")


def distinct_vehicle_carriers():
    return get_distinct_values("vehicle_carrier")


def distinct_shippers():
    return get_distinct_values("shippername")


def distinct_orig_nodes():
    return get_distinct_values("orig_node")


def distinct_dest_nodes():
    return get_distinct_values("dest_node")
