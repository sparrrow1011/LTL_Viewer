import threading

import webview

from app import create_app
from desktop.api import Api


def run_flask():
    create_app().run(port=9000)


api = Api()
threading.Thread(target=run_flask, daemon=True).start()

window = webview.create_window(
    "LTL Manual Sourcing Viewer",
    "http://127.0.0.1:9000",
    width=1400,
    height=800,
    js_api=api,
)

webview.start()
