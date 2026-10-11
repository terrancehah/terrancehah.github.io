"""Validation for the Lake Biwa shared trip schema and route requests.

Every write is checked server-side before it can reach Redis: field types,
sizes, ID shapes, coordinate bounds, programme membership vocabularies and
cross-references. Since this pass, the validator is source-strict:

  * lib/biwa/biwa-checkpoints.json is the canonical manifest — a mechanical
    copy of the client catalogue embedded server-side (Vercel's excludeFiles
    strips projects/ from functions, so the source of truth is duplicated
    here on purpose). All 33 seed places must be present: the 26 source
    checkpoints keep immutable coordinates/membership; the 7 additional
    places (stays, address-only stops) keep null coordinates — Google data
    resolves transiently and is never persisted as coordinates.
  * Custom places cannot mint programme memberships, and programmeStatus can
    only be checked for a place that actually belongs to that programme
    family ('rally' needs rally membership, 'official' needs any
    official-* membership).
  * Nested objects use strict key allowlists; malformed shapes (unhashable
    references, non-dict containers) yield 422, never a 500.

Schema 2 differences from schema 1: days carry a title, endpoints carry
implicit occurrence ids (dayId-start / dayId-end) so manual visits can be
recorded on endpoint rows, places may carry googlePlaceId/address, and
null coordinates are allowed only when a Google place id or a non-empty
address can resolve the place transiently.
"""

import json
import math
import os
import re

SCHEMA_VERSION = 2
MAX_PLACES = 500
REQUIRED_DAYS = 3            # this trip is exactly three days; guards zero-day crashes
MAX_STOPS_PER_DAY = 25       # 25 stops + 2 endpoints = 27 total, the Routes cap
MAX_LABEL = 200
MAX_NOTES = 4000
MAX_OCCURRENCE_VISITS = 2000
MAX_ROUTE_POINTS = 27
# This trip is exactly three days — the allowed ids are closed (route
# requests echo a dayId only for the client's staleness guard).
DAY_IDS = {"day-1", "day-2", "day-3"}

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
DAY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Google place ids (ChIJ... form) — bounded, no whitespace. Only the pattern
# is checked; resolution happens transiently through the Places endpoint.
GOOGLE_PLACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,128}$")

# Programme membership vocabulary is fixed source metadata. Places may not
# invent new programme keys; the only recognised memberships are the four
# official areas and the ten-stop rally.
ALLOWED_PROGRAMMES = {"official-south", "official-east", "official-north", "official-west", "rally"}
# programmeStatus is keyed by programme family, not per-area.
ALLOWED_STATUS_PROGRAMMES = {"rally", "official"}
CUSTOM_CATEGORIES = {"custom", "parking", "accommodation"}

# Strict key allowlists — anything outside these is rejected, not ignored.
TRIP_KEYS = {"schemaVersion", "revision", "updatedAt", "provenance",
             "places", "days", "visitStatus", "programmeStatus"}
PLACE_KEYS = {"placeId", "label", "lat", "lng", "source", "programmes",
              "category", "nameConfirmed", "notes", "bikeFriendly",
              "googlePlaceId", "address"}
SOURCE_KEYS = {"longitude", "latitude"}
DAY_KEYS = {"dayId", "label", "title", "start", "end", "startHint", "endHint", "stops"}
ENDPOINT_KEYS = {"placeId", "pin"}
PIN_KEYS = {"label", "lat", "lng"}
STOP_KEYS = {"occurrenceId", "placeId"}
ROUTE_POINT_KEYS = {"lat", "lng", "googlePlaceId"}

_MANIFEST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "biwa-checkpoints.json")


def _load_manifest():
    """Canonical source places, keyed by placeId. Immutable metadata lives
    here so certificate coordinates/membership cannot be edited away.

    Returns None on any load failure: an empty catalogue would let custom
    places validate while every source check silently passed — fail closed
    instead and reject all writes until the manifest is restored."""
    try:
        with open(_MANIFEST_PATH, encoding="utf-8") as f:
            data = json.load(f)
        manifest = {p["placeId"]: p for p in data["places"]}
        if not manifest:
            return None
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


CANONICAL = _load_manifest()


def _num(value, lo, hi):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and lo <= value <= hi)


def _is_str(value, lo=1, hi=MAX_LABEL):
    return isinstance(value, str) and lo <= len(value) <= hi


def _unknown_keys(obj, allowed, path, errors):
    extra = set(obj.keys()) - allowed
    if extra:
        errors.append(f"{path} contains unknown fields: {', '.join(sorted(extra))}")


