"""Google Routes provider integration for the Biwa ride (server-side only).

The browser never talks to the Routes or Elevation APIs directly: it posts
ordered coordinates to /api/biwa-route, and this module calls Google with the
server-restricted key. This is deliberately DRIVE routing (Japan has no
Google bicycle coverage and the preview must not be sold as cycling
guidance): TRAFFIC_UNAWARE, no waypoint optimisation so the anticlockwise
order and the user's shaping stops survive, avoidance flags as preferences,
metric units and a narrow field mask to limit cost.

Responses from Google stay transient: the route polyline, distance and any
elevation samples are returned to the caller for display only and are never
persisted with the trip snapshot.
"""

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request

COMPUTE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
ELEVATION_URL = "https://maps.googleapis.com/maps/api/elevation/json"

# Narrow field mask: only what the UI renders, to keep responses small.
ROUTES_FIELD_MASK = (
    "routes.distanceMeters,"
    "routes.polyline.encodedPolyline,"
    "routes.legs.distanceMeters"
)

PROVIDER_TIMEOUT_S = 12


def _post_json(url, payload, headers, timeout_s=PROVIDER_TIMEOUT_S):
    """Minimal JSON POST via stdlib so no new dependency is required.

    Returns (status_code, parsed_body). Network/parse failures raise; callers
    translate them into a graceful 'route_unavailable' response.
    """
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _latlng(point):
    # Route points may carry a Google place id instead of coordinates —
    # Places-resolved stops (e.g. lodgings stored with null lat/lng) route
    # through the provider without persisting Google coordinates. The
    # validator guarantees a point has exactly one of the two forms.
    if point.get("googlePlaceId"):
        return {"placeId": point["googlePlaceId"]}
    return {"location": {"latLng": {"latitude": point["lat"], "longitude": point["lng"]}}}


def compute_route(ordered_coordinates, server_key, http_post=None):
    """Request a DRIVE route through the ordered coordinates.

    Returns {"ok": True, "polyline": str, "distanceMeters": int,
             "legsMeters": [int, ...]} or {"ok": False, "error": code,
             "message": str}. `http_post` is injectable so tests never make a
    paid network call.
    """
    if not server_key:
        return {"ok": False, "error": "not_configured",
                "message": "Route provider is not configured on this deployment."}
    post = http_post or _post_json
    points = list(ordered_coordinates)
    payload = {
        "origin": _latlng(points[0]),
        "destination": _latlng(points[-1]),
        # 2..27 total locations ⇒ at most 25 intermediates, the Routes limit.
        "intermediates": [_latlng(p) for p in points[1:-1]],
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
        # Keep the supplied order: no optimisation may quietly drop the
        # anticlockwise loop or a user's shaping detour.
        "optimizeWaypointOrder": False,
        # Avoidance is a preference Google may override; the UI says so.
        "routeModifiers": {
            "avoidTolls": True,
            "avoidHighways": True,
            "avoidFerries": True,
        },
        "units": "METRIC",
    }
    headers = {
        "X-Goog-Api-Key": server_key,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    }
    try:
        status, body = post(COMPUTE_ROUTES_URL, payload, headers, PROVIDER_TIMEOUT_S)
    except urllib.error.HTTPError as exc:
        # Generic message: HTTPError bodies and exception text can embed the
        # key-bearing request URL — never surface them to the client. A 403
        # gets its own code so the UI can name the fix (Routes API disabled
        # on the key) without exposing the provider's detail.
        if exc.code == 403:
            return {"ok": False, "error": "provider_blocked",
                    "message": "The routes provider denied the request — the Routes API may not be enabled for the server key."}
        return {"ok": False, "error": "provider_error",
                "message": "Routes provider request failed."}
    except Exception:
        # Same rule for timeouts/DNS/parse failures: no exception detail.
        return {"ok": False, "error": "provider_error",
                "message": "Routes provider request failed."}
    if status != 200:
        return {"ok": False, "error": "provider_error",
                "message": "Routes provider request failed."}
    routes = (body or {}).get("routes") or []
    if not routes:
        return {"ok": False, "error": "route_unavailable",
                "message": "Routes API returned no route for these stops."}
    route = routes[0]
    # Validate rather than fabricate: a missing/invalid polyline or distance
    # is 'route_unavailable', never a zero or invented metric.
    polyline = (route.get("polyline") or {}).get("encodedPolyline")
    distance = route.get("distanceMeters")
    if (not isinstance(polyline, str) or not polyline
            or isinstance(distance, bool)
            or not isinstance(distance, (int, float))
            or not math.isfinite(distance) or distance < 0):
        return {"ok": False, "error": "route_unavailable",
                "message": "Routes API returned an unusable route."}
    # Routes uses proto3 JSON: a requested integer field at its default
    # value (zero) can be omitted. An existing leg object without the field
    # therefore represents zero metres; malformed leg entries stay invalid.
    legs = [leg.get("distanceMeters", 0) if isinstance(leg, dict) else None
            for leg in route.get("legs", [])]
    return {
        "ok": True,
        "polyline": polyline,
        "distanceMeters": distance,
        "legsMeters": legs,
    }


