"""Policy-limited Google Places cache for the Biwa endpoints.

Google Places (New) terms allow persisting ONLY:

  - the Google place ID    — indefinitely, and
  - lat/lng coordinates    — for at most 30 days.

Everything else (names, addresses, hours, ratings, photos and their URLs or
bytes, route geometry, elevation) is fetched transiently per request and is
never written to Redis. Keys live in the Biwa v2 namespace and are
fingerprinted by the internal record's anchor fields, so an edited label,
address or source coordinate naturally misses the stale entry instead of
serving data for a different place.
"""

import hashlib
import json
import math

COORDS_TTL_S = 30 * 24 * 60 * 60       # 2592000s — Google's lat/lng cap
ID_PREFIX = "biwa:v2:google:id:"
COORDS_PREFIX = "biwa:v2:google:coords:"
MAX_GOOGLE_ID_LEN = 300


def _fingerprint(place):
    """sha256 over the canonical anchor fields — deterministic key order so
    the same record always hashes to the same cache key."""
    anchor = {
        "placeId": place.get("placeId"),
        "label": place.get("label"),
        "address": place.get("address"),
        "googlePlaceId": place.get("googlePlaceId"),
        "lat": place.get("lat"),
        "lng": place.get("lng"),
        "source": place.get("source"),
    }
    return hashlib.sha256(
        json.dumps(anchor, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _valid_google_id(value):
    """Google place ids are bounded alphanumeric tokens (ChIJ-style)."""
    return (isinstance(value, str) and 0 < len(value) <= MAX_GOOGLE_ID_LEN
            and all(ch.isalnum() or ch in "_-" for ch in value))


def _valid_location(loc):
    """Strict lat/lng check — finite numbers inside world bounds."""
    if not isinstance(loc, dict):
        return False
    lat, lng = loc.get("lat"), loc.get("lng")
    return (isinstance(lat, (int, float)) and not isinstance(lat, bool)
            and math.isfinite(lat) and -90 <= lat <= 90
            and isinstance(lng, (int, float)) and not isinstance(lng, bool)
            and math.isfinite(lng) and -180 <= lng <= 180)


def _safe_get(store, key):
    """Cache reads fail open — a backend error must never break the live
    request the cache was accelerating."""
    try:
        data = store.get_cached_json(key)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _safe_set(store, key, payload, ex=None):
    try:
        store.set_cached_json(key, payload, ex=ex)
    except Exception:
        pass


def cached_google_id(store, place):
    """A previously resolved Google place id for this record, or None."""
    data = _safe_get(store, ID_PREFIX + _fingerprint(place))
    gid = data.get("id") if data else None
    return gid if _valid_google_id(gid) else None


def cached_location(store, place):
    """Cached {lat, lng} within the 30-day policy window, or None."""
    data = _safe_get(store, COORDS_PREFIX + _fingerprint(place))
    loc = {"lat": data.get("lat"), "lng": data.get("lng")} if data else None
    return loc if _valid_location(loc) else None


def save_resolution(store, place, details):
    """Persist ONLY the policy-allowed fields after a live resolve: the
    Google place id (no expiry) and lat/lng (30-day TTL).

    `details` is the normalized details shape; hours, ratings, photos and
    every other field are deliberately not written.
    """
    if not isinstance(details, dict):
        return
    gid = details.get("googlePlaceId")
    if _valid_google_id(gid):
        _safe_set(store, ID_PREFIX + _fingerprint(place), {"id": gid})
    loc = details.get("location")
    if _valid_location(loc):
        _safe_set(store, COORDS_PREFIX + _fingerprint(place),
                  {"lat": loc["lat"], "lng": loc["lng"]}, ex=COORDS_TTL_S)
