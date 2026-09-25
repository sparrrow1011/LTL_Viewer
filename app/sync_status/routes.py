from flask import Blueprint, jsonify

from .service import get_all_statuses

sync_status_bp = Blueprint("sync_status", __name__, url_prefix="/api")


@sync_status_bp.get("/sync-status")
def sync_status():
    return jsonify(get_all_statuses())
