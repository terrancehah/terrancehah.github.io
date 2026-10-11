"""GET /api/biwa-place?placeId=<internal> — transient Google place details.

Resolves OUR internal place id (manifest first, then the current trip's
custom places), then calls Places (New) with the server key. Raw Google
place ids are never accepted from the client, so this is not an open proxy.
Checkpoints without a verified Google id fall back to an on-demand
searchText lookup whose candidate must sit within 2 km of the source
coordinates; otherwise the answer is an honest 'unavailable' with the
place's own source info. Provider data is transient — returned no-store and
never persisted.
"""

import importlib.util
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
biwa_places = biwa_store.load_biwa_module("biwa-places")
biwa_google_cache = biwa_store.load_biwa_module("biwa-google-cache")

app = biwa_store.create_biwa_app("biwa-place")
store = biwa_store.BiwaStore()


def _current_trip():
    if not store.configured:
        return None
    trip, _raw = store.get_trip()
    return trip


@app.get("/")
async def get_place(request: Request):
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked
    if not biwa_store.check_dual_rate_limit(
        request, store, "places", biwa_store.PLACES_RATE_LIMIT
    ):
        return biwa_store.json_error(429, "rate_limited", "Too many place lookups — wait a minute.")

    place_id = request.query_params.get("placeId")
    problems = biwa_models.validate_place_query(place_id)
    if problems:
        return biwa_store.json_error(422, "invalid_request", "; ".join(problems))

    if not biwa_store.GOOGLE_PLACES_KEY:
        return biwa_store.json_error(503, "not_configured",
                                     "Place details are not configured on this deployment.")

    place = biwa_places.find_trip_place(place_id, biwa_models.CANONICAL, _current_trip())
    if place is None:
        return biwa_store.json_error(404, "unknown_place", "No such place.")

    source_info = {
        "placeId": place["placeId"],
        "label": place.get("label"),
        "address": place.get("address"),
        "hasSourceCoordinates": isinstance(place.get("lat"), (int, float))
        and isinstance(place.get("lng"), (int, float)),
        "resolvedBy": None,
    }

    # Resolution lives in biwa-places so /biwa-photo resolves searchText
    # candidates identically — a place without a stored Google id can still
    # serve its provider photos. The policy-limited cache (Google id +
    # lat/lng only, see biwa-google-cache) can shortcut the search step and
    # is always tried BEFORE falling back to a fresh lookup.
    cached_id = biwa_google_cache.cached_google_id(store, place)
    body, resolved_by = biwa_places.resolve_place_details(
        place, biwa_store.GOOGLE_PLACES_KEY, cached_id=cached_id)
    source_info["resolvedBy"] = resolved_by

    if body is None:
        # Live details failed — the ONLY provider data we may still surface
        # is the policy-cached lat/lng (Google's 30-day allowance), exposed
        # separately from details so it is never mistaken for place content.
        source_info["cachedLocation"] = biwa_google_cache.cached_location(store, place)
        return biwa_store.json_ok({
            "ok": True,
            "details": None,
            "source": source_info,
            "reason": "details_unavailable",
        })

    details = biwa_places.normalize_details(body)
    # Successful live resolve — persist only the id/coordinates the Google
    # caching policy allows; every other detail field stays transient.
    biwa_google_cache.save_resolution(store, place, details)

    return biwa_store.json_ok({
        "ok": True,
        "details": details,
        "source": source_info,
    })
