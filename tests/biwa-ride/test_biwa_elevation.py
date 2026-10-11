"""Deterministic terrain fixtures; no Google credentials or network calls."""

import importlib.util
import math
from pathlib import Path
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("biwa_elevation_test", ROOT / "lib/biwa/biwa-routing.py")
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)


def encode(points):
    """Independent fixture encoder for Google's E5 signed-delta format."""
    result, previous = [], [0, 0]
    for point in points:
        for axis, value in enumerate(point):
            integer = round(value * 100000)
            delta = integer - previous[axis]
            previous[axis] = integer
            unsigned = ~(delta << 1) if delta < 0 else delta << 1
            while unsigned >= 32:
                # The continuation byte is bits 0..5 plus ASCII offset.
                result.append(chr(((unsigned & 31) | 32) + 63))
                unsigned >>= 5
            result.append(chr(unsigned + 63))
    return "".join(result)


class TerrainTests(unittest.TestCase):
    def test_canonical_polyline(self):
        points = routing._decode_route("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        self.assertEqual(points, [
            {"lat": 38.5, "lng": -120.2},
            {"lat": 40.7, "lng": -120.95},
            {"lat": 43.252, "lng": -126.453},
        ])

    def test_spacing_length_and_exact_endpoints(self):
        # Equatorial degree has analytically known length R*pi/180.
        vertices = [{"lat": 0, "lng": 0}, {"lat": 0, "lng": 0.005},
                    {"lat": 0, "lng": 0.005}, {"lat": 0, "lng": 0.01}]
        samples = routing._sample_route(vertices)
        total = 6371008.8 * math.pi / 180 * 0.01
        self.assertAlmostEqual(samples[-1]["distanceMeters"], total, places=7)
        self.assertEqual([s["distanceMeters"] for s in samples[:-1]],
                         [float(d) for d in range(0, 1112, 100)])
        self.assertEqual(samples[0]["lng"], 0)
        self.assertEqual(samples[-1]["lng"], 0.01)
        self.assertAlmostEqual(samples[1]["lng"], 100 / total * 0.01)

    def test_short_path_duplicate_path_and_truncation(self):
        short = routing._sample_route([{"lat": 35, "lng": 136},
                                       {"lat": 35.00001, "lng": 136}])
        self.assertEqual(len(short), 2)
        self.assertEqual(routing._sample_route([{"lat": 35, "lng": 136}] * 3), [])
        for malformed in ["_", "?", "\x00"]:
            self.assertEqual(routing.sampled_terrain_ascent(malformed, "stub")["status"], "unavailable")

    def test_ordered_bounded_batches_and_flat_ascent(self):
        calls = []

        def flat_provider(url, timeout):
            self.assertLessEqual(len(url), 7500)
            self.assertGreater(timeout, 0)
            coords = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["locations"][0].split("|")
            self.assertLessEqual(len(coords), 512)
            calls.extend(coords)
            return 200, {"status": "OK", "results": [
                {"elevation": 80, "location": dict(zip(("lat", "lng"), map(float, coordinate.split(","))))}
                for coordinate in coords
            ]}

        result = routing.sampled_terrain_ascent(encode([(35, 136), (35.6, 136)]), "stub", flat_provider)
        self.assertEqual(result["status"], "ok")
        self.assertGreater(len(calls), 512)
        self.assertEqual(len(calls), len(result["samples"]))
        self.assertEqual(result["ascentMeters"], 0)
        self.assertEqual(result["samples"][0]["lat"], 35)
        self.assertEqual(result["samples"][-1]["lat"], 35.6)
        self.assertTrue(all(a["distanceMeters"] < b["distanceMeters"]
                            for a, b in zip(result["samples"], result["samples"][1:])))

    def test_known_smoothing_and_ascent(self):
        # 445m produces six samples; known terrain rises then falls.
        raw = [0, 0, 30, 60, 30, 0]
        expected = [10, 22.5, 24, 24, 30, 30]

        def terrain_provider(url, timeout):
            coords = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["locations"][0].split("|")
            self.assertEqual(len(coords), len(raw))
            return 200, {"status": "OK", "results": [
                {"elevation": value, "location": dict(zip(("lat", "lng"), map(float, coordinate.split(","))))}
                for coordinate, value in zip(coords, raw)
            ]}

        result = routing.sampled_terrain_ascent(encode([(0, 0), (0, 0.004)]), "stub", terrain_provider)
        self.assertEqual(result["status"], "ok")
        self.assertEqual([s["elevationMeters"] for s in result["samples"]], expected)
        self.assertEqual(result["ascentMeters"], 20)
        self.assertEqual(result["meta"]["filter"], "moving-mean-5")

    def test_provider_failure_missing_or_reordered_samples(self):
        route = encode([(35, 136), (35.001, 136)])
        bad_bodies = [
            {"status": "REQUEST_DENIED", "results": []},
            {"status": "OK", "results": []},
            {"status": "OK", "results": [{"elevation": 3, "location": {"lat": 0, "lng": 0}}] * 3},
        ]
        for body in bad_bodies:
            result = routing.sampled_terrain_ascent(route, "stub", lambda url, timeout: (200, body))
            self.assertEqual(result["status"], "unavailable")

        def failure(url, timeout):
            raise RuntimeError(url)

        result = routing.sampled_terrain_ascent(route, "private-stub", failure)
        self.assertNotIn("private-stub", str(result))
        self.assertEqual(result["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