def _programme_family(programmes):
    """The programmeStatus family a place's membership maps to."""
    families = set()
    for p in programmes or []:
        if p == "rally":
            families.add("rally")
        elif isinstance(p, str) and p.startswith("official-"):
            families.add("official")
    return families


def _check_endpoint(endpoint, place_ids, errors, path):
    """An endpoint is null (missing → honest UI state), a place reference, or
    a raw pin with coordinates — hotel pins stay user-entered, never geocoded."""
    if endpoint is None:
        return
    if not isinstance(endpoint, dict):
        errors.append(f"{path} must be null or an object")
        return
    _unknown_keys(endpoint, ENDPOINT_KEYS, path, errors)
    if "placeId" in endpoint and "pin" in endpoint:
        errors.append(f"{path} must contain placeId or pin, not both")
    elif "placeId" in endpoint:
        pid = endpoint["placeId"]
        if not isinstance(pid, str) or pid not in place_ids:
            errors.append(f"{path}.placeId references an unknown place")
    elif "pin" in endpoint:
        pin = endpoint["pin"]
        if not isinstance(pin, dict):
            errors.append(f"{path}.pin must be an object")
            return
        _unknown_keys(pin, PIN_KEYS, f"{path}.pin", errors)
        if not (_num(pin.get("lat"), -90, 90) and _num(pin.get("lng"), -180, 180)):
            errors.append(f"{path}.pin needs numeric lat/lng in range")
        if "label" in pin and not _is_str(pin["label"], 0, MAX_LABEL):
            errors.append(f"{path}.pin.label too long")
    else:
        errors.append(f"{path} must contain placeId or pin")


