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


def _safe_get(store, key, strict=False):
    """Cache reads fail open — a backend error must never break the live
    request the cache was accelerating. strict=True flips the contract for
    billed-provider paths: backend exceptions and corrupt entries
    propagate as cache failures so a broken cache can never masquerade as
    a miss that would spend a Google call."""
    try:
        data = store.get_cached_json(key, strict=strict)
    except Exception:
        if strict:
            raise
        return None
    if data is not None and not isinstance(data, dict):
        # A non-dict payload is corrupt, not a miss — under strict it must
        # fail closed rather than falling through to a billed call.
        if strict:
            raise RuntimeError("Biwa cache unavailable")
        return None
    return data


def _safe_set(store, key, payload, ex=None):
    try:
        store.set_cached_json(key, payload, ex=ex)
    except Exception:
        pass


def cached_google_id(store, place, strict=False):
    """A previously resolved Google place id for this record, or None."""
    data = _safe_get(store, ID_PREFIX + _fingerprint(place), strict=strict)
    gid = data.get("id") if data else None
    if data is not None and not _valid_google_id(gid) and strict:
        raise RuntimeError("Biwa cache unavailable")
    return gid if _valid_google_id(gid) else None


def cached_location(store, place, strict=False):
    """Cached {lat, lng} within the 30-day policy window, or None."""
    data = _safe_get(store, COORDS_PREFIX + _fingerprint(place),
                     strict=strict)
    loc = {"lat": data.get("lat"), "lng": data.get("lng")} if data else None
    if data is not None and not _valid_location(loc) and strict:
        raise RuntimeError("Biwa cache unavailable")
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


def cached_details(store, place, strict=False):
    """A normalized details payload within its 30-day window, or None."""
    return _safe_get(store, DETAILS_PREFIX + _fingerprint(place),
                     strict=strict)


def save_details(store, place, details):
    """Persist the normalized details shape for 30 days — it is already
    JSON-shaped and holds only the provider fields the client renders."""
    if isinstance(details, dict):
        _safe_set(store, DETAILS_PREFIX + _fingerprint(place), details,
                  ex=CONTENT_TTL_S)


def cached_photo_names(store, place, strict=False):
    """The cached 'places/…' resource names for this record, or None.
    An empty list is a legitimate cached negative — the provider had no
    photos at last resolve, and the photo endpoint can 404 cheaply. Under
    strict an entry whose 'names' is missing or not a list is corrupt:
    it raises rather than falling through to a billed resolve."""
    data = _safe_get(store, PHOTONAMES_PREFIX + _fingerprint(place),
                     strict=strict)
    if data is None:
        return None
    names = data.get("names")
    if not isinstance(names, list):
        if strict:
            raise RuntimeError("Biwa cache unavailable")
        return None
    return names


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


def cached_photo(store, place, index, width, strict=False, with_ttl=False):
    """(bytes, content_type) for a previously fetched image, or None.

    with_ttl=True returns (bytes, content_type, ttl_seconds_remaining)
    instead — the endpoint bounds its private browser max-age by the
    server-side TTL so an expiring entry never outlives its policy window.
    strict=True propagates backend errors and treats a malformed entry
    (bad base64/type, oversized blob) as a cache failure — never as a
    miss that would spend a Google call.
    """
    remaining = 0
    if with_ttl:
        data, remaining = store.get_cached_json_with_ttl(
            _photo_key(place, index, width))
    else:
        data = _safe_get(store, _photo_key(place, index, width),
                         strict=strict)
    if data is None:
        return None
    raw, ctype = data.get("bytes"), data.get("type")
    blob = None
    malformed = not (isinstance(raw, str) and isinstance(ctype, str))
    if not malformed:
        try:
            blob = base64.b64decode(raw)
        except Exception:
            malformed = True
    if (malformed or blob is None
            or not 0 < len(blob) <= MAX_CACHED_PHOTO_BYTES):
        if strict:
            raise RuntimeError("Biwa cache unavailable")
        return None
    return ((blob, ctype, remaining) if with_ttl else (blob, ctype))


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
