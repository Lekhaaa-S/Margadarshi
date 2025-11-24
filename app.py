"""Composite Flask runner

Run this file to serve all three apps together:
- quiz app mounted at the site root (/)
- chat app mounted at /chat
- study app mounted at /study

Usage:
    python app.py

This file uses Werkzeug's DispatcherMiddleware to compose the existing Flask
applications defined in `quiz.py`, `chat.py`, and `study.py` without modifying
those modules.
"""
import logging
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple
import os, json, base64
from firebase_admin import credentials, initialize_app

sa_b64 = os.environ.get("SERVICE_ACCOUNT_JSON")
if sa_b64:
    try:
        sa_json = json.loads(base64.b64decode(sa_b64).decode('utf-8'))
        cred = credentials.Certificate(sa_json)
        initialize_app(cred)
        print("Firebase admin initialized from SERVICE_ACCOUNT_JSON")
    except Exception as e:
        print("Failed to init firebase admin from SERVICE_ACCOUNT_JSON:", e)
else:
    # fallback: either use local file (only for dev) or raise
    local_path = os.path.join(os.getcwd(), 'serviceAccountKey.json')
    if os.path.exists(local_path):
        cred = credentials.Certificate(local_path)
        initialize_app(cred)
        print("Firebase admin initialized from local serviceAccountKey.json")
    else:
        print("No service account available; continuing without firebase_admin")


try:
    # Import the existing Flask apps defined in the repository
    from quiz import app as quiz_app
except Exception as e:
    raise RuntimeError("Failed to import quiz app: {}".format(e))

try:
    from chat import app as chat_app
except Exception as e:
    raise RuntimeError("Failed to import chat app: {}".format(e))

try:
    from study import app as study_app
except Exception as e:
    raise RuntimeError("Failed to import study app: {}".format(e))

try:
    from summarizer import app as summarizer_app
except Exception as e:
    # Summarizer is optional; log and continue if it fails to import
    raise RuntimeError("Failed to import summarizer app: {}".format(e))

LOG = logging.getLogger("composed-app")
logging.basicConfig(level=logging.INFO)


def make_app():
    """Compose apps and return a WSGI application."""
    # We mount the quiz app at the root so its existing service-worker and
    # static routes continue to work unchanged. Chat and Study are mounted
    # under prefixes to avoid route collisions.
    mounts = {
        '/chat': chat_app,
        '/study': study_app,
        # also allow explicit /quiz prefix if useful
        '/quiz': quiz_app,
        '/summarizer': summarizer_app,
    }
    app = DispatcherMiddleware(quiz_app, mounts)
    return app


if __name__ == "__main__":
    wsgi_app = make_app()
    # run_simple provides a convenient development server that accepts a WSGI app
    LOG.info("Starting composed server on http://0.0.0.0:5000 ...")
    run_simple('0.0.0.0', 5000, wsgi_app, use_reloader=True, use_debugger=True)