def sampled_terrain_ascent(encoded_polyline, server_key, http_get=None):
    """=== ELEVATION SEAM — LEAD-OWNED, DO NOT AUTHOR HERE ===

    The lead authors the correctness-critical recipe in a follow-up pass.
    Contract for that implementation:

      input   encoded_polyline from computeRoutes; server_key for the
              Elevation API; injectable http_get for deterministic fixtures.
      recipe  1. decode the road polyline to lat/lng vertices;
              2. compute cumulative geodesic length along the vertices;
              3. linearly interpolate lat/lng at 100 m cumulative intervals,
              including both endpoints;
              4. split ordered samples into at most 512 locations per
              Elevation request, preserving order, and split further if a
              request URL would exceed size limits — never discard samples;
              5. apply a centred 5-sample moving mean (shortened window at
              boundaries) to elevations;
              6. sum positive adjacent differences, round to nearest 10 m.
      output  {"status": "ok",
               "ascentMeters": int,                 # rounded to nearest 10
               "samples": [{"lat": f, "lng": f,
                            "elevationMeters": f,
                            "distanceMeters": f}, ...],
               "meta": {"spacingMeters": 100, "filter": "moving-mean-5",
                        "batchSizeMax": 512}}
              or {"status": "unavailable", "reason": str}

    Rules: Elevation responses are transient (never cached in Redis/local
    storage); failure here must never discard a valid route/distance.

    Until the lead wires this in, the seam always reports unavailable so the
    UI shows an honest state.

    NOTE (post-handoff): the recipe above is now implemented below by the
    lead; the 'seam' wording is historical — this function returns real
    elevation data when the provider is configured.
    """
    # The recipe above is now implemented here. Bound provider work so a
    # malformed or enormous route cannot consume an unbounded billable batch.
    try:
        points = _decode_route(encoded_polyline)
        samples = _sample_route(points)
        if not server_key or len(samples) < 2:
            return {"status": "unavailable", "reason": "insufficient_path"}
        get = http_get or _get_elevation_json
        deadline = time.monotonic() + 25
        elevations = []
        batch = []
        urls = []
        for sample in samples:
            candidate = batch + [sample]
            url = _elevation_url(candidate, server_key)
            if batch and (len(candidate) > 512 or len(url) > 7500):
                urls.append(_elevation_url(batch, server_key))
                batch = [sample]
            else:
                batch = candidate
        if batch:
            urls.append(_elevation_url(batch, server_key))
        if len(urls) > 20:
            return {"status": "unavailable", "reason": "path_too_long"}
        offset = 0
        for url in urls:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"status": "unavailable", "reason": "timeout"}
            status, body = get(url, min(PROVIDER_TIMEOUT_S, remaining))
            expected_count = len(urllib.parse.parse_qs(
                urllib.parse.urlsplit(url).query)["locations"][0].split("|"))
            results = body.get("results", [])
            if status != 200 or body.get("status") != "OK" or len(results) != expected_count:
                return {"status": "unavailable", "reason": "provider_error"}
            for index, result in enumerate(results):
                value = result.get("elevation")
                location = result.get("location", {})
                expected = samples[offset + index]
                if (isinstance(value, bool) or not isinstance(value, (float, int))
                        or not math.isfinite(value)
                        or abs(location.get("lat", math.inf) - expected["lat"]) > 0.00001
                        or abs(location.get("lng", math.inf) - expected["lng"]) > 0.00001):
                    return {"status": "unavailable", "reason": "invalid_samples"}
                elevations.append(value)
            offset += expected_count
        # Shortened centred windows at endpoints avoid padding fake terrain.
        smoothed = [
            sum(elevations[max(0, i - 2):min(len(elevations), i + 3)])
            / len(elevations[max(0, i - 2):min(len(elevations), i + 3)])
            for i in range(len(elevations))
        ]
        ascent = sum(max(0, current - previous)
                     for previous, current in zip(smoothed, smoothed[1:]))
        return {
            "status": "ok",
            "ascentMeters": int(math.floor(ascent / 10 + 0.5) * 10),
            "samples": [dict(sample, elevationMeters=smoothed[i])
                        for i, sample in enumerate(samples)],
            "meta": {"spacingMeters": 100, "filter": "moving-mean-5",
                     "batchSizeMax": 512, "approximate": True},
        }
    except Exception:
        # Provider exceptions may contain the request URL/key; do not expose
        # them in logs or responses. Route/distance remain independently valid.
        return {"status": "unavailable", "reason": "provider_error"}


