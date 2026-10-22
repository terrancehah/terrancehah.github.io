"""GET /api/biwa-photo?placeId=<internal>&index=<n>&width=<px> — photo proxy.

Serves one Google Places photo by internal place id and bounded index. The
flow is: cached image bytes (30-day window, no Google call at all) → else
cached photo names (one media call only) → else a live details resolve
(the searchText/id chain shared with /biwa-place) whose photo names are
then cached → the photo media endpoint with skipHttpRedirect → the
returned photoUri is fetched ONLY when its host is a Google photo domain
over HTTPS (no API key is forwarded there) → bytes are capped at 4 MB,
stored for 30 days, and sent privately cacheable. The client can never
supply a photo resource name or arbitrary URL.
"""

import hashlib
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
# Private browser lifetime for image bytes — always additionally bounded
# by the Redis TTL still left on the cached entry.
BROWSER_PHOTO_TTL_S = 7 * 24 * 60 * 60


def _image_response(content, media_type, custom=False, max_age=None,
                    scope_valid=False):
    """Cache headers depend on which catalogue the place came from.

    Vary: Cookie rides on every image reply — the resolution path (and so
    the bytes) can differ by the owner cookie. A CUSTOM place id exists
    only inside one owner's doc: without a matching `scope` query (the
    non-auth sha256(owner) partition token) its bytes stay no-store —
    two owners could mint the same id with different photos, and a
    browser-private cache would leak one owner's photo under another's
    URL. With the matching scope the URL is owner-specific and may cache
    like a canonical image. Canonical places keep the private cache —
    the bytes are already stored server-side, so browser reuse costs
    nothing (`private` keeps shared caches out of it).
    """
    headers = {"Vary": "Cookie"}
    if custom and not scope_valid:
        headers["Cache-Control"] = "private, no-store"
    else:
        # A None max_age is the untouched day-private fallback; an explicit
        # 0 (cached entry with no usable Redis TTL left) stays 0 — an old
        # no-TTL record must never inherit a fresh browser cache grant.
        headers["Cache-Control"] = "private, max-age=" + str(
            max(0, int(max_age)) if max_age is not None else 86400)
    return Response(content=content, media_type=media_type, headers=headers)


