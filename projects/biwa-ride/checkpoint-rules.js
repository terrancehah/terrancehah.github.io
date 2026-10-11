/* checkpoint-rules.js — pure group/rally progress calculations.
 *
 * These functions never touch the DOM, storage or the network so they can be
 * unit-tested under `node --test` and reused by every view. All shared state
 * lives in the trip snapshot (schema v2):
 *
 *   trip.places            — catalogue (programme membership is immutable
 *                            source metadata, independent of itinerary edits)
 *   trip.days[].stops[]    — itinerary occurrences {occurrenceId, placeId}
 *   trip.days[].start/end  — endpoints; implicit occurrence ids dayId-start /
 *                            dayId-end make them tickable like stops
 *   trip.visitStatus       — {occurrenceId: true} manual per-occurrence visits
 *   trip.programmeStatus   — {rally: {placeId: true}, official: {placeId: true}}
 *                            shared manual checklist, keyed by programme FAMILY
 *   One arrival tick marks the row's visit flag AND every programme family
 *   the place belongs to — a shared checkpoint (Mizudori) clears both.
 */
(function (global) {
  'use strict';

  var BiwaRules = {};

  // Official checkpoint programme ids grouped by lakeside area. The rally is
  // a single ten-stop programme, not area based.
  BiwaRules.OFFICIAL_AREAS = [
    { key: 'south', programme: 'official-south', label: 'South shore' },
    { key: 'east', programme: 'official-east', label: 'East shore' },
    { key: 'north', programme: 'official-north', label: 'North shore' },
    { key: 'west', programme: 'official-west', label: 'West shore' }
  ];
  BiwaRules.RALLY_TOTAL = 10;

  // Index places by stable placeId for O(1) lookup everywhere else.
  BiwaRules.placesById = function (trip) {
    var map = {};
    (trip.places || []).forEach(function (p) { map[p.placeId] = p; });
    return map;
  };

  // Does this source place belong to a given programme? Programme membership
  // comes from the checkpoint catalogue, not the itinerary, so removing a
  // stop from a day never removes it from the certificate catalogue.
  BiwaRules.placeInProgramme = function (place, programme) {
    return !!(place && place.programmes && place.programmes.indexOf(programme) !== -1);
  };

  // All catalogue places carrying rally membership (expected total: 10).
  BiwaRules.rallyPlaces = function (trip) {
    return (trip.places || []).filter(function (p) {
      return BiwaRules.placeInProgramme(p, 'rally');
    });
  };

  // All catalogue places for one official area, e.g. 'south' -> official-south.
  BiwaRules.officialPlacesForArea = function (trip, areaKey) {
    var area = BiwaRules.OFFICIAL_AREAS.filter(function (a) { return a.key === areaKey; })[0];
    if (!area) return [];
    return (trip.places || []).filter(function (p) {
      return BiwaRules.placeInProgramme(p, area.programme);
    });
  };

  function isProgrammeChecked(trip, programme, placeId) {
    var status = trip.programmeStatus && trip.programmeStatus[programme];
    return !!(status && status[placeId]);
  }

  // The programmeStatus families a place's membership maps to — 'rally' plus
  // 'official' for any official-* area, so one tick can mark both.
  BiwaRules.programmeFamilies = function (programmes) {
    var fams = [];
    (programmes || []).forEach(function (p) {
      if (p === 'rally' && fams.indexOf('rally') === -1) fams.push('rally');
      else if (typeof p === 'string' && p.indexOf('official-') === 0 &&
               fams.indexOf('official') === -1) fams.push('official');
    });
    return fams;
  };

  // Is the place checked for ANY programme family? Used to derive the arrival
  // state of every occurrence of the same place.
  BiwaRules.placeProgrammeChecked = function (trip, place) {
    return BiwaRules.programmeFamilies(place && place.programmes).some(function (f) {
      return isProgrammeChecked(trip, f, place.placeId);
    });
  };

  // The implicit occurrence id an endpoint row carries for manual visits.
  BiwaRules.endpointOccurrenceId = function (day, which) {
    return day.dayId + '-' + which;
  };

  // Derived arrival state for a row: its own visit flag, plus — for
  // programme places — the shared family check (a tick on one occurrence is
  // reflected on the place's other occurrences).
  BiwaRules.arrivalChecked = function (trip, occurrenceId, place) {
    if (trip.visitStatus && trip.visitStatus[occurrenceId]) return true;
    return BiwaRules.placeProgrammeChecked(trip, place);
  };

  // Apply one arrival tick: the row's own visit flag plus EVERY programme
  // family the place belongs to. Unchecking clears the place's programme
  // flags but never other occurrences' own visit flags.
  BiwaRules.applyArrival = function (draft, occurrenceId, place, checked) {
    draft.visitStatus = draft.visitStatus || {};
    if (occurrenceId) {
      if (checked) draft.visitStatus[occurrenceId] = true;
      else delete draft.visitStatus[occurrenceId];
    }
    BiwaRules.programmeFamilies(place && place.programmes).forEach(function (family) {
      BiwaRules.checkProgramme(draft, family, place.placeId, checked);
    });
  };

  // Rally progress: shared manual checks against the ten-stop catalogue.
  BiwaRules.rallyProgress = function (trip) {
    var places = BiwaRules.rallyPlaces(trip);
    var done = places.filter(function (p) {
      return isProgrammeChecked(trip, 'rally', p.placeId);
    }).length;
    return { done: done, total: places.length, complete: done === places.length && places.length > 0 };
  };

  // Official progress per area: an area counts as covered when at least one
  // of its checkpoints is checked (the programme asks for one per area).
  BiwaRules.officialAreaProgress = function (trip) {
    var areas = BiwaRules.OFFICIAL_AREAS.map(function (area) {
      var places = BiwaRules.officialPlacesForArea(trip, area.key);
      var checked = places.filter(function (p) {
        return isProgrammeChecked(trip, 'official', p.placeId);
      }).length;
      return {
        key: area.key,
        label: area.label,
        programme: area.programme,
        checked: checked,
        total: places.length,
        covered: checked >= 1,
        places: places
      };
    });
    var coveredCount = areas.filter(function (a) { return a.covered; }).length;
    return {
      areas: areas,
      coveredCount: coveredCount,
      totalAreas: areas.length,
      complete: coveredCount === areas.length && areas.length > 0
    };
  };

  // Group checklist completion is a housekeeping label, not an official
  // award — the UI must say "Group checklist complete", never "Certificate
  // earned", because this app neither submits nor verifies official stamps.
  BiwaRules.groupChecklist = function (trip) {
    var rally = BiwaRules.rallyProgress(trip);
    var official = BiwaRules.officialAreaProgress(trip);
    return {
      rally: rally,
      official: official,
      complete: rally.complete && official.complete,
      label: 'Group checklist complete'
    };
  };

  // Programme badges for a stop row, e.g. ['Rally', 'Official · North'].
  BiwaRules.placeBadges = function (place) {
    var badges = [];
    if (!place || !place.programmes) return badges;
    if (place.programmes.indexOf('rally') !== -1) badges.push('Rally');
    BiwaRules.OFFICIAL_AREAS.forEach(function (area) {
      if (place.programmes.indexOf(area.programme) !== -1) {
        badges.push('Official · ' + area.label.replace(' shore', ''));
      }
    });
    return badges;
  };

  // Ordered row list for a day: start endpoint, each stop in order, then the
  // end endpoint. Rows carry everything the timeline/map/links need: visit
  // state, badges metadata and the transient anchors (googlePlaceId /
  // address — coordinates may legitimately be null for resolved extras).
  // Missing endpoints are skipped here; the caller renders an explicit
  // missing-endpoint state so nothing is dropped silently.
  BiwaRules.dayPoints = function (trip, day) {
    var places = BiwaRules.placesById(trip);
    var points = [];
    function placePoint(p, kind, occurrenceId) {
      return {
        kind: kind,
        occurrenceId: occurrenceId,
        placeId: p.placeId,
        label: p.label,
        lat: p.lat,
        lng: p.lng,
        googlePlaceId: p.googlePlaceId || null,
        address: p.address || null,
        category: p.category || null,
        place: p,
        visited: BiwaRules.arrivalChecked(trip, occurrenceId, p)
      };
    }
    function pushEndpoint(endpoint, kind) {
      if (!endpoint) return;
      var occurrenceId = BiwaRules.endpointOccurrenceId(day, kind);
      if (endpoint.placeId && places[endpoint.placeId]) {
        points.push(placePoint(places[endpoint.placeId], kind, occurrenceId));
      } else if (endpoint.pin && typeof endpoint.pin.lat === 'number') {
        var pinPlace = { placeId: null, programmes: [] };
        points.push({
          kind: kind,
          occurrenceId: occurrenceId,
          placeId: null,
          label: endpoint.pin.label || 'Pinned point',
          lat: endpoint.pin.lat,
          lng: endpoint.pin.lng,
          googlePlaceId: null,
          address: null,
          category: 'pin',
          place: null,
          visited: !!(trip.visitStatus && trip.visitStatus[occurrenceId])
        });
      }
    }
    pushEndpoint(day.start, 'start');
    (day.stops || []).forEach(function (stop) {
      var p = places[stop.placeId];
      if (!p) return;
      points.push(placePoint(p, 'stop', stop.occurrenceId));
    });
    pushEndpoint(day.end, 'end');
    return points;
  };

  // The check-in rows a day presents to the rider: dayPoints minus the
  // hidden route-waypoint anchors. Waypoints steer the road line but are
  // not destinations — itinerary, completion, Nearby context and the map's
  // day location lists all read this view; routing keeps full dayPoints.
  BiwaRules.visibleDayPoints = function (trip, day) {
    return BiwaRules.dayPoints(trip, day).filter(function (p) {
      return !(p.place && p.place.category === 'route-waypoint');
    });
  };

  // The next unvisited row for the "up next" card — endpoints included, so
  // the day's first pending point may be the start lodging or the rental
  // finish, not only scheduled stops.
  BiwaRules.nextUnvisitedStop = function (trip, day) {
    var points = BiwaRules.visibleDayPoints(trip, day);
    for (var i = 0; i < points.length; i++) {
      if (!points[i].visited) return points[i];
    }
    return null;
  };

  // Provider-route anchors for a day: source coordinates where present, a
  // Google place id where the record is resolved transiently. Rows with
  // neither are reported as 'unroutable' rather than silently dropped.
  BiwaRules.routePoints = function (trip, day) {
    var points = BiwaRules.dayPoints(trip, day);
    var routable = [];
    var unroutable = [];
    points.forEach(function (p) {
      if (typeof p.lat === 'number' && typeof p.lng === 'number') {
        routable.push({ lat: p.lat, lng: p.lng });
      } else if (p.googlePlaceId) {
        routable.push({ googlePlaceId: p.googlePlaceId });
      } else {
        unroutable.push(p.label);
      }
    });
    return { points: routable, unroutable: unroutable };
  };

  // Every occurrence of a place across all days — scheduled stops AND
  // endpoint roles (repeated visits are valid; each carries its own flag).
  BiwaRules.occurrencesOf = function (trip, placeId) {
    var found = [];
    (trip.days || []).forEach(function (day) {
      ['start', 'end'].forEach(function (which) {
        var endpoint = day[which];
        if (endpoint && endpoint.placeId === placeId) {
          found.push({ dayId: day.dayId, occurrenceId: BiwaRules.endpointOccurrenceId(day, which), kind: which });
        }
      });
      (day.stops || []).forEach(function (stop) {
        if (stop.placeId === placeId) found.push({ dayId: day.dayId, occurrenceId: stop.occurrenceId, kind: 'stop' });
      });
    });
    return found;
  };

  // Reorder a stop inside its day, preserving its occurrenceId (and so its
  // visit flag). Used by drag reorder and the keyboard/sheet alternatives.
  BiwaRules.moveStopWithinDay = function (day, fromIndex, toIndex) {
    var stops = day.stops || [];
    if (fromIndex < 0 || fromIndex >= stops.length) return;
    if (toIndex < 0 || toIndex >= stops.length) return;
    var stop = stops.splice(fromIndex, 1)[0];
    stops.splice(toIndex, 0, stop);
  };

  // Move a stop occurrence to the END of another day, preserving its
  // occurrenceId/visit flag and honouring the provider stop cap.
  BiwaRules.moveStopBetweenDays = function (trip, fromDayId, occurrenceId, toDayId) {
    var from = (trip.days || []).filter(function (d) { return d.dayId === fromDayId; })[0];
    var to = (trip.days || []).filter(function (d) { return d.dayId === toDayId; })[0];
    if (!from || !to || from === to) return false;
    if ((to.stops || []).length >= BiwaRules.MAX_STOPS_PER_DAY) return false;
    var index = (from.stops || []).findIndex(function (s) { return s.occurrenceId === occurrenceId; });
    if (index === -1) return false;
    var stop = from.stops.splice(index, 1)[0];
    to.stops.push(stop);
    return true;
  };

  // 25 stops + 2 endpoints = 27 locations, the Google Routes cap.
  BiwaRules.MAX_STOPS_PER_DAY = 25;

  // Removing a stop from the itinerary must not change certificate progress:
  // programme status is keyed on placeId, not occurrenceId, by design.
  BiwaRules.checkProgramme = function (trip, programme, placeId, checked) {
    if (!trip.programmeStatus) trip.programmeStatus = {};
    if (!trip.programmeStatus[programme]) trip.programmeStatus[programme] = {};
    if (checked) trip.programmeStatus[programme][placeId] = true;
    else delete trip.programmeStatus[programme][placeId];
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BiwaRules;
  global.BiwaRules = BiwaRules;
})(typeof window !== 'undefined' ? window : globalThis);
