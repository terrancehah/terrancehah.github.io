/* Independently known spherical distances; no API or GPS access. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../../projects/biwa-ride/geo-distance.js');

test('equatorial degree and identical points have known distances', () => {
  const oneDegree = 6371008.8 * Math.PI / 180;
  assert.ok(Math.abs(geo.distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - oneDegree) < 1e-6);
  assert.equal(geo.distanceMeters({ lat: 35, lng: 136 }, { lat: 35, lng: 136 }), 0);
});

test('distance is symmetric and handles the date line', () => {
  const a = { lat: 35.01, lng: 135.86 }, b = { lat: 35.27, lng: 136.26 };
  assert.ok(Math.abs(geo.distanceMeters(a, b) - geo.distanceMeters(b, a)) < 1e-6);
  assert.ok(geo.distanceMeters({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 }) < 23000);
});

test('missing, nonfinite and out-of-range coordinates are unavailable', () => {
  for (const invalid of [null, {}, { lat: NaN, lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: Infinity }]) {
    assert.equal(geo.distanceMeters(invalid, { lat: 35, lng: 136 }), null);
  }
});
