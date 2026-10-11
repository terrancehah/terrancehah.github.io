"""POST /api/biwa-route — public road-route preview.

Accepts {dayId, orderedCoordinates, requestId}, validates bounds (2..27
locations — each either numeric lat/lng or a Google place id), origin-guards
and rate-limits provider spend, then calls Google Routes with the
server-restricted key. The response carries the encoded polyline, metric
distance and per-leg distances plus an elevation block that reports
'unavailable' whenever the elevation provider cannot answer — the lead
authors the sampling recipe in lib/biwa/biwa-routing.py:sampled_terrain_ascent.

NOTE (post-handoff): the sampled-terrain recipe is now implemented in
biwa-routing.py by the lead, so the elevation block reports real sampled
ascent when the provider key is configured; 'unavailable' remains the
honest fallback for missing keys or provider failures.
"""

import importlib.util
import json
import os
import sys

from fastapi import Request

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
biwa_routing = biwa_store.load_biwa_module("biwa-routing")

app = biwa_store.create_biwa_app("biwa-route")
store = biwa_store.BiwaStore()


@app.post("/")
async def post_route(request: Request):
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked

    # Provider calls cost money — keep the spend budget tight even though
    # the endpoint is public.
    if not store.check_rate_limit(
        "route:" + biwa_store.client_scope(request),
        biwa_store.ROUTE_RATE_LIMIT,
    ):
        return biwa_store.json_error(429, "rate_limited", "Too many route requests — wait a minute.")

    raw_body = await request.body()
    if len(raw_body) > biwa_store.MAX_BODY_BYTES:
        return biwa_store.json_error(413, "too_large", "Route payload is too large.")
    try:
        body = json.loads(raw_body)
    except ValueError:
        return biwa_store.json_error(400, "bad_json", "Request body is not valid JSON.")

    problems = biwa_models.validate_route_request(body)
    if problems:
        return biwa_store.json_error(422, "invalid_request", "; ".join(problems[:8]))

    route = biwa_routing.compute_route(body["orderedCoordinates"], biwa_store.GOOGLE_SERVER_KEY)
    if not route.get("ok"):
        status = 503 if route.get("error") == "not_configured" else 502
        return biwa_store.json_error(status, route.get("error", "route_unavailable"),
                                     route.get("message", "Route preview unavailable."))

    # Elevation seam: always 'unavailable' until the lead authors
    # sampled_terrain_ascent. A valid route/distance is returned regardless.
    # NOTE (post-handoff): implemented by the lead; this call now returns
    # real sampled ascent and only reports 'unavailable' on missing keys or
    # provider failure — a failed elevation never discards the route above.
    elevation = biwa_routing.sampled_terrain_ascent(
        route["polyline"], biwa_store.GOOGLE_SERVER_KEY
    )

    return biwa_store.json_ok({
        "ok": True,
        "requestId": body["requestId"],
        "dayId": body["dayId"],
        "route": {
            "polyline": route["polyline"],
            "distanceMeters": route["distanceMeters"],
            "legsMeters": route["legsMeters"],
        },
        "elevation": elevation,
        "caveat": "Road preview, not cycling guidance. Avoidance is a preference, not a guarantee.",
    })
