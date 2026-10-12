"""Policy-limited Google Places cache for the Biwa endpoints.

Within Google's Maps Platform terms (place ids indefinitely, other Places
content for at most 30 days) this module persists:

  - the Google place ID    — indefinitely,
  - lat/lng coordinates    — 30-day TTL,
  - normalized details     — 30-day TTL, under a per-record key so repeat
                             sheet/card views cost no billed call,
  - photo resource names   — 30-day TTL, so /biwa-photo can skip the whole
                             details resolution for a repeat photo,
  - photo image bytes      — 30-day TTL, base64 inside the JSON cache so a
                             repeat image request costs no Google call at
                             all. Route geometry and elevation are still
                             never written.

Keys live in the Biwa v2 namespace and are fingerprinted by the internal
record's anchor fields, so an edited label, address or source coordinate
naturally misses the stale entry instead of serving data for a different
place.
"""

import base64
import hashlib
import json
import math

COORDS_TTL_S = 30 * 24 * 60 * 60       # 2592000s — Google's lat/lng cap
CONTENT_TTL_S = COORDS_TTL_S           # same 30-day cap for other content
ID_PREFIX = "biwa:v2:google:id:"
COORDS_PREFIX = "biwa:v2:google:coords:"
DETAILS_PREFIX = "biwa:v2:google:details:"
PHOTONAMES_PREFIX = "biwa:v2:google:photonames:"
PHOTO_PREFIX = "biwa:v2:google:photo:"
MAX_GOOGLE_ID_LEN = 300
MAX_PHOTO_NAMES = 10                   # mirrors _photo_summaries' slice cap
MAX_CACHED_PHOTO_BYTES = 4 * 1024 * 1024   # same bound as the live fetch


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


def cached_details(store, place):
    """A normalized details payload within its 30-day window, or None."""
    return _safe_get(store, DETAILS_PREFIX + _fingerprint(place))


def save_details(store, place, details):
    """Persist the normalized details shape for 30 days — it is already
    JSON-shaped and holds only the provider fields the client renders."""
    if isinstance(details, dict):
        _safe_set(store, DETAILS_PREFIX + _fingerprint(place), details,
                  ex=CONTENT_TTL_S)


def cached_photo_names(store, place):
    """The cached 'places/…' resource names for this record, or None.
    An empty list is a legitimate cached negative — the provider had no
    photos at last resolve, and the photo endpoint can 404 cheaply."""
    data = _safe_get(store, PHOTONAMES_PREFIX + _fingerprint(place))
    names = data.get("names") if data else None
    return names if isinstance(names, list) else None


def save_photo_names(store, place, body):
    """Extract 'places/…/photos/…' resource names from the RAW provider
    body and keep them for 30 days — the normalized details shape retains
    only index+attributions, so this must run on the un-normalized body."""
    photos = body.get("photos") if isinstance(body, dict) else None
    names = []
    for photo in (photos or [])[:MAX_PHOTO_NAMES]:
        name = photo.get("name") if isinstance(photo, dict) else None
        if isinstance(name, str) and name.startswith("places/"):
            names.append(name)
    _safe_set(store, PHOTONAMES_PREFIX + _fingerprint(place),
              {"names": names}, ex=CONTENT_TTL_S)


def _photo_key(place, index, width):
    return f"{PHOTO_PREFIX}{_fingerprint(place)}:{index}:{width}"


def cached_photo(store, place, index, width):
    """(bytes, content_type) for a previously fetched image, or None."""
    data = _safe_get(store, _photo_key(place, index, width))
    raw, ctype = (data.get("bytes"), data.get("type")) if data else (None, None)
    if not (isinstance(raw, str) and isinstance(ctype, str)):
        return None
    try:
        blob = base64.b64decode(raw)
    except Exception:
        return None
    return (blob, ctype) if 0 < len(blob) <= MAX_CACHED_PHOTO_BYTES else None


def save_photo(store, place, index, width, blob, content_type):
    """Store image bytes base64-wrapped inside the JSON cache for 30 days
    — bounded by the same 4 MB cap as the live download path."""
    if (not isinstance(blob, bytes) or not blob
            or len(blob) > MAX_CACHED_PHOTO_BYTES
            or not isinstance(content_type, str)):
        return
    _safe_set(store, _photo_key(place, index, width), {
        "bytes": base64.b64encode(blob).decode("ascii"),
        "type": content_type,
    }, ex=CONTENT_TTL_S)