def validate_trip(trip):
    """Return a list of problems; empty list means the snapshot is storable."""
    if CANONICAL is None:
        # Fail closed: without the manifest the server cannot verify source
        # integrity, so no snapshot may be stored at all.
        return ["server checkpoint manifest is unavailable"]
    errors = []
    if not isinstance(trip, dict):
        return ["trip must be an object"]

    _unknown_keys(trip, TRIP_KEYS, "trip", errors)

    if trip.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")

    # --- places catalogue ---
    places = trip.get("places")
    if not isinstance(places, list) or not places:
        errors.append("places must be a non-empty list")
        places = []
    if len(places) > MAX_PLACES:
        errors.append(f"places exceeds {MAX_PLACES} entries")
    place_ids = set()
    places_by_id = {}
    for i, p in enumerate(places):
        path = f"places[{i}]"
        if not isinstance(p, dict):
            errors.append(f"{path} must be an object")
            continue
        _unknown_keys(p, PLACE_KEYS, path, errors)
        pid = p.get("placeId")
        if not _is_str(pid) or not ID_RE.match(pid):
            errors.append(f"{path}.placeId missing or invalid")
        elif pid in place_ids:
            errors.append(f"{path}.placeId '{pid}' is duplicated")
        else:
            place_ids.add(pid)
            places_by_id[pid] = p
        if not _is_str(p.get("label")):
            errors.append(f"{path}.label missing or too long")
        google_id = p.get("googlePlaceId")
        if google_id is not None and (not isinstance(google_id, str)
                                      or not GOOGLE_PLACE_ID_RE.match(google_id)):
            errors.append(f"{path}.googlePlaceId is not a valid place id")
            google_id = None
        address = p.get("address")
        if address is not None and not _is_str(address, 0, 300):
            errors.append(f"{path}.address must be a short string")
            address = None
        has_coords = _num(p.get("lat"), -90, 90) and _num(p.get("lng"), -180, 180)
        if not has_coords:
            # Coordinates may be absent ONLY when the place can still be
            # resolved transiently — a Google place id or a written address.
            # Anything else would silently render nowhere (or at 0,0).
            if (p.get("lat") is not None or p.get("lng") is not None):
                errors.append(f"{path} needs both lat and lng together or neither")
            elif not google_id and not (isinstance(address, str) and address.strip()):
                errors.append(f"{path} needs coordinates, a Google place id or an address")
        programmes = p.get("programmes", [])
        if not isinstance(programmes, list) or any(
            not isinstance(x, str) or x not in ALLOWED_PROGRAMMES for x in programmes
        ):
            errors.append(f"{path}.programmes contains an unknown programme")
            programmes = []
        notes = p.get("notes", "")
        if notes is not None and not isinstance(notes, str):
            errors.append(f"{path}.notes must be a string")
        elif isinstance(notes, str) and len(notes) > MAX_NOTES:
            errors.append(f"{path}.notes too long")
        if "nameConfirmed" in p and not isinstance(p["nameConfirmed"], bool):
            errors.append(f"{path}.nameConfirmed must be boolean")
        if "bikeFriendly" in p and not isinstance(p["bikeFriendly"], bool):
            errors.append(f"{path}.bikeFriendly must be boolean")
        if "category" in p and not _is_str(p["category"], 0, 40):
            # Non-string categories (dict/list) are unhashable — report the
            # shape error here so the membership check below never touches
            # a set with them.
            errors.append(f"{path}.category must be a short string")

        canonical = CANONICAL.get(pid) if isinstance(pid, str) else None
        if canonical:
            # Manifest places are immutable in everything except label/notes:
            # coordinates (null stays null for Google-resolved extras),
            # membership, category, nameConfirmed, the source record and the
            # verified Google id/address must equal the manifest exactly.
            immutable = ("lat", "lng", "category", "nameConfirmed",
                         "googlePlaceId", "address")
            for field in immutable:
                if p.get(field) != canonical.get(field):
                    errors.append(f"{path}.{field} differs from the checkpoint source")
            if set(programmes) != set(canonical.get("programmes", [])):
                errors.append(f"{path}.programmes differs from the checkpoint source")
            if p.get("source") != canonical.get("source"):
                errors.append(f"{path}.source differs from the checkpoint source")
        else:
            # Custom places: no programme membership, no source record — the
            # certificate catalogue cannot be extended by clients.
            if programmes:
                errors.append(f"{path}.programmes must be empty for custom places")
            if "source" in p:
                errors.append(f"{path}.source is only allowed on catalogue places")
            category = p.get("category", "custom")
            if not isinstance(category, str) or category not in CUSTOM_CATEGORIES:
                errors.append(f"{path}.category must be custom, parking or accommodation")

    # Every canonical source place must be retained — removing one from the
    # catalogue would silently drop certificate metadata.
    missing = sorted(set(CANONICAL.keys()) - place_ids)
    if missing:
        errors.append(f"catalogue places missing: {', '.join(missing[:5])}")

    # --- days / itinerary ---
    days = trip.get("days")
    if not isinstance(days, list):
        errors.append("days must be a list")
        days = []
    elif len(days) != REQUIRED_DAYS:
        errors.append(f"days must contain exactly {REQUIRED_DAYS} entries")
    day_ids = set()
    occurrence_ids = set()
    for i, day in enumerate(days):
        path = f"days[{i}]"
        if not isinstance(day, dict):
            errors.append(f"{path} must be an object")
            continue
        _unknown_keys(day, DAY_KEYS, path, errors)
        did = day.get("dayId")
        if not _is_str(did) or not DAY_ID_RE.match(did):
            errors.append(f"{path}.dayId missing or invalid")
        elif did in day_ids:
            errors.append(f"{path}.dayId '{did}' is duplicated")
        else:
            day_ids.add(did)
        if not _is_str(day.get("label"), 1, 120):
            errors.append(f"{path}.label missing or too long")
        if "title" in day and not _is_str(day["title"], 0, 160):
            errors.append(f"{path}.title too long")
        _check_endpoint(day.get("start"), place_ids, errors, f"{path}.start")
        _check_endpoint(day.get("end"), place_ids, errors, f"{path}.end")
        # Endpoint rows are tickable like stops: their implicit occurrence
        # ids (dayId-start / dayId-end) are valid visitStatus keys while the
        # endpoint exists. Clearing an endpoint must drop its visit flag.
        if isinstance(did, str) and day.get("start") is not None:
            occurrence_ids.add(did + "-start")
        if isinstance(did, str) and day.get("end") is not None:
            occurrence_ids.add(did + "-end")
        if "endHint" in day and not _is_str(day["endHint"], 0, 200):
            errors.append(f"{path}.endHint too long")
        if "startHint" in day and not _is_str(day["startHint"], 0, 200):
            errors.append(f"{path}.startHint too long")
        stops = day.get("stops")
        if not isinstance(stops, list):
            errors.append(f"{path}.stops must be a list")
            continue
        if len(stops) > MAX_STOPS_PER_DAY:
            errors.append(f"{path}.stops exceeds {MAX_STOPS_PER_DAY} "
                          "(27 locations/day incl. endpoints is the route cap)")
        for j, stop in enumerate(stops):
            spath = f"{path}.stops[{j}]"
            if not isinstance(stop, dict):
                errors.append(f"{spath} must be an object")
                continue
            _unknown_keys(stop, STOP_KEYS, spath, errors)
            oid = stop.get("occurrenceId")
            if not _is_str(oid) or not DAY_ID_RE.match(oid):
                errors.append(f"{spath}.occurrenceId missing or invalid")
            elif oid in occurrence_ids:
                errors.append(f"{spath}.occurrenceId '{oid}' is duplicated")
            else:
                occurrence_ids.add(oid)
            pid = stop.get("placeId")
            if not isinstance(pid, str) or pid not in place_ids:
                errors.append(f"{spath}.placeId references an unknown place")

    # --- visit status: keyed by occurrence, so repeated visits stay distinct ---
    visits = trip.get("visitStatus", {})
    if not isinstance(visits, dict):
        errors.append("visitStatus must be an object")
        visits = {}
    if len(visits) > MAX_OCCURRENCE_VISITS:
        errors.append(f"visitStatus exceeds {MAX_OCCURRENCE_VISITS} entries")
    for key, value in visits.items():
        if not isinstance(key, str) or key not in occurrence_ids:
            errors.append(f"visitStatus['{key}'] has no matching stop occurrence")
        if value is not True:
            errors.append(f"visitStatus['{key}'] must be true when present")

    # --- programme checklist: keyed by family then placeId, membership-bound ---
    status = trip.get("programmeStatus", {})
    if not isinstance(status, dict):
        errors.append("programmeStatus must be an object")
        status = {}
    for programme, entries in status.items():
        if programme not in ALLOWED_STATUS_PROGRAMMES:
            errors.append(f"programmeStatus['{programme}'] is not a recognised programme")
            continue
        if not isinstance(entries, dict):
            errors.append(f"programmeStatus['{programme}'] must be an object")
            continue
        for place_id, value in entries.items():
            if not isinstance(place_id, str) or place_id not in place_ids:
                errors.append(f"programmeStatus['{programme}']['{place_id}'] is an unknown place")
                continue
            # A place can only be ticked for a programme it belongs to —
            # custom places cannot be marked as certificate progress.
            place = places_by_id.get(place_id, {})
            if programme not in _programme_family(place.get("programmes")):
                errors.append(
                    f"programmeStatus['{programme}']['{place_id}'] is not a member of that programme")
            if value is not True:
                errors.append(f"programmeStatus['{programme}']['{place_id}'] must be true when present")

    if "updatedAt" in trip and trip["updatedAt"] is not None and not isinstance(trip["updatedAt"], str):
        errors.append("updatedAt must be a string or null")
    if "revision" in trip:
        rev = trip["revision"]
        if not isinstance(rev, int) or isinstance(rev, bool):
            errors.append("revision must be an integer")

    return errors


