/* Match Google road legs to visible stops without dropping hidden waypoints.
 * A missing anchor, stale order or invalid leg makes distances unavailable;
 * straight-line measurements must never masquerade as road distances.
 */
(function (global) {
  'use strict';

  function visibleLegDistances(trip, day, routeState) {
    var rules = global.BiwaRules;
    var result = {};
    var full = rules.dayPoints(trip, day);
    var visible = rules.visibleDayPoints(trip, day);
    var routed = rules.routePoints(trip, day);
    if (!routeState || routeState.status !== 'ok' ||
        routeState.signature !== JSON.stringify(routed.points) ||
        routed.unroutable.length || routed.points.length !== full.length ||
        !Array.isArray(routeState.legsMeters) ||
        routeState.legsMeters.length !== full.length - 1 ||
        !routeState.legsMeters.every(function (n) {
          return typeof n === 'number' && Number.isFinite(n) && n >= 0;
        })) return result;

    // Occurrence IDs distinguish repeated destinations and overnight roles.
    var positions = {};
    full.forEach(function (p, i) { positions[p.occurrenceId] = i; });
    for (var i = 1; i < visible.length; i++) {
      var from = positions[visible[i - 1].occurrenceId];
      var to = positions[visible[i].occurrenceId];
      if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) continue;
      var meters = 0;
      for (var leg = from; leg < to; leg++) meters += routeState.legsMeters[leg];
      result[visible[i].occurrenceId] = meters;
    }
    return result;
  }

  // At the rider-selected 15 km/h, one kilometre takes four minutes.
  // Round up so a positive short leg never appears as a zero-minute ride.
  function estimatedCyclingMinutes(meters) {
    if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null;
    return Math.ceil(meters / 1000 / 15 * 60);
  }

  global.BiwaStopDistances = {
    visibleLegDistances: visibleLegDistances,
    estimatedCyclingMinutes: estimatedCyclingMinutes
  };
})(typeof window !== 'undefined' ? window : globalThis);
