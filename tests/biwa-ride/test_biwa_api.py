"""Regression tests for the Biwa endpoints and helpers.

All external services are stubbed: the store uses the in-memory backend (the
same one BIWA_DEV_ALLOW_MEMORY enables) and the Google Routes call receives an
injected transport — no Redis and no paid API calls.

Run:  .venv/bin/python -m unittest tests.biwa-ride.test_biwa_api -v
(Or directly: .venv/bin/python tests/biwa-ride/test_biwa_api.py)
"""

import importlib.util
import json
import os
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API_DIR = os.path.join(ROOT, "api")

# Configure the environment BEFORE loading the endpoint modules — config is
# read at import time so the fail-closed behaviour is itself testable.
os.environ["BIWA_TRIP_TOKEN"] = "test-invite-token"
os.environ["BIWA_DEV_ALLOW_MEMORY"] = "1"
os.environ.pop("BIWA_REDIS_REST_URL", None)
os.environ.pop("BIWA_REDIS_REST_TOKEN", None)
os.environ.pop("BIWA_GOOGLE_SERVER_KEY", None)


def load(module_key, path):
    if module_key in sys.modules:
        return sys.modules[module_key]
    spec = importlib.util.spec_from_file_location(module_key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


biwa_store = load("biwa_store", os.path.join(ROOT, "lib", "biwa", "biwa-store.py"))
biwa_models = biwa_store.load_biwa_module("biwa-models")
biwa_places = biwa_store.load_biwa_module("biwa-places")
biwa_routing = biwa_store.load_biwa_module("biwa-routing")
biwa_trip = load("biwa_trip_endpoint", os.path.join(API_DIR, "biwa-trip.py"))
biwa_pair = load("biwa_pair_endpoint", os.path.join(API_DIR, "biwa-pair.py"))
biwa_route = load("biwa_route_endpoint", os.path.join(API_DIR, "biwa-route.py"))
biwa_place = load("biwa_place_endpoint", os.path.join(API_DIR, "biwa-place.py"))
biwa_photo = load("biwa_photo_endpoint", os.path.join(API_DIR, "biwa-photo.py"))

from fastapi.testclient import TestClient

SEED_PATH = os.path.join(ROOT, "projects", "biwa-ride", "data", "trip-seed.json")
CHECKPOINTS_PATH = os.path.join(ROOT, "projects", "biwa-ride", "data", "checkpoints.json")


def seed_trip():
    with open(SEED_PATH, encoding="utf-8") as f:
        trip = json.load(f)
    with open(CHECKPOINTS_PATH, encoding="utf-8") as f:
        trip["places"] = json.load(f)["places"]
    return trip


# A valid '<scheme>:<subject>' owner id for the default test identity.
TEST_OWNER = "dev:00000000-0000-4000-8000-000000000001"


def fresh_client(owner=TEST_OWNER):
    """A TestClient with a clean memory store and a default owner header.

    The memory backend is class-shared across every endpoint's store, so
    clearing it through the trip store resets the pair endpoint's too.
    """
    biwa_trip.store._memory.clear()
    return owner_client(owner)


def owner_client(owner=TEST_OWNER):
    """A TestClient on the CURRENT store contents — for second devices and
    second owners inside a test, where clearing would wipe the fixture."""
    return TestClient(biwa_trip.app, headers={"X-Biwa-Owner": owner})


class OwnerAccessTests(unittest.TestCase):
    """Trips are personal per-owner docs — X-Biwa-Owner selects which one.
    There is no Authorization scheme; the owner header IS the identity."""

    def test_get_without_owner_header_rejected(self):
        # A bare client (no default headers) has no doc to serve.
        biwa_trip.store._memory.clear()
        res = TestClient(biwa_trip.app).get("/")
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.json()["error"], "owner_required")

    def test_malformed_owner_header_rejected(self):
        biwa_trip.store._memory.clear()
        res = TestClient(biwa_trip.app).get("/", headers={"X-Biwa-Owner": "not-an-owner"})
        self.assertEqual(res.status_code, 401)

    def test_get_with_owner_header_ok(self):
        client = fresh_client()
        res = client.get("/")
        self.assertEqual(res.status_code, 200)

    def test_stray_authorization_header_is_ignored(self):
        client = fresh_client()
        res = client.get("/", headers={"Authorization": "Bearer nope"})
        self.assertEqual(res.status_code, 200)

    def test_fail_closed_without_config(self):
        # A store with neither Redis nor memory backend must report
        # not_configured rather than silently working.
        bare = biwa_store.BiwaStore(redis_client=None, memory=None)
        bare._redis = None
        bare._memory = None
        self.assertFalse(bare.configured)
        self.assertFalse(bare.check_rate_limit("x", 5))

    def test_get_returns_null_trip_and_config_before_first_seed(self):
        client = fresh_client()
        res = client.get("/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIsNone(body["trip"])
        self.assertIn("sharingAvailable", body)
        self.assertIn("capabilities", body)
        # The browser Maps key field is only present when a key is
        # configured — its absence must not break a public GET.
        self.assertIsNone(body.get("browserMapsKey"))

    def test_put_without_owner_header_rejected(self):
        biwa_trip.store._memory.clear()
        res = TestClient(biwa_trip.app).put(
            "/", json={"expectedRevision": 0, "trip": seed_trip()})
        self.assertEqual(res.status_code, 401)

    def test_put_with_owner_header_ok(self):
        client = fresh_client()
        res = client.put("/", json={"expectedRevision": 0, "trip": seed_trip()})
        self.assertEqual(res.status_code, 200, res.text)

    def test_owners_are_isolated(self):
        # Owner A writes; owner B reads — B must see no doc at all.
        a = fresh_client()
        self.assertEqual(a.put("/", json={"expectedRevision": 0, "trip": seed_trip()}).status_code, 200)
        b = owner_client("dev:00000000-0000-4000-8000-0000000000ff")
        res = b.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIsNone(res.json()["trip"], "another owner's doc must not leak")
        # And B's own write does not disturb A's.
        b.put("/", json={"expectedRevision": 0, "trip": seed_trip()})
        self.assertEqual(a.get("/").json()["trip"]["revision"], 1)

    def test_cross_origin_mutation_rejected_read_ok(self):
        client = fresh_client()
        trip = seed_trip()
        evil = {"Origin": "https://example.evil"}
        # A foreign Origin may not mutate trip state or call providers.
        res = client.put("/", headers=evil,
                         json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["error"], "forbidden_origin")
        # Reads with an owner identity still work.
        self.assertEqual(client.get("/").status_code, 200)


class PairTests(unittest.TestCase):
    """biwa-pair: create mints a 10-minute code, claim resolves it."""

    def pair_client(self, owner=TEST_OWNER):
        return TestClient(biwa_pair.app, headers={"X-Biwa-Owner": owner})

    def test_create_requires_owner(self):
        biwa_trip.store._memory.clear()
        res = TestClient(biwa_pair.app).post("/", json={"op": "create"})
        self.assertEqual(res.status_code, 401)

    def test_create_then_claim_roundtrip(self):
        biwa_trip.store._memory.clear()
        client = self.pair_client()
        res = client.post("/", json={"op": "create"})
        self.assertEqual(res.status_code, 200, res.text)
        code = res.json()["code"]
        self.assertEqual(len(code), biwa_store.PAIR_CODE_LENGTH)
        self.assertEqual(res.json()["expiresIn"], biwa_store.PAIR_CODE_TTL_S)
        # A fresh device (its own owner header) claims the code.
        claimer = self.pair_client("dev:00000000-0000-4000-8000-0000000000ee")
        got = claimer.post("/", json={"op": "claim", "code": code.lower()})
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.json()["ownerId"], TEST_OWNER)

    def test_claim_unknown_or_expired_code_404(self):
        biwa_trip.store._memory.clear()
        client = self.pair_client()
        res = client.post("/", json={"op": "claim", "code": "ZZZZZZ"})
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.json()["error"], "code_expired")

    def test_claim_malformed_code_400(self):
        biwa_trip.store._memory.clear()
        client = self.pair_client()
        res = client.post("/", json={"op": "claim", "code": "nope"})
        self.assertEqual(res.status_code, 400)

    def test_claim_rate_limited(self):
        biwa_trip.store._memory.clear()
        client = self.pair_client()
        res = None
        for _ in range(biwa_pair.PAIR_CLAIM_RATE_LIMIT + 2):
            res = client.post("/", json={"op": "claim", "code": "ZZZZZZ"})
        self.assertEqual(res.status_code, 429)


