from flask import Flask
from .config import Config
from .extensions import init_extensions


def create_app():
    app = Flask(
        __name__,
        template_folder="templates",
        static_folder="static",
    )

    app.config.from_object(Config)
    init_extensions(app)

    # blueprints — manual sourcing only (free for all, no auth)
    from .runs.routes import runs_bp
    from .sync_status.routes import sync_status_bp
    from .pages import pages_bp

    app.register_blueprint(runs_bp)
    app.register_blueprint(sync_status_bp)
    app.register_blueprint(pages_bp)

    return app
