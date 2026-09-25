from flask import Blueprint, request, jsonify
import threading

from .services import (
    get_rows,
    toggle_manual_source,
    toggle_email_sent,
    distinct_countries,
    distinct_execution_status,
    distinct_vehicle_carriers,
    distinct_shippers,
    distinct_orig_nodes,
    distinct_dest_nodes,
    mark_emails_sent,
    mark_emails_generated,
)

runs_bp = Blueprint("runs", __name__, url_prefix="/api")


@runs_bp.get("/data")
def data():
    return jsonify(get_rows(request.args))


# Auth is disabled (free for all); keep a stub so the base template's
# header JS doesn't error out.
@runs_bp.get("/auth/status")
def auth_status():
    return jsonify({"authenticated": False, "user": None, "role": None})


@runs_bp.post("/auth/logout")
def auth_logout():
    return jsonify({"success": True})


@runs_bp.post("/toggle-manual-source")
def toggle_ms():
    return toggle_manual_source(request.json)


@runs_bp.post("/toggle-email-sent")
def toggle_email():
    return toggle_email_sent(request.json)


@runs_bp.post("/run-smc")
def run_smc():
    """Kick off an SMC scrape + JSON update in the background."""
    def _full_smc_update():
        from scrapers.smc import run_smc_export
        from scripts.smc_update import update_cst_fields_from_json
        orders = run_smc_export()
        if orders:
            update_cst_fields_from_json(orders)
    threading.Thread(target=_full_smc_update, daemon=True).start()
    return {"status": "started"}


@runs_bp.post("/update-db")
def update_db_route():
    """Trigger a background refresh from the ltl_ms_job.txt ingest file."""
    def _update():
        from scripts.update_db import update_runs_from_txt
        update_runs_from_txt()
    threading.Thread(target=_update, daemon=True).start()
    return jsonify({"success": True, "message": "Data update started"})


@runs_bp.post("/email/mark-sent")
def email_mark_sent():
    data = request.get_json() or {}
    return mark_emails_sent(data.get("vrids", []))


@runs_bp.post("/email/mark-generated")
def email_mark_generated():
    data = request.get_json() or {}
    return mark_emails_generated(data.get("vrids", []))


@runs_bp.get("/filters/countries")
def countries():
    return jsonify(distinct_countries())


@runs_bp.get("/distinct/countries")
def countries_legacy():
    return jsonify(distinct_countries())


@runs_bp.get("/filters/execution-status")
def execution_status():
    return jsonify(distinct_execution_status())


@runs_bp.get("/distinct/execution-status")
def execution_status_legacy():
    return jsonify(distinct_execution_status())


@runs_bp.get("/filters/carriers")
def vehicle_carriers():
    return jsonify(distinct_vehicle_carriers())


@runs_bp.get("/filters/shippers")
def shippers():
    return jsonify(distinct_shippers())


@runs_bp.get("/distinct/shipper")
def shippers_legacy():
    return jsonify(distinct_shippers())


@runs_bp.get("/filters/orig-nodes")
def orig_nodes():
    return jsonify(distinct_orig_nodes())


@runs_bp.get("/distinct/orig-nodes")
def orig_nodes_legacy():
    return jsonify(distinct_orig_nodes())


@runs_bp.get("/filters/dest-nodes")
def dest_nodes():
    return jsonify(distinct_dest_nodes())


@runs_bp.get("/distinct/dest-nodes")
def dest_nodes_legacy():
    return jsonify(distinct_dest_nodes())