class TripWriteTests(unittest.TestCase):
    def test_seed_put_then_get_roundtrip(self):
        client = fresh_client()
        trip = seed_trip()
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["revision"], 1)
        got = client.get("/").json()["trip"]
        self.assertEqual(got["revision"], 1)
        self.assertEqual(len(got["places"]), 33)
        self.assertEqual(len(got["days"]), 3)

    def test_stale_writer_gets_409_with_latest_state(self):
        client = fresh_client()
        trip = seed_trip()
        self.assertEqual(client.put("/",
                         json={"expectedRevision": 0, "trip": trip}).status_code, 200)
        # Second writer on the same base revision → conflict, latest returned.
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["trip"]["revision"], 1)

    def test_atomic_concurrent_writes_one_success_one_conflict(self):
        # Drive two CAS calls through the same memory backend on threads; the
        # lock must make exactly one win.
        memory = {}
        store = biwa_store.BiwaStore(memory=memory)
        trip = seed_trip()
        trip["revision"] = 1
        payload = json.dumps(trip)
        results = []

        def attempt():
            results.append(store.cas_trip(0, payload)[0])

        threads = [threading.Thread(target=attempt) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [False, True])

    def test_invalid_trip_rejected(self):
        client = fresh_client()
        trip = seed_trip()
        trip["places"][0]["lat"] = 999  # out of range
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)
        self.assertIn("lat", res.json()["message"])

    def test_unknown_programme_membership_rejected(self):
        client = fresh_client()
        trip = seed_trip()
        trip["places"][0]["programmes"] = ["rally", "made-up-programme"]
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)

    def test_dangling_stop_reference_rejected(self):
        client = fresh_client()
        trip = seed_trip()
        trip["days"][0]["stops"][0]["placeId"] = "no-such-place"
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)

    def test_null_coord_custom_place_needs_a_resolver(self):
        client = fresh_client()
        trip = seed_trip()
        trip["places"].append({
            "placeId": "custom-x", "label": "X", "lat": None, "lng": None,
            "programmes": [], "category": "custom", "nameConfirmed": True, "notes": ""})
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)
        # The same record is fine once a Google place id or address is set.
        trip["places"][-1]["googlePlaceId"] = "ChIJd8BlQ2BZwokRAFUEcm_qrcA"
        res2 = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res2.status_code, 200, res2.text)

    def test_write_rate_limit(self):
        client = fresh_client()
        trip = seed_trip()
        res = None
        for i in range(biwa_store.WRITE_RATE_LIMIT + 2):
            # Always "stale" after the first write — cheap way to exercise the
            # limiter without seeding a chain of revisions.
            res = client.put("/", json={"expectedRevision": i, "trip": trip})
        self.assertEqual(res.status_code, 429)


