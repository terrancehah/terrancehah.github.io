"""Google Places (New) provider helpers for the Biwa endpoints.

Server-side only: the browser asks /api/biwa-place and /api/biwa-photo with
INTERNAL place ids, and this module talks to Google with the server key —
the client can never submit a raw Google place id or photo resource, so the
endpoints are not an open proxy.

Provider data is transient by design: normalized details and photo bytes are
returned for display and are never persisted with the trip snapshot (Google
coordinates, photos and hours stay out of Redis/localStorage).
"""

import json
import math
import urllib.error
import urllib.parse
import urllib.request

PLACES_BASE = "https://places.googleapis.com/v1"
PLACES_SEARCH_URL = PLACES_BASE + "/places:searchText"
PROVIDER_TIMEOUT_S = 12
MAX_IMAGE_BYTES = 4 * 1024 * 1024     # bounded photo media download
SEARCH_VICINITY_M = 2000              # candidate must sit near the source record
PHOTO_HOST_SUFFIXES = ("googleusercontent.com", "ggpht.com")

# Narrow field mask — only what the sheet renders.
PLACE_FIELD_MASK = (
    "id,displayName,formattedAddress,location,primaryTypeDisplayName,"
    "photos,regularOpeningHours,currentOpeningHours,businessStatus,"
    "googleMapsUri,websiteUri,nationalPhoneNumber,attributions,"
    "rating,userRatingCount"
)
SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location"


def _http_get(url, headers=None, timeout_s=PROVIDER_TIMEOUT_S):
    """Minimal stdlib GET returning (status, parsed_body). Raises on
    network/parse failures — callers translate to generic errors (exception
    text can embed the key-bearing URL)."""
    request = urllib.request.Request(url)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _http_post(url, payload, headers=None, timeout_s=PROVIDER_TIMEOUT_S):
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _http_get_bytes(url, timeout_s=PROVIDER_TIMEOUT_S):
    """Fetch a binary body with a hard size cap — photo bytes never stream
    unbounded into memory."""
    request = urllib.request.Request(url)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        content_type = response.headers.get("Content-Type", "image/jpeg")
        data = response.read(MAX_IMAGE_BYTES + 1)
        return response.status, content_type, data


def fetch_place_details(google_place_id, server_key, http_get=None):
    """GET /v1/places/{id} with the narrow mask. Returns the parsed provider
    body or None on any failure (callers answer 'unavailable')."""
    if not server_key:
        return None
    get = http_get or _http_get
    url = f"{PLACES_BASE}/places/{urllib.parse.quote(google_place_id)}"
    try:
        status, body = get(url, {
            "X-Goog-Api-Key": server_key,
            "X-Goog-FieldMask": PLACE_FIELD_MASK,
        }, PROVIDER_TIMEOUT_S)
    except Exception:
        return None
    if status != 200 or not isinstance(body, dict):
        return None
    return body


def search_place_by_text(text_query, server_key, http_post=None):
    """Places searchText for checkpoints with no verified Google id. The
    caller must still vicinity-check the candidate against source
    coordinates before treating it as a match."""
    if not server_key or not text_query:
        return None
    post = http_post or _http_post
    try:
        status, body = post(PLACES_SEARCH_URL, {
            "textQuery": text_query,
            "pageSize": 3,
        }, {
            "X-Goog-Api-Key": server_key,
            "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        }, PROVIDER_TIMEOUT_S)
    except Exception:
        return None
    if status != 200 or not isinstance(body, dict):
        return None
    places = body.get("places") or []
    return places[0] if places else None


def resolve_place_details(place, server_key, cached_id=None):
    """The two-step lookup shared by /biwa-place and /biwa-photo.

    Resolution order: a verified googlePlaceId on the record goes straight
    to the details endpoint, then a policy-cached id (see biwa-google-cache)
    is tried, then ONE on-demand searchText whose candidate is only trusted
    when it sits within SEARCH_VICINITY_M of the source coordinates — a
    far-away namesake is 'unavailable', never a wrong card. A cached id
    whose details call fails falls through to the search path, so a stale
    cache entry can never fabricate a card.
    Returns (raw_provider_body, resolved_by); body is None on any failure so
    callers answer honestly rather than fabricating details. Module-level
    helpers are referenced by name so tests can stub them.
    """
    if place.get("googlePlaceId"):
        body = fetch_place_details(place["googlePlaceId"], server_key)
        return (body, "googlePlaceId") if body else (None, None)

    if cached_id:
        body = fetch_place_details(cached_id, server_key)
        if body:
            return body, "cachedGoogleId"
        # Fall through — the vicinity-checked search re-validates.

    query = " ".join(x for x in [place.get("label"), place.get("address")] if x)
    candidate = search_place_by_text(query, server_key)
    if not candidate:
        return None, None
    loc = candidate.get("location") or {}
    near = {"lat": place.get("lat"), "lng": place.get("lng")}
    cand = {"lat": loc.get("latitude"), "lng": loc.get("longitude")}
    if not (isinstance(near["lat"], (int, float))
            and isinstance(near["lng"], (int, float))
            and isinstance(cand["lat"], (int, float))
            and isinstance(cand["lng"], (int, float))
            and distance_meters(near, cand) <= SEARCH_VICINITY_M):
        return None, None
    # Details are fetched by the verified candidate id so the normalized
    # shape (hours/photos/contacts) matches the direct path.
    cand_id = candidate.get("id")
    if not cand_id:
        return None, None
    body = fetch_place_details(cand_id, server_key)
    return (body, "searchText") if body else (None, None)


def distance_meters(a, b):
    """Spherical distance for the searchText vicinity check."""
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, max(0, h))))


