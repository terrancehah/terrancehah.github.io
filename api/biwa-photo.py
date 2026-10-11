"""GET /api/biwa-photo?placeId=<internal>&index=<n>&width=<px> — photo proxy.

Serves one Google Places photo by internal place id and bounded index. The
flow is: current photo metadata for the place → photo media endpoint with
skipHttpRedirect → the returned photoUri is fetched ONLY when its host is a
Google photo domain over HTTPS (no API key is forwarded there) → bytes are
returned with a hard 4 MB cap and no-store headers. The client can never
supply a photo resource name or arbitrary URL.
"""

import importlib.util
import os
import sys

from fastapi import Request
from fastapi.responses import Response

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

app = biwa_store.create_biwa_app("biwa-photo")
store = biwa_store.BiwaStore()

MAX_INDEX = 9          # photo summaries are capped at 10 per place
MIN_WIDTH, MAX_WIDTH = 64, 1600


def _no_store_image(content, media_type):
    return Response(content=content, media_type=media_type,
                    headers={"Cache-Control": "private, no-store"})


@app.get("/")
async def get_photo(request: Request):
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked
    if not biwa_store.check_dual_rate_limit(
        request, store, "photo", biwa_store.PHOTO_RATE_LIMIT
    ):
        return biwa_store.json_error(429, "rate_limited", "Too many photo requests — wait a minute.")

    place_id = request.query_params.get("placeId")
    problems = biwa_models.validate_place_query(place_id)
    if problems:
        return biwa_store.json_error(422, "invalid_request", "; ".join(problems))

    try:
        index = int(request.query_params.get("index", "0"))
    except ValueError:
        index = -1
    if not 0 <= index <= MAX_INDEX:
        return biwa_store.json_error(422, "invalid_request", "index out of range")
    try:
        width = int(request.query_params.get("width", "800"))
    except ValueError:
        width = 800
    width = min(max(width, MIN_WIDTH), MAX_WIDTH)

    if not biwa_store.GOOGLE_PLACES_KEY:
        return biwa_store.json_error(503, "not_configured",
                                     "Photos are not configured on this deployment.")

    trip = None
    if store.configured:
        trip, _raw = store.get_trip()
    place = biwa_places.find_trip_place(place_id, biwa_models.CANONICAL, trip)
    if place is None:
        return biwa_store.json_error(404, "unknown_place", "No such place.")

    # Same resolution chain as /biwa-place: checkpoints without a stored
    # Google id still resolve through the vicinity-checked searchText path,
    # so their provider photos are servable too — and the policy-limited
    # cache can shortcut that search exactly as on /biwa-place.
    cached_id = biwa_google_cache.cached_google_id(store, place)
    details, _resolved_by = biwa_places.resolve_place_details(
        place, biwa_store.GOOGLE_PLACES_KEY, cached_id=cached_id)
    if details is None:
        return biwa_store.json_error(404, "no_photos",
                                     "This place has no Google photos.")
    # The resolve may have surfaced a search-discovered id/coordinates —
    # persist only what the policy allows (id + lat/lng); photo metadata and
    # bytes are never cached.
    biwa_google_cache.save_resolution(
        store, place, biwa_places.normalize_details(details))
    photos = details.get("photos") or []
    if index >= len(photos):
        return biwa_store.json_error(404, "no_photos",
                                     "No photo at this index.")
    photo_name = photos[index].get("name")
    if not isinstance(photo_name, str) or not photo_name.startswith("places/"):
        return biwa_store.json_error(502, "provider_error",
                                     "Photo metadata was unusable.")

    # Ask for the redirect target instead of following it, then verify the
    # image host before downloading anything.
    try:
        status, media = biwa_places._http_get(
            biwa_places.photo_media_url(photo_name, biwa_store.GOOGLE_PLACES_KEY, width))
    except Exception:
        return biwa_store.json_error(502, "provider_error",
                                     "Photo provider request failed.")
    if status != 200 or not isinstance(media, dict):
        return biwa_store.json_error(502, "provider_error",
                                     "Photo provider request failed.")
    photo_uri = media.get("photoUri")
    if not isinstance(photo_uri, str) or not biwa_places.allowed_photo_host(photo_uri):
        return biwa_store.json_error(502, "provider_error",
                                     "Photo provider returned an unexpected location.")
    try:
        img_status, content_type, data = biwa_places._http_get_bytes(photo_uri)
    except Exception:
        return biwa_store.json_error(502, "provider_error",
                                     "Photo download failed.")
    if img_status != 200 or len(data) > biwa_places.MAX_IMAGE_BYTES:
        return biwa_store.json_error(502, "provider_error",
                                     "Photo download failed.")
    return _no_store_image(data, content_type)