def validate_route_request(body):
    """Validate POST /api/biwa-route payloads.

    The provider accepts at most 25 intermediate waypoints plus origin and
    destination, so a day's ordered coordinates are bounded at 2..27 total —
    an empty or single-point list is invalid, not skipped. Points are either
    source coordinates or a Google place id (resolved by the provider, so
    null-coord places like lodgings can still be routed).
    """
    errors = []
    if not isinstance(body, dict):
        return ["body must be an object"]
    # The day id is echoed back for client staleness guards, so it must be
    # one of this trip's three days — an unknown label is a bad request,
    # not merely an unknown tag.
    if not _is_str(body.get("dayId"), 1, 40) or \
            body["dayId"] not in DAY_IDS:
        errors.append("dayId missing or invalid")
    if not _is_str(body.get("requestId")) or not REQUEST_ID_RE.match(body["requestId"]):
        errors.append("requestId missing or invalid")
    coords = body.get("orderedCoordinates")
    if not isinstance(coords, list):
        errors.append("orderedCoordinates must be a list")
        coords = []
    elif not 2 <= len(coords) <= MAX_ROUTE_POINTS:
        errors.append(f"orderedCoordinates must contain 2..{MAX_ROUTE_POINTS} locations")
    for i, c in enumerate(coords):
        path = f"orderedCoordinates[{i}]"
        if not isinstance(c, dict):
            errors.append(f"{path} must be an object")
            continue
        _unknown_keys(c, ROUTE_POINT_KEYS, path, errors)
        if "googlePlaceId" in c:
            gid = c["googlePlaceId"]
            if not isinstance(gid, str) or not GOOGLE_PLACE_ID_RE.match(gid):
                errors.append(f"{path}.googlePlaceId is not a valid place id")
            if "lat" in c or "lng" in c:
                errors.append(f"{path} must use googlePlaceId or lat/lng, not both")
        elif not (_num(c.get("lat"), -90, 90) and _num(c.get("lng"), -180, 180)):
            errors.append(f"{path} needs numeric lat/lng in range or a googlePlaceId")
    return errors


def validate_place_query(place_id):
    """Validate the internal place id for the Places/photo endpoints.

    Provider lookups are keyed on OUR catalogue id — the client can never
    submit a raw Google place id, so these endpoints are not an open proxy.
    """
    if not _is_str(place_id) or not ID_RE.match(place_id):
        return ["placeId missing or invalid"]
    return []