class CanonicalManifestTests(unittest.TestCase):
    """The server-side manifest must be a mechanical copy of the client
    catalogue, and the validator must enforce its immutable fields."""

    def test_manifest_matches_client_catalogue(self):
        with open(os.path.join(ROOT, "lib", "biwa", "biwa-checkpoints.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        with open(CHECKPOINTS_PATH, encoding="utf-8") as f:
            client = json.load(f)
        self.assertEqual(manifest["places"], client["places"])

    def test_canonical_coordinate_tampering_rejected(self):
        trip = seed_trip()
        trip["places"][0]["lat"] += 0.001
        self.assertTrue(any("checkpoint source" in e for e in biwa_models.validate_trip(trip)))

    def test_canonical_membership_tampering_rejected(self):
        trip = seed_trip()
        trip["places"][0]["programmes"] = []
        self.assertTrue(any("checkpoint source" in e for e in biwa_models.validate_trip(trip)))

    def test_missing_catalogue_place_rejected(self):
        trip = seed_trip()
        trip["places"] = trip["places"][:-1]
        self.assertTrue(any("missing" in e for e in biwa_models.validate_trip(trip)))

    def test_custom_place_cannot_mint_membership(self):
        trip = seed_trip()
        trip["places"].append({
            "placeId": "custom-x", "label": "X", "lat": 35.0, "lng": 135.9,
            "programmes": ["rally"], "category": "custom", "nameConfirmed": True, "notes": ""})
        self.assertTrue(any("empty for custom" in e for e in biwa_models.validate_trip(trip)))

    def test_programme_status_requires_membership(self):
        trip = seed_trip()
        trip["places"].append({
            "placeId": "custom-x", "label": "X", "lat": 35.0, "lng": 135.9,
            "programmes": [], "category": "custom", "nameConfirmed": True, "notes": ""})
        trip["programmeStatus"]["rally"]["custom-x"] = True
        self.assertTrue(any("not a member" in e for e in biwa_models.validate_trip(trip)))

    def test_official_check_on_rally_only_place_rejected(self):
        trip = seed_trip()
        trip["programmeStatus"]["official"]["rally-castle"] = True
        self.assertTrue(any("not a member" in e for e in biwa_models.validate_trip(trip)))


class ShapeHardeningTests(unittest.TestCase):
    def test_days_must_be_exactly_three(self):
        trip = seed_trip()
        trip["days"] = trip["days"][:2]
        self.assertTrue(any("exactly 3" in e for e in biwa_models.validate_trip(trip)))
        trip2 = seed_trip()
        trip2["days"] = []
        self.assertTrue(any("exactly 3" in e for e in biwa_models.validate_trip(trip2)))

    def test_bool_revision_rejected(self):
        trip = seed_trip()
        trip["revision"] = True
        self.assertTrue(any("revision" in e for e in biwa_models.validate_trip(trip)))

    def test_unknown_nested_fields_rejected(self):
        trip = seed_trip()
        trip["places"][0]["smuggled"] = 1
        self.assertTrue(any("unknown fields" in e for e in biwa_models.validate_trip(trip)))
        trip2 = seed_trip()
        trip2["days"][0]["stops"][0]["extra"] = "x"
        self.assertTrue(any("unknown fields" in e for e in biwa_models.validate_trip(trip2)))

    def test_unhashable_reference_yields_422_not_500(self):
        client = fresh_client()
        trip = seed_trip()
        trip["days"][0]["stops"][0]["placeId"] = {"bad": "shape"}
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)

    def test_unhashable_category_yields_422_not_500(self):
        client = fresh_client()
        trip = seed_trip()
        trip["places"].append({
            "placeId": "custom-x", "label": "X", "lat": 35.0, "lng": 135.9,
            "programmes": [], "category": {"bad": "shape"},
            "nameConfirmed": True, "notes": ""})
        res = client.put("/", json={"expectedRevision": 0, "trip": trip})
        self.assertEqual(res.status_code, 422)

    def test_endpoint_pin_and_place_id_both_rejected(self):
        trip = seed_trip()
        trip["days"][0]["end"] = {
            "placeId": "rally-rental",
            "pin": {"label": "x", "lat": 35.0, "lng": 135.9}}
        self.assertTrue(any("not both" in e for e in biwa_models.validate_trip(trip)))

    def test_missing_manifest_fails_closed(self):
        # Simulate a manifest that could not be loaded at import: every write
        # must be rejected, not silently pass with an empty catalogue.
        real = biwa_models.CANONICAL
        try:
            biwa_models.CANONICAL = None
            self.assertTrue(biwa_models.validate_trip(seed_trip()))
        finally:
            biwa_models.CANONICAL = real

    def test_bool_expected_revision_rejected(self):
        client = fresh_client()
        res = client.put("/", json={"expectedRevision": True, "trip": seed_trip()})
        self.assertEqual(res.status_code, 400)

    def test_empty_coordinates_rejected(self):
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1", "orderedCoordinates": []}))
        res = TestClient(biwa_route.app).post("/", json={
            "dayId": "day-1", "requestId": "r1", "orderedCoordinates": []})
        self.assertEqual(res.status_code, 422)

    def test_state_responses_are_private_no_store(self):
        client = fresh_client()
        res = client.get("/")
        self.assertEqual(res.headers.get("cache-control"), "private, no-store")

    def test_memory_backend_disallowed_on_vercel(self):
        os.environ["VERCEL"] = "1"
        try:
            store = biwa_store.BiwaStore()
            self.assertFalse(store.configured)
        finally:
            os.environ.pop("VERCEL", None)


class ValidationTests(unittest.TestCase):
    def test_route_request_bounds(self):
        coords = [{"lat": 35.0 + i * 0.01, "lng": 135.9} for i in range(27)]
        self.assertEqual(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1", "orderedCoordinates": coords}), [])
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1", "orderedCoordinates": coords + [coords[0]]}))
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1", "orderedCoordinates": coords[:1]}))
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1",
             "orderedCoordinates": [{"lat": "x", "lng": 1}, {"lat": 1, "lng": 1}]}))

    def test_validator_accepts_seed(self):
        self.assertEqual(biwa_models.validate_trip(seed_trip()), [])

    def test_visit_status_must_reference_real_occurrences(self):
        trip = seed_trip()
        trip["visitStatus"]["ghost-occurrence"] = True
        self.assertTrue(any("visitStatus" in e for e in biwa_models.validate_trip(trip)))

    def test_endpoint_occurrence_visit_keys_are_valid(self):
        # Manual endpoint ticks (day-N-start / day-N-end) are first-class
        # visit rows — the rental finish included.
        trip = seed_trip()
        trip["visitStatus"]["day-1-start"] = True
        trip["visitStatus"]["day-3-end"] = True
        self.assertEqual(biwa_models.validate_trip(trip), [])
        # …but only for endpoints that exist.
        trip["days"][0]["end"] = None
        trip["visitStatus"]["day-1-end"] = True
        self.assertTrue(any("visitStatus" in e for e in biwa_models.validate_trip(trip)))


