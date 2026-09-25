from flask import Blueprint, render_template, redirect, url_for

pages_bp = Blueprint("pages", __name__)


@pages_bp.get("/")
def index():
    # Free for all — no login. Land straight on manual sourcing.
    return redirect(url_for("pages.manual_sourcing"))


@pages_bp.get("/all-runs")
def all_runs():
    return render_template("all-runs.html")


@pages_bp.get("/manual-sourcing")
def manual_sourcing():
    return render_template("manual-sourcing.html")


@pages_bp.get("/manual-sourced-runs")
def manual_sourced_runs():
    return render_template("manual-sourced-runs.html")
