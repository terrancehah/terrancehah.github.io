"""GET/PUT /api/biwa-trip — personal per-owner trip state.

The trip is personal: every request carries X-Biwa-Owner ('dev:<uuid>' —
minted client-side, later a provider subject once auth lands) and trips
live at biwa:v2:owner:<id>:trip with no TTL. GET returns that owner's
snapshot (or null when they have never saved — the client then seeds from
its static trip-seed.json) plus capability flags and the
referrer-restricted browser Maps key. PUT accepts {expectedRevision, trip}
and applies it only through the store's atomic compare-and-set against the
owner key: a stale writer gets 409 plus the latest state, never a silent
last-write-wins. Mutations are origin-guarded and rate-limited per IP.
"""

import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse

# Add api/ to sys.path, then load the kebab-case helpers by file path (module
# names follow the repo convention so `import` syntax cannot reach them).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(_HERE)


def _load(module_key, path):
    if module_key in sys.modules:
        return sys.modules[module_key]
    spec = importlib.util.spec_from_file_location(module_key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


biwa_store = _load("biwa_store", os.path.join(os.path.dirname(_HERE), "lib", "biwa", "biwa-store.py"))
biwa_models = biwa_store.load_biwa_module("biwa-models")
# The pairing handler lives in lib/ (it is not a function of its own) and is
# mounted below — see the @app.post("/api/biwa-trip/pair") route.
biwa_pair = biwa_store.load_biwa_module("biwa-pair")

app = biwa_store.create_biwa_app("biwa-trip")
store = biwa_store.BiwaStore()


@app.get("/")
async def get_trip(request: Request):
    """Return the caller's snapshot plus capability flags for the client.

    An owner identity is required to read a trip: without one there is no
    doc to serve — 401 'owner_required' sends the client to its local
    fallback, matching the existing guard-response path. Capabilities and
    the browser Maps key are still returned to anyone (they are not trip
    data) so the static seed and map load even mid-401.
    """
    owner = biwa_store.owner_from_request(request)
    if not owner:
        # No identity header → there is no doc to serve. The client's
        # existing guard-response path treats 401 as 'local seed/draft
        # only', which is exactly right for a caller with no identity.
        return biwa_store.json_error(401, "owner_required",
                                     "Send X-Biwa-Owner to read a trip.")
    trip = None
    if store.configured:
        trip, _raw = store.get_trip(biwa_store.owner_trip_key(owner))
    response = {
        "ok": True,
        "trip": trip,
        "sharingAvailable": store.configured,
        "capabilities": {
            # browserMapsKey is public-by-design (HTTP-referrer restricted);
            # routes/elevation/places/photos stay server-side and require a
            # configured backend for rate limiting.
            "mapsBrowser": bool(biwa_store.GOOGLE_BROWSER_KEY),
            "routes": bool(biwa_store.GOOGLE_SERVER_KEY) and store.configured,
            "elevation": bool(biwa_store.GOOGLE_SERVER_KEY) and store.configured,
            "places": bool(biwa_store.GOOGLE_PLACES_KEY) and store.configured,
            "photos": bool(biwa_store.GOOGLE_PLACES_KEY) and store.configured,
        },
    }
    if biwa_store.GOOGLE_BROWSER_KEY:
        response["browserMapsKey"] = biwa_store.GOOGLE_BROWSER_KEY
    # Mint/refresh the HttpOnly owner cookie so header-less <img src> photo
    # requests can resolve this owner's custom places (biwa-photo reads it).
    # It carries the same bearer capability the header already is — never
    # write auth. SameSite=Strict keeps it off cross-site requests; Secure
    # follows the actual request scheme (x-forwarded-proto is the reliable
    # signal on the real deployment where TLS terminates at the edge).
    response_obj = biwa_store.json_ok(response)
    secure = request.url.scheme == "https" or \
        request.headers.get("x-forwarded-proto") == "https"
    response_obj.set_cookie(
        biwa_store.OWNER_COOKIE_NAME, owner,
        httponly=True, samesite="strict", path="/", secure=secure)
    return response_obj


@app.put("/")
async def put_trip(request: Request):
    """Compare-and-set write of a full validated snapshot for one owner."""
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked

    owner = biwa_store.owner_from_request(request)
    if not owner:
        return biwa_store.json_error(401, "owner_required",
                                     "Send X-Biwa-Owner to write a trip.")

    if not store.check_rate_limit(
        "trip-write:" + biwa_store.client_scope(request),
        biwa_store.WRITE_RATE_LIMIT,
    ):
        return biwa_store.json_error(429, "rate_limited", "Too many writes — wait a minute.")

    raw_body = await request.body()
    if len(raw_body) > biwa_store.MAX_BODY_BYTES:
        return biwa_store.json_error(413, "too_large", "Trip payload is too large.")
    try:
        body = json.loads(raw_body)
    except ValueError:
        return biwa_store.json_error(400, "bad_json", "Request body is not valid JSON.")

    if not isinstance(body, dict) or "trip" not in body or "expectedRevision" not in body:
        return biwa_store.json_error(400, "bad_request",
                                     "Body must contain expectedRevision and trip.")
    expected = body["expectedRevision"]
    # bool is an int subclass — True/False must not pass as a revision.
    if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
        return biwa_store.json_error(400, "bad_request", "expectedRevision must be a non-negative integer.")

    trip = body["trip"]
    problems = biwa_models.validate_trip(trip)
    if problems:
        return biwa_store.json_error(422, "invalid_trip", "; ".join(problems[:8]))

    # The server owns revision/time: stamp the next revision and write it
    # atomically only if the stored revision still matches the client's.
    trip = dict(trip)
    trip["revision"] = expected + 1
    trip["updatedAt"] = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(trip, ensure_ascii=False)

    ok, current_raw = store.cas_trip(expected, payload,
                                     key=biwa_store.owner_trip_key(owner))
    if not ok:
        latest = None
        if current_raw:
            try:
                latest = json.loads(current_raw)
            except ValueError:
                latest = None
        content = {"ok": False, "error": "conflict",
                   "message": "The trip changed since you loaded it.", "trip": latest}
        return JSONResponse(status_code=409, headers=biwa_store.PRIVATE_CACHE_HEADERS,
                            content=content)

    return biwa_store.json_ok({"ok": True, "revision": trip["revision"], "updatedAt": trip["updatedAt"]})


# Pairing was a standalone function (api/biwa-pair.py) until it pushed the
# deploy past the 12-function cap; it is now a lib/ helper mounted here.
# vercel.json rewrites the public POST /api/biwa-pair URL — and its
# /projects/biwa-ride/api/biwa-pair alias — to /api/biwa-trip/pair. The
# prefix-strip middleware only collapses a path ENDING in /biwa-trip, so
# sub-paths arrive intact; and because the runtime may hand the function the
# ORIGINAL request path rather than the rewritten destination, the same
# handler is registered on every path it could plausibly see.
@app.post("/api/biwa-trip/pair")
@app.post("/api/biwa-pair")
@app.post("/projects/biwa-ride/api/biwa-pair")
@app.post("/pair")
async def pair(request: Request):
    """Pairing-code lifecycle: 'create' mints, 'claim' resolves."""
    return await biwa_pair.pair(request, store)