class RouteEndpointTests(unittest.TestCase):
    def setUp(self):
        biwa_route.store._memory.clear()
        self.client = TestClient(biwa_route.app)

    def _post(self, body, headers=None):
        return self.client.post("/", headers=headers or {}, json=body)

    def test_route_is_public_but_validates(self):
        # No auth needed — but the shape still fails closed.
        res = self._post({"dayId": "day-4", "requestId": "r1",
                          "orderedCoordinates": [{"lat": 1, "lng": 1}, {"lat": 2, "lng": 2}]})
        self.assertEqual(res.status_code, 422)

    def test_cross_origin_route_rejected(self):
        res = self._post({"dayId": "day-1", "requestId": "r1",
                          "orderedCoordinates": [{"lat": 1, "lng": 1}, {"lat": 2, "lng": 2}]},
                         headers={"Origin": "https://example.evil"})
        self.assertEqual(res.status_code, 403)

    def test_provider_not_configured_is_honest_503(self):
        res = self._post({"dayId": "day-1", "requestId": "r1",
                          "orderedCoordinates": [{"lat": 35.0, "lng": 135.9},
                                                 {"lat": 35.1, "lng": 136.0}]})
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["error"], "not_configured")

    def test_provider_failure_does_not_fabricate_metrics(self):
        # Inject a failing transport: route endpoint must surface a clean
        # error — never zero or invented distance.
        def failing_post(url, payload, headers, timeout):
            raise RuntimeError("network down")
        result = biwa_routing.compute_route(
            [{"lat": 35.0, "lng": 135.9}, {"lat": 35.1, "lng": 136.0}],
            server_key="fake", http_post=failing_post)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "provider_error")
        # Exception details (which may embed key-bearing URLs) must never
        # reach the client-facing message.
        self.assertEqual(result["message"], "Routes provider request failed.")
        self.assertNotIn("network down", result["message"])

    def test_http_error_is_generic_provider_error(self):
        import urllib.error
        def http_error_post(url, payload, headers, timeout):
            raise urllib.error.HTTPError(url, 500, "Server Error", {}, None)
        result = biwa_routing.compute_route(
            [{"lat": 35.0, "lng": 135.9}, {"lat": 35.1, "lng": 136.0}],
            server_key="fake", http_post=http_error_post)
        self.assertEqual(result["error"], "provider_error")
        self.assertEqual(result["message"], "Routes provider request failed.")

    def test_http_403_names_the_fix_without_leaking(self):
        # A 403 gets its own code so the UI can say "enable the Routes API"
        # without exposing the provider's body (which can embed the key URL).
        import urllib.error
        def forbidden_post(url, payload, headers, timeout):
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        result = biwa_routing.compute_route(
            [{"lat": 35.0, "lng": 135.9}, {"lat": 35.1, "lng": 136.0}],
            server_key="fake", http_post=forbidden_post)
        self.assertEqual(result["error"], "provider_blocked")
        self.assertIn("Routes API", result["message"])
        self.assertNotIn("Forbidden", result["message"])

    def test_invalid_provider_output_is_route_unavailable(self):
        # A 200 with a missing/invalid polyline or distance must not
        # fabricate metrics — it reports route_unavailable.
        for body in ({"routes": [{"polyline": {}, "distanceMeters": 52300}]},
                     {"routes": [{"polyline": {"encodedPolyline": ""}, "distanceMeters": 1}]},
                     {"routes": [{"polyline": {"encodedPolyline": "abc"},
                                  "distanceMeters": "far"}]},
                     {"routes": [{"polyline": {"encodedPolyline": "abc"},
                                  "distanceMeters": -5}]},
                     {"routes": [{"polyline": {"encodedPolyline": "abc"},
                                  "distanceMeters": True}]}):
            def bad_post(url, payload, headers, timeout, _b=body):
                return 200, _b
            result = biwa_routing.compute_route(
                [{"lat": 35.0, "lng": 135.9}, {"lat": 35.1, "lng": 136.0}],
                server_key="fake", http_post=bad_post)
            self.assertFalse(result["ok"], body)
            self.assertEqual(result["error"], "route_unavailable")

    def test_route_success_shape_and_elevation_seam(self):
        # Stub a successful computeRoutes reply through the injected transport
        # and verify the response contract the client consumes.
        def fake_post(url, payload, headers, timeout):
            self.assertEqual(payload["travelMode"], "DRIVE")
            self.assertEqual(payload["routingPreference"], "TRAFFIC_UNAWARE")
            self.assertFalse(payload["optimizeWaypointOrder"])
            self.assertTrue(payload["routeModifiers"]["avoidTolls"])
            self.assertEqual(headers["X-Goog-FieldMask"],
                             biwa_routing.ROUTES_FIELD_MASK)
            return 200, {"routes": [{
                "distanceMeters": 52300,
                "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC"},
                "legs": [{"distanceMeters": 52300}],
            }]}

        result = biwa_routing.compute_route(
            [{"lat": 35.0, "lng": 135.9}, {"lat": 35.1, "lng": 136.0}],
            server_key="fake", http_post=fake_post)
        self.assertTrue(result["ok"])
        self.assertEqual(result["distanceMeters"], 52300)
        # The elevation seam reports 'unavailable' until the lead authors it.
        elevation = biwa_routing.sampled_terrain_ascent(result["polyline"], "fake")
        self.assertEqual(elevation["status"], "unavailable")

    def test_compute_route_uses_order_and_25_intermediate_cap(self):
        captured = {}

        def fake_post(url, payload, headers, timeout):
            captured["payload"] = payload
            return 200, {"routes": [{"distanceMeters": 1,
                                     "polyline": {"encodedPolyline": ""},
                                     "legs": []}]}

        coords = [{"lat": 35.0 + i * 0.01, "lng": 135.9} for i in range(27)]
        biwa_routing.compute_route(coords, server_key="fake", http_post=fake_post)
        self.assertEqual(len(captured["payload"]["intermediates"]), 25)
        self.assertEqual(captured["payload"]["intermediates"][0]["location"]["latLng"]["latitude"],
                         coords[1]["lat"])

    def test_mixed_route_points_send_place_id_anchors(self):
        # Stored coords become latLng waypoints; a {googlePlaceId} point rides
        # as a Places waypoint — the two shapes mix in one request.
        captured = {}

        def fake_post(url, payload, headers, timeout):
            captured["payload"] = payload
            return 200, {"routes": [{"distanceMeters": 1,
                                     "polyline": {"encodedPolyline": "abc"},
                                     "legs": []}]}

        result = biwa_routing.compute_route(
            [{"googlePlaceId": "ChIJywsFgWAMAWAR7ceHyARQ9Gw"},
             {"lat": 35.0, "lng": 135.9},
             {"lat": 35.1, "lng": 136.0}],
            server_key="fake", http_post=fake_post)
        self.assertTrue(result["ok"])
        # A Google-id anchor rides the waypoint's placeId field (the Routes
        # API accepts placeId directly on a waypoint).
        self.assertEqual(captured["payload"]["origin"]["placeId"],
                         "ChIJywsFgWAMAWAR7ceHyARQ9Gw")
        self.assertEqual(captured["payload"]["destination"]["location"]["latLng"],
                         {"latitude": 35.1, "longitude": 136.0})

    def test_mixed_route_point_validation(self):
        gid = {"googlePlaceId": "ChIJywsFgWAMAWAR7ceHyARQ9Gw"}
        self.assertEqual(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1",
             "orderedCoordinates": [gid, {"lat": 1, "lng": 1}]}), [])
        # A point with neither coords nor a valid Google id is rejected.
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1",
             "orderedCoordinates": [{"label": "x"}, {"lat": 1, "lng": 1}]}))
        # A point carrying BOTH a googlePlaceId and lat/lng is ambiguous.
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-1", "requestId": "r1",
             "orderedCoordinates": [
                 {"googlePlaceId": gid["googlePlaceId"], "lat": 1, "lng": 1}, gid]}))
        # dayId is echoed for client staleness guards — only this trip's
        # three days are legitimate.
        self.assertTrue(biwa_models.validate_route_request(
            {"dayId": "day-4", "requestId": "r1",
             "orderedCoordinates": [gid, gid]}))


