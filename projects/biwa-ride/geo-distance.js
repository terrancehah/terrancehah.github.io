/* Geographic distance for Nearby: a straight-line estimate, never a road
 * distance or riding-time promise. GPS and transient Google locations are
 * consumed in memory only; this module does not persist either input. */
(function (global) {
  'use strict';

  function isPoint(point) {
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
      Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
  }

  function distanceMeters(origin, destination) {
    if (!isPoint(origin) || !isPoint(destination)) return null;
    var radians = Math.PI / 180;
    var latitudeDelta = (destination.lat - origin.lat) * radians;
    var longitudeDelta = (destination.lng - origin.lng) * radians;
    var haversine = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(origin.lat * radians) * Math.cos(destination.lat * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
    return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
  }

  var api = { distanceMeters: distanceMeters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BiwaGeoDistance = api;
})(typeof window !== 'undefined' ? window : globalThis);