def _photo_summaries(body):
    photos = body.get("photos") or []
    out = []
    for i, photo in enumerate(photos[:10]):
        out.append({
            "index": i,
            "authorAttributions": photo.get("authorAttributions") or [],
        })
    return out


def normalize_details(body):
    """Project the provider body into the small shape the sheet renders.

    Every field is nullable — an empty provider answer renders as an honest
    'unavailable' line, never a fabricated placeholder.
    """
    if not isinstance(body, dict):
        return None
    display = body.get("displayName") or {}
    location = body.get("location") or {}
    regular = body.get("regularOpeningHours") or {}
    current = body.get("currentOpeningHours") or {}
    lat = location.get("latitude")
    lng = location.get("longitude")
    loc = ({"lat": lat, "lng": lng}
           if isinstance(lat, (int, float)) and isinstance(lng, (int, float))
           else None)
    hours = None
    weekday = regular.get("weekdayDescriptions") or current.get("weekdayDescriptions")
    open_now = current.get("openNow", regular.get("openNow"))
    if weekday or open_now is not None:
        hours = {"weekdayDescriptions": weekday or [], "openNow": open_now}
    # Rating is shown only when the provider really returned one — out-of-
    # range or non-numeric values normalize to None, never a fake 0.
    rating = body.get("rating")
    if not (isinstance(rating, (int, float)) and not isinstance(rating, bool)
            and math.isfinite(rating) and 0 <= rating <= 5):
        rating = None
    count = body.get("userRatingCount")
    if not (isinstance(count, int) and not isinstance(count, bool) and count >= 0):
        count = None
    return {
        "googlePlaceId": body.get("id"),
        "name": display.get("text") if isinstance(display.get("text"), str) else None,
        "address": body.get("formattedAddress"),
        "location": loc,
        "type": (body.get("primaryTypeDisplayName") or {}).get("text"),
        "hours": hours,
        "businessStatus": body.get("businessStatus"),
        "mapsUrl": body.get("googleMapsUri"),
        "website": body.get("websiteUri"),
        "phone": body.get("nationalPhoneNumber"),
        "rating": rating,
        "userRatingCount": count,
        "photos": _photo_summaries(body),
        "attributions": body.get("attributions") or [],
    }


def photo_media_url(photo_name, server_key, width_px):
    """The v1 photo media endpoint with skipHttpRedirect — returns the JSON
    containing photoUri instead of following it, so the image host can be
    validated before any bytes are fetched."""
    params = urllib.parse.urlencode({
        "maxWidthPx": width_px,
        "skipHttpRedirect": "true",
        "key": server_key,
    })
    return f"{PLACES_BASE}/{urllib.parse.quote(photo_name)}/media?{params}"


def allowed_photo_host(url):
    """Only fetch image bytes from Google's photo hosts, over HTTPS — the
    provider URL is validated rather than trusted, and the API key is never
    forwarded to it."""
    try:
        split = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if split.scheme != "https":
        return False
    host = split.hostname or ""
    return any(host == suffix or host.endswith("." + suffix)
               for suffix in PHOTO_HOST_SUFFIXES)


def find_trip_place(place_id, canonical, trip):
    """Resolve an internal place id: the fixed manifest first, then custom
    places from the current shared trip (custom places may carry a
    googlePlaceId/address the user entered)."""
    if canonical and place_id in canonical:
        return canonical[place_id]
    for place in (trip or {}).get("places") or []:
        if place.get("placeId") == place_id:
            return place
    return None
