"""Local development runner for the Biwa APIs — NOT a Vercel endpoint.

The legacy `api.index` startup referenced by start-dev.sh/package.json is
broken and left untouched. For the Biwa app run this isolated runner instead:

    BIWA_DEV_ALLOW_MEMORY=1 venv/bin/python -c "
    import importlib.util, sys, uvicorn
    spec = importlib.util.spec_from_file_location('biwa_dev', 'lib/biwa/biwa-dev.py')
    m = importlib.util.module_from_spec(spec); sys.modules['biwa_dev'] = m
    spec.loader.exec_module(m)
    uvicorn.run(m.app, host='127.0.0.1', port=8000, log_level='warning')
    "

then proxy-server.js forwards /projects/biwa-ride/api/biwa-* to it. The app
is public — no trip token. With BIWA_DEV_ALLOW_MEMORY=1 the store uses an
in-memory dict (dev only — the fail-closed rule still applies in every other
configuration) and rate limits work against it. Google keys are read from
.env.local (gitignored). To exercise the real Redis path, export
BIWA_REDIS_REST_URL/BIWA_REDIS_REST_TOKEN from a dedicated database instead.

The module lives under lib/biwa/ — outside api/ entirely — so Vercel's
function discovery never picks it up as a serverless function.
"""

import importlib.util
import os
import sys

from fastapi import FastAPI

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_API_DIR = os.path.join(_ROOT, "api")

# Load .env/.env.local for local convenience (production envs provide real
# variables; python-dotenv is already a project dependency).
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_ROOT, ".env"))
    load_dotenv(os.path.join(_ROOT, ".env.local"), override=True)
except ImportError:
    pass


def _load(module_key, path):
    if module_key in sys.modules:
        return sys.modules[module_key]
    spec = importlib.util.spec_from_file_location(module_key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


# Each endpoint module exposes its handler coroutines; registering them
# directly avoids the mount-level trailing-slash redirect a nested ASGI app
# would produce for /api/biwa-trip.
biwa_trip = _load("biwa_trip_endpoint", os.path.join(_API_DIR, "biwa-trip.py"))
biwa_pair = _load("biwa_pair_endpoint", os.path.join(_API_DIR, "biwa-pair.py"))
biwa_route = _load("biwa_route_endpoint", os.path.join(_API_DIR, "biwa-route.py"))
biwa_place = _load("biwa_place_endpoint", os.path.join(_API_DIR, "biwa-place.py"))
biwa_photo = _load("biwa_photo_endpoint", os.path.join(_API_DIR, "biwa-photo.py"))

app = FastAPI(title="biwa-dev")
app.add_api_route("/api/biwa-trip", biwa_trip.get_trip, methods=["GET"])
app.add_api_route("/api/biwa-trip", biwa_trip.put_trip, methods=["PUT"])
app.add_api_route("/api/biwa-pair", biwa_pair.pair, methods=["POST"])
app.add_api_route("/api/biwa-route", biwa_route.post_route, methods=["POST"])
app.add_api_route("/api/biwa-place", biwa_place.get_place, methods=["GET"])
app.add_api_route("/api/biwa-photo", biwa_photo.get_photo, methods=["GET"])


@app.get("/api/biwa-health")
async def biwa_health():
    """Unauthenticated liveness probe for the dev runner (no secrets)."""
    return {
        "ok": True,
        "storeConfigured": biwa_trip.store.configured,
    }