def _decode_route(encoded):
    """Decode E5 polyline vertices, rejecting truncated/invalid coordinates."""
    if not isinstance(encoded, str) or len(encoded) > 500000:
        raise ValueError("Invalid polyline")
    points, index, latitude, longitude = [], 0, 0, 0
    while index < len(encoded):
        delta = []
        for _ in range(2):
            value, shift = 0, 0
            while True:
                if index >= len(encoded) or shift > 30:
                    raise ValueError("Truncated polyline")
                byte = ord(encoded[index]) - 63
                index += 1
                if not 0 <= byte <= 63:
                    raise ValueError("Invalid polyline byte")
                value |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            delta.append(~(value >> 1) if value & 1 else value >> 1)
        latitude += delta[0]
        longitude += delta[1]
        lat, lng = latitude / 100000, longitude / 100000
        if not -90 <= lat <= 90 or not -180 <= lng <= 180:
            raise ValueError("Invalid coordinate")
        points.append({"lat": lat, "lng": lng})
    return points


def _distance_metres(first, second):
    """Spherical geodesic length with mean Earth radius 6,371,008.8m."""
    lat1, lat2 = math.radians(first["lat"]), math.radians(second["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(second["lng"] - first["lng"])
    haversine = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, max(0, haversine))))


def _sample_route(points):
    """Interpolate every 100m along cumulative length, retaining both ends."""
    if len(points) < 2:
        return []
    cumulative = [0.0]
    for first, second in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + _distance_metres(first, second))
    total = cumulative[-1]
    if total <= 0:
        return []
    if total > 1000000:
        raise ValueError("Path exceeds bounded elevation work")
    targets = [float(distance) for distance in range(0, math.ceil(total), 100)]
    targets.append(total)
    segment, samples = 0, []
    for target in targets:
        while segment < len(points) - 2 and cumulative[segment + 1] <= target:
            segment += 1
        length = cumulative[segment + 1] - cumulative[segment]
        fraction = (target - cumulative[segment]) / length if length else 0
        first, second = points[segment], points[segment + 1]
        samples.append({
            "lat": first["lat"] + fraction * (second["lat"] - first["lat"]),
            "lng": first["lng"] + fraction * (second["lng"] - first["lng"]),
            "distanceMeters": target,
        })
    # Ensure the last point is exact even after floating-point interpolation.
    samples[-1].update(points[-1])
    return samples


def _elevation_url(samples, server_key):
    """Short decimal coordinates keep location batches below URL limits."""
    locations = "|".join(f'{point["lat"]:.7f},{point["lng"]:.7f}' for point in samples)
    return ELEVATION_URL + "?" + urllib.parse.urlencode({"locations": locations, "key": server_key})


def _get_elevation_json(url, timeout):
    """Injectable stdlib transport; callers suppress key-bearing errors."""
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode("utf-8"))
