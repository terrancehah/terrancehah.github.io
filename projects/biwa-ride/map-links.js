/* map-links.js — builders for cross-platform Google Maps URLs.
 *
 * These are key-free universal Maps links (developers.google.com/maps/
 * documentation/urls). They open Google Maps on any device and never claim
 * capabilities the URL scheme does not have: driving directions cannot carry
 * the Routes API avoidance flags, and mobile browsers accept at most three
 * intermediate waypoints per link. Japanese labels are percent-encoded.
 *
 * Points anchor by Google place id when one is verified (the link lands on
 * the exact listing), else the written address, else the label, else raw
 * coordinates — null-coordinate places are never linked as 0,0.
 */
(function (global) {
  'use strict';

  var MapLinks = {};

  var SEARCH_BASE = 'https://www.google.com/maps/search/?api=1';
  var DIR_BASE = 'https://www.google.com/maps/dir/?api=1';

  // Mobile browsers support at most 3 intermediate waypoints per directions
  // link, so one section holds at most 5 points (origin + 3 + destination).
  MapLinks.MAX_INTERMEDIATE_WAYPOINTS = 3;

  function hasCoords(point) {
    return point && typeof point.lat === 'number' && typeof point.lng === 'number';
  }

  function coord(point) {
    return point.lat + ',' + point.lng;
  }

  // The human-readable query half of a link. Address wins when present
  // (exact for address-only records); a place-id-anchored link keeps its
  // label as the readable hint; otherwise coordinates are the precise
  // anchor — a typed label is a display name, never a search query.
  function pointQuery(point) {
    if (point.address) return point.address;
    if (point.googlePlaceId && point.label) return point.label;
    if (hasCoords(point)) return coord(point);
    if (point.label) return point.label;
    return '';
  }

  // Link for one point: place id anchor when verified, else its best text.
  // Returns null when nothing can anchor the link (never a bogus URL).
  function pointQueryParams(point, prefix) {
    if (!point) return null;
    var params = '&' + prefix + '=' + encodeURIComponent(pointQuery(point));
    if (point.googlePlaceId) params += '&' + prefix + '_place_id=' +
      encodeURIComponent(point.googlePlaceId);
    return params;
  }

  // Place-details link used for opening hours and business information. The
  // place id anchors to the exact listing; the query falls back to address
  // then label so unresolved records still land somewhere sensible.
  MapLinks.placeDetailsUrl = function (place) {
    return SEARCH_BASE + '&query=' + encodeURIComponent(pointQuery(place)) +
      (place.googlePlaceId
        ? '&query_place_id=' + encodeURIComponent(place.googlePlaceId)
        : '');
  };

  // Coordinate-precise map pin link for places whose label may not resolve
  // cleanly. Coordinate-less places fall back to their address/place id —
  // never a 0,0 pin.
  MapLinks.pinUrl = function (point) {
    if (hasCoords(point)) {
      return SEARCH_BASE + '&query=' + encodeURIComponent(coord(point));
    }
    return MapLinks.placeDetailsUrl(point);
  };

  // Turn-by-turn handoff with no origin: Google fills in the rider's current
  // position. Driving mode matches the in-app road preview — the link cannot
  // carry highway/toll avoidance flags, and we never claim otherwise.
  MapLinks.directionsUrl = function (destination, options) {
    var url = DIR_BASE +
      '&destination=' + encodeURIComponent(pointQuery(destination)) +
      '&travelmode=driving';
    if (destination.googlePlaceId) {
      url += '&destination_place_id=' + encodeURIComponent(destination.googlePlaceId);
    }
    if (options && options.origin) {
      url += '&origin=' + encodeURIComponent(pointQuery(options.origin));
      if (options.origin.googlePlaceId) {
        url += '&origin_place_id=' + encodeURIComponent(options.origin.googlePlaceId);
      }
    }
    return url;
  };

  // Split an ordered point list into overlapping sections honouring the
  // 3-intermediate-waypoint mobile limit. Sections share their boundary
  // point so every stop is preserved and the order stays anticlockwise.
  // Place ids ride along in waypoint_place_ids only when EVERY intermediate
  // has one (the lists must align); verified ids still anchor each end.
  MapLinks.dayDirectionsUrls = function (orderedPoints) {
    var maxPointsPerSection = MapLinks.MAX_INTERMEDIATE_WAYPOINTS + 2;
    var sections = [];
    if (!orderedPoints || orderedPoints.length < 2) return sections;
    var i = 0;
    while (i < orderedPoints.length - 1) {
      var slice = orderedPoints.slice(i, i + maxPointsPerSection);
      var origin = slice[0];
      var destination = slice[slice.length - 1];
      var intermediates = slice.slice(1, -1);
      var url = DIR_BASE +
        '&origin=' + encodeURIComponent(pointQuery(origin)) +
        '&destination=' + encodeURIComponent(pointQuery(destination)) +
        '&travelmode=driving';
      if (origin.googlePlaceId) {
        url += '&origin_place_id=' + encodeURIComponent(origin.googlePlaceId);
      }
      if (destination.googlePlaceId) {
        url += '&destination_place_id=' + encodeURIComponent(destination.googlePlaceId);
      }
      if (intermediates.length) {
        url += '&waypoints=' + intermediates
          .map(function (p) { return encodeURIComponent(pointQuery(p)); })
          .join('%7C');
        if (intermediates.every(function (p) { return !!p.googlePlaceId; })) {
          url += '&waypoint_place_ids=' + intermediates
            .map(function (p) { return encodeURIComponent(p.googlePlaceId); })
            .join('%7C');
        }
      }
      sections.push({ url: url, from: origin.label, to: destination.label });
      // Overlap: next section starts at this section's destination.
      i += maxPointsPerSection - 1;
    }
    return sections;
  };

  // Nearby category search anchored on a coordinate (selected stop/town or
  // user-granted geolocation). Results are arbitrary Google listings — the
  // UI must not label them bicycle-friendly; that label is reserved for the
  // user's curated list.
  MapLinks.nearbySearchUrl = function (categoryQuery, center) {
    var query = categoryQuery + ' near ' + center.lat + ',' + center.lng;
    return SEARCH_BASE + '&query=' + encodeURIComponent(query);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MapLinks;
  global.BiwaMapLinks = MapLinks;
})(typeof window !== 'undefined' ? window : globalThis);