class PlaceAndPhotoEndpointTests(unittest.TestCase):
    """Transient Google lookups by INTERNAL place id — never an open proxy."""

    def setUp(self):
        self.client = TestClient(biwa_place.app)
        self.photo_client = TestClient(biwa_photo.app)

    def test_missing_place_id_rejected(self):
        self.assertEqual(self.client.get("/").status_code, 422)
        self.assertEqual(self.client.get("/?placeId=").status_code, 422)
        self.assertEqual(self.photo_client.get("/?placeId=stay-hana&index=x").status_code, 422)

    def test_server_key_absent_is_honest_503(self):
        # No Google server key configured in this test env → fail closed.
        res = self.client.get("/?placeId=stay-hana")
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["error"], "not_configured")

    def test_unknown_place_404_with_key(self):
        old = biwa_store.GOOGLE_PLACES_KEY
        try:
            biwa_store.GOOGLE_PLACES_KEY = "fake"
            res = self.client.get("/?placeId=no-such-place")
            self.assertEqual(res.status_code, 404)
        finally:
            biwa_store.GOOGLE_PLACES_KEY = old

    def test_place_details_normalized_and_transient(self):
        # Inject a Places transport; the reply must be normalized small and
        # carry no-store headers — provider data is never persisted.
        def fake_get(url, headers=None, timeout_s=None):
            return 200, {
                "displayName": {"text": "Guest House Hana"},
                "formattedAddress": "1-2-3 Hamaotsu",
                "location": {"latitude": 35.0, "longitude": 135.9},
                "businessStatus": "OPERATIONAL",
                "regularOpeningHours": {"openNow": True,
                                        "weekdayDescriptions": ["Mon: 9-5"]},
                "googleMapsUri": "https://maps.google.com/?cid=1",
                "photos": [{"name": "p1",
                            "authorAttributions": [{"displayName": "A"}]}],
                "attributions": [{"displayName": "Third party"}],
            }
        old_key = biwa_store.GOOGLE_PLACES_KEY
        old_fetch = biwa_places.fetch_place_details

        def injected(gid, key, http_get=None):
            return fake_get("url")[1]

        try:
            biwa_store.GOOGLE_PLACES_KEY = "fake"
            biwa_places.fetch_place_details = injected
            res = self.client.get("/?placeId=stay-hana")
            self.assertEqual(res.status_code, 200, res.text)
            body = res.json()
            self.assertTrue(body["ok"])
            d = body["details"]
            self.assertEqual(d["name"], "Guest House Hana")
            self.assertEqual(d["location"], {"lat": 35.0, "lng": 135.9})
            self.assertEqual(d["photos"][0]["authorAttributions"][0]["displayName"], "A")
            self.assertEqual(res.headers.get("cache-control"), "private, no-store")
        finally:
            biwa_store.GOOGLE_PLACES_KEY = old_key
            biwa_places.fetch_place_details = old_fetch

    def test_photo_host_allowlist(self):
        self.assertTrue(biwa_places.allowed_photo_host(
            "https://lh3.googleusercontent.com/p/AF1Qip_x"))
        self.assertTrue(biwa_places.allowed_photo_host(
            "https://geo0.ggpht.com/p/x"))
        self.assertFalse(biwa_places.allowed_photo_host("https://evil.example/x"))
        self.assertFalse(biwa_places.allowed_photo_host("http://lh3.googleusercontent.com/x"))
        self.assertFalse(biwa_places.allowed_photo_host("not a url"))

    def test_photo_unknown_place_404_with_key(self):
        old = biwa_store.GOOGLE_PLACES_KEY
        try:
            biwa_store.GOOGLE_PLACES_KEY = "fake"
            res = self.photo_client.get("/?placeId=no-such-place&index=0")
            self.assertEqual(res.status_code, 404)
        finally:
            biwa_store.GOOGLE_PLACES_KEY = old


if __name__ == "__main__":
    unittest.main()