@app.get("/")
async def get_photo(request: Request):
    blocked = biwa_store.guard_mutation(request, store)
    if blocked:
        return blocked
    # General read budget first — generous because cache hits cost no
    # Google call. The 20/min provider budget is checked only at the
    # moments an actual billed call is about to happen. A counter backend
    # failure answers 503, never a silent skip past abuse protection.
    try:
        read_ok = biwa_store.check_dual_rate_limit(
            request, store, "photo-read", biwa_store.CACHED_READ_RATE_LIMIT)
    except Exception:
        return biwa_store.json_error(503, "cache_unavailable",
                                     "Cached content is temporarily unavailable.")
    if not read_ok:
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

    # Custom places resolve from the CALLER's doc only — the owner header,
    # or the biwa-owner cookie GET /biwa-trip minted for <img src> loads
    # (a bearer capability, never write auth). The retired shared doc key
    # is never read. A backend failure on the owner read answers 503 —
    # never a fall-through that could disguise a cache problem as a miss.
    canonical_hit = (
        biwa_models.CANONICAL is not None and place_id in biwa_models.CANONICAL
    )
    trip = None
    owner = biwa_store.owner_from_header_or_cookie(request)
    if owner and store.configured:
        try:
            trip, _raw = store.get_trip(biwa_store.owner_trip_key(owner))
        except Exception:
            return biwa_store.json_error(503, "cache_unavailable",
                                         "Cached content is temporarily unavailable.")
    place = biwa_places.find_trip_place(place_id, biwa_models.CANONICAL, trip)
    if place is None:
        return biwa_store.json_error(404, "unknown_place", "No such place.")

    # Custom photo URLs carry a sha256(owner) `scope` so each owner's
    # browser caches under an owner-specific URL — a cache partition only,
    # NOT auth (the owner header/cookie still authorizes the bytes). The
    # raw owner id never enters a URL.
    scope_ok = False
    if not canonical_hit and owner:
        scope_ok = (
            request.query_params.get("scope")
            == hashlib.sha256(owner.encode("utf-8")).hexdigest()
        )

    # Cached image bytes answer with no provider call at all — repeat
    # views inside the 30-day window are free. STRICT read: a backend
    # error or corrupt entry fails closed (503) instead of disguising
    # itself as a miss that would spend a Google call. The browser
    # max-age is bounded by the Redis TTL still left on the entry.
    try:
        hit = biwa_google_cache.cached_photo(
            store, place, index, width, strict=True, with_ttl=True)
    except Exception:
        return biwa_store.json_error(503, "cache_unavailable",
                                     "Cached content is temporarily unavailable.")
    if hit is not None:
        return _image_response(hit[0], hit[1], custom=not canonical_hit,
                               max_age=min(BROWSER_PHOTO_TTL_S, hit[2]),
                               scope_valid=scope_ok)

    # Only a genuine cache MISS needs the provider key — a valid cached
    # image above serves even on a deployment with no Places key.
    if not biwa_store.GOOGLE_PLACES_KEY:
        return biwa_store.json_error(503, "not_configured",
                                     "Photos are not configured on this deployment.")

    # Cached photo names skip the details resolve entirely — the next
    # billable step is then only the media call. An empty list is a
    # legitimate cached negative: the provider had no photos.
    try:
        names = biwa_google_cache.cached_photo_names(
            store, place, strict=True)
        cached_id = None
        if names is None:
            cached_id = biwa_google_cache.cached_google_id(
                store, place, strict=True)
    except Exception:
        return biwa_store.json_error(503, "cache_unavailable",
                                     "Cached content is temporarily unavailable.")
    if names is None:
        # Real miss → the billed resolve gets the 20/min Places budget.
        if not biwa_store.check_dual_rate_limit(
            request, store, "places", biwa_store.PLACES_RATE_LIMIT
        ):
            return biwa_store.json_error(429, "rate_limited", "Too many place lookups — wait a minute.")
        # Same resolution chain as /biwa-place: checkpoints without a
        # stored Google id still resolve through the vicinity-checked
        # searchText path, and the cached id can shortcut that search.
        details, _resolved_by = biwa_places.resolve_place_details(
            place, biwa_store.GOOGLE_PLACES_KEY, cached_id=cached_id)
        if details is None:
            return biwa_store.json_error(404, "no_photos",
                                         "This place has no Google photos.")
        # Persist the resolution so /biwa-place and later photo requests
        # hit cache: id (indefinite), coords/details/photo names (30 days).
        normalized = biwa_places.normalize_details(details)
        biwa_google_cache.save_resolution(store, place, normalized)
        biwa_google_cache.save_details(store, place, normalized)
        biwa_google_cache.save_photo_names(store, place, details)
        names = [
            p.get("name")
            for p in (details.get("photos") or [])[:biwa_google_cache.MAX_PHOTO_NAMES]
            if isinstance(p, dict)
        ]
    if index >= len(names):
        return biwa_store.json_error(404, "no_photos",
                                     "No photo at this index.")
    photo_name = names[index]
    if not isinstance(photo_name, str) or not photo_name.startswith("places/"):
        return biwa_store.json_error(502, "provider_error",
                                     "Photo metadata was unusable.")

    # A concrete photo resource is about to cost a media call — the 20/min
    # photo budget gates exactly here, after every cache path ran.
    if not biwa_store.check_dual_rate_limit(
        request, store, "photo", biwa_store.PHOTO_RATE_LIMIT
    ):
        return biwa_store.json_error(429, "rate_limited", "Too many photo requests — wait a minute.")

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
    # Store the bytes for 30 days — every later request for this image
    # answers from Redis with no Google call. Freshly fetched content has
    # its full 30-day budget ahead, so the browser may hold it for the
    # whole 7-day private window.
    biwa_google_cache.save_photo(store, place, index, width, data, content_type)
    return _image_response(data, content_type, custom=not canonical_hit,
                           max_age=BROWSER_PHOTO_TTL_S, scope_valid=scope_ok)
