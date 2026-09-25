from flask import Flask


def init_extensions(app: Flask):
    """Initialise Flask extensions. Kept minimal — no auth, no DB."""
    app.secret_key = app.config["SECRET_KEY"]
