/* route-preview.js — in-app Google map rendering and route/elevation display.
 *
 * Rules from the plan/review:
 *  - Google Maps JavaScript loads on demand with the referrer-restricted
 *    browser key from the authenticated trip endpoint. The loader caches one
 *    attempt per key, times out the script tag with a retained safe callback,
 *    and retries when a previously missing key becomes configured.
 *  - The SVG fallback is a USER-OWNED stop schematic only: it draws the
 *    ordered stops the user entered and is labelled "Stop schematic — not a
 *    road route". Google's polyline, distance and elevation profile are only
 *    ever drawn on a real Google Map with attribution — never onto the
 *    fallback (that would detach provider content from its context/notice).
 *  - Stale-answer rule: every request carries a coordinate signature; a
 *    response whose signature no longer matches the displayed day is dropped.
 *  - Google content is transient: nothing here writes to storage.
 *  - Colours come from the CSS token layer (read via getComputedStyle), never
 *    hardcoded hexes — single source with biwa-tokens.css.
 */
(function (global) {
  'use strict';

  var RoutePreview = {};

  // Display-layer strings route through BiwaI18n when present — this module
  // loads before it and must still work standalone.
  function t(key) {
    return global.BiwaI18n ? global.BiwaI18n.t(key) : key;
  }

  var MAPS_LOAD_TIMEOUT_MS = 10000;

  RoutePreview._mapPromise = null;
  RoutePreview._mapsKeyUsed = undefined; // key the in-flight/cached attempt used
  RoutePreview._map = null;
  RoutePreview._mapDiv = null;
  RoutePreview._polyline = null;
  RoutePreview._markers = [];

  // --- colours from tokens ----------------------------------------------------

  function tokenColor(name, fallback) {
    try {
      var value = global.getComputedStyle(global.document.documentElement)
        .getPropertyValue(name).trim();
      return value || fallback;
    } catch (e) { return fallback; }
  }

  RoutePreview.colors = function () {
    return {
      route: tokenColor('--biwa-clay', '#b36a5e'),
      stop: tokenColor('--biwa-lake', '#2f5d6f'),
      ink: tokenColor('--biwa-ink', '#3a2a26'),
      inkSoft: tokenColor('--biwa-ink-soft', '#6b544d'),
      surface: tokenColor('--biwa-alabaster', '#eee2df'),
      lakeWash: tokenColor('--biwa-lake-wash', 'rgba(47,93,111,0.18)'),
      dayOne: tokenColor('--biwa-day-one', '#c45632'),
      dayTwo: tokenColor('--biwa-day-two', '#168de2'),
      dayThree: tokenColor('--biwa-day-three', '#21815e'),
      moss: tokenColor('--biwa-moss', '#4d6136'),
      paper: tokenColor('--biwa-paper', '#f7f1ec'),
      success: tokenColor('--biwa-success', '#3f6b4f')
    };
  };

  // Day → route colour, shared with the legend swatches in biwa-ride.css.
  RoutePreview.DAY_COLORS = {
    'day-1': '--biwa-day-one',
    'day-2': '--biwa-day-two',
    'day-3': '--biwa-day-three'
  };

  RoutePreview.dayColor = function (dayId) {
    return tokenColor(RoutePreview.DAY_COLORS[dayId] || '--biwa-lake', '#2f5d6f');
  };

  // --- signatures & polyline decode ---------------------------------------------

  // Stable signature of the coordinates a request was made for. Used by the
  // caller to ignore stale route responses after edits.
  RoutePreview.signatureOf = function (points) {
    return JSON.stringify(points.map(function (p) {
      return [Number(p.lat).toFixed(5), Number(p.lng).toFixed(5)];
    }));
  };

  RoutePreview.newRequestId = function () {
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  // Decode a Google encoded polyline into [{lat, lng}]. The decoded path is
  // provider content — it may only be drawn on the Google Map, not the SVG
  // fallback.
  RoutePreview.decodePolyline = function (encoded) {
    var points = [];
    var index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      var shift = 0, result = 0, byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  };

  // --- maps loader ----------------------------------------------------------------

  // Lazy-load Maps JS. One cached attempt per key: a null key attempt does
  // NOT poison the cache, so when config later provides a key the load is
  // retried. Resolves to the google.maps namespace or null.
  RoutePreview.loadMaps = function (browserKey) {
    if (!browserKey) return Promise.resolve(null);
    if (RoutePreview._mapPromise && RoutePreview._mapsKeyUsed === browserKey) {
      return RoutePreview._mapPromise;
    }
    RoutePreview._mapsKeyUsed = browserKey;
    RoutePreview._mapPromise = new Promise(function (resolve) {
      if (global.google && global.google.maps) return resolve(global.google.maps);
      var callbackName = '__biwaMapsReady' + Date.now();
      var settled = false;
      var script = global.document.createElement('script');
      var timer = null;
      function done(value) {
        if (settled) return;
        settled = true;
        if (timer) global.clearTimeout(timer);
        // Retained safe callback: if Google's script answers after our
        // timeout, the callback still exists but resolves to nothing.
        global[callbackName] = function () {};
        global.setTimeout(function () { try { delete global[callbackName]; } catch (e) {} }, 30000);
        resolve(value);
      }
      global[callbackName] = function () { done(global.google && global.google.maps ? global.google.maps : null); };
      script.onerror = function () { done(null); };
      timer = global.setTimeout(function () { done(null); }, MAPS_LOAD_TIMEOUT_MS);
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(browserKey) + '&callback=' + callbackName + '&loading=async';
      script.async = true;
      global.document.head.appendChild(script);
    });
    return RoutePreview._mapPromise;
  };

  function boundsOf(points) {
    var b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    points.forEach(function (p) {
      b.minLat = Math.min(b.minLat, p.lat);
      b.maxLat = Math.max(b.maxLat, p.lat);
      b.minLng = Math.min(b.minLng, p.lng);
      b.maxLng = Math.max(b.maxLng, p.lng);
    });
    return b;
  }

  // --- google map rendering ---------------------------------------------------------

  // Lifecycle-safe: if the container was rebuilt (e.g. by the SVG fallback or
  // a re-render), drop the old map instance and create a fresh one.
  RoutePreview.renderGoogle = function (container, points, routePath, mapsNs) {
    if (!container || !mapsNs) return false;
    if (!RoutePreview._map || RoutePreview._mapDiv !== container) {
      container.innerHTML = '';
      RoutePreview._map = new mapsNs.Map(container, {
        center: { lat: points[0].lat, lng: points[0].lng },
        zoom: 10,
        mapTypeControl: false,
        streetViewControl: false
      });
      RoutePreview._mapDiv = container;
      RoutePreview._markers = [];
      RoutePreview._polyline = null;
    }
    var bounds = new mapsNs.LatLngBounds();
    points.forEach(function (p) { bounds.extend({ lat: p.lat, lng: p.lng }); });
    RoutePreview._markers.forEach(function (m) { m.setMap(null); });
    RoutePreview._markers = points.map(function (p) {
      return new mapsNs.Marker({
        position: { lat: p.lat, lng: p.lng },
        map: RoutePreview._map,
        title: p.label
      });
    });
    if (RoutePreview._polyline) RoutePreview._polyline.setMap(null);
    RoutePreview._polyline = null;
    if (routePath && routePath.length) {
      RoutePreview._polyline = new mapsNs.Polyline({
        path: routePath.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
        geodesic: true,
        strokeColor: RoutePreview.colors().route,
        strokeWeight: 4,
        map: RoutePreview._map
      });
      routePath.forEach(function (p) { bounds.extend({ lat: p.lat, lng: p.lng }); });
    }
    RoutePreview._map.fitBounds(bounds, 24);
    return true;
  };

  // --- user-owned stop schematic ------------------------------------------------------

  // Key-free fallback: plots ONLY the user's ordered stops (never provider
  // geometry) scaled into an SVG, labelled honestly as a schematic.
  RoutePreview.renderSchematic = function (container, points) {
    if (!container) return;
    var W = 640, H = 320, pad = 28;
    var c = RoutePreview.colors();
    var b = boundsOf(points);
    var spanLat = Math.max(b.maxLat - b.minLat, 0.001);
    var spanLng = Math.max(b.maxLng - b.minLng, 0.001);
    function x(p) { return pad + (p.lng - b.minLng) / spanLng * (W - 2 * pad); }
    function y(p) { return H - pad - (p.lat - b.minLat) / spanLat * (H - 2 * pad); }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      t('Stop order schematic, not a road route') + '">';
    svg += '<rect width="' + W + '" height="' + H + '" fill="' + c.surface + '"/>';
    if (points.length >= 2) {
      var d = points.map(function (p, i) {
        return (i ? 'L' : 'M') + x(p).toFixed(1) + ' ' + y(p).toFixed(1);
      }).join(' ');
      svg += '<path d="' + d + '" fill="none" stroke="' + c.route + '" stroke-width="3" stroke-linejoin="round" stroke-dasharray="6 5"/>';
    }
    points.forEach(function (p, i) {
      svg += '<circle cx="' + x(p).toFixed(1) + '" cy="' + y(p).toFixed(1) +
        '" r="6" fill="' + c.stop + '"/>';
      svg += '<text x="' + x(p).toFixed(1) + '" y="' + (y(p) - 10).toFixed(1) +
        '" font-size="11" text-anchor="middle" fill="' + c.ink + '">' + (i + 1) + '</text>';
    });
    svg += '<text x="' + (W / 2) + '" y="' + (H - 8) + '" font-size="12" text-anchor="middle" fill="' +
      c.inkSoft + '">' + t('Stop schematic — not a road route') + '</text>';
    svg += '</svg>';
    container.innerHTML = svg;
  };

  // --- map page: markers, day polylines --------------------------------------------

  // Marker artwork. Every regular icon is an opaque 22px SVG: a solid
  // status-coloured disc carrying a white glyph — camera for official
  // checkpoints
  // (shore-coloured), a red star for rally stops (shared checkpoints like
  // Mizudori keep the rally look; the official area still shows on badges),
  // a bed for accommodation and a small pin for other stops. Status is
  // colour, never opacity: visited paints the rich token colour, pending
  // the pale one. Route-waypoint anchors are the exception — a small
  // neutral 10px dot that never takes a status tone.
  // Glyphs are drawn on a 22x22 canvas centred at (11,11).
  var MARKER_GLYPHS = {
    official: '<path d="M6 8.5h2.2l.7-1.2h4.2l.7 1.2H16c.55 0 1 .45 1 1V14c0 .55-.45 1-1 1H6c-.55 0-1-.45-1-1V9.5c0-.55.45-1 1-1zm5 5.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z"/>',
    rally: '<path d="M11 5.4l1.75 3.55 3.92.57-2.84 2.77.67 3.9L11 14.3l-3.5 1.88.67-3.9-2.84-2.77 3.92-.57z"/>',
    accommodation: '<path d="M5.5 15.2V9h1.5v3.3h7.5c1 0 1.8.8 1.8 1.8v1.1h-1.5v-.7H7v.7z"/><circle cx="8" cy="10.6" r="1"/>',
    extra: '<path d="M11 5.2c-2.3 0-3.9 1.6-3.9 3.7 0 2.6 3.9 7.9 3.9 7.9s3.9-5.3 3.9-7.9c0-2.1-1.6-3.7-3.9-3.7zm0 5a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7z"/>',
    'route-waypoint': ''
  };

  RoutePreview.markerShape = function (place) {
    if (place && place.category === 'route-waypoint') return 'route-waypoint';
    var programmes = (place && place.programmes) || [];
    if (programmes.indexOf('rally') !== -1) return 'rally';
    if (programmes.some(function (p) { return typeof p === 'string' && p.indexOf('official-') === 0; })) return 'official';
    if (place && place.category === 'accommodation') return 'accommodation';
    return 'extra';
  };

  // Literal hex for the generated SVG — tokens are resolved here because
  // CSS variables cannot resolve inside a data-URI document.
  function markerColor(shapeKey, visited, area) {
    if (shapeKey === 'route-waypoint') {
      return tokenColor('--biwa-waypoint', '#8f7f76');
    }
    var richToken, paleToken, richFallback, paleFallback;
    if (shapeKey === 'rally') {
      richToken = '--biwa-rally-marker'; paleToken = '--biwa-rally-marker-pale';
      richFallback = '#c5473d'; paleFallback = '#d5a6a0';
    } else if (shapeKey === 'official' && area) {
      richToken = '--biwa-area-' + area; paleToken = '--biwa-area-' + area + '-pale';
      richFallback = '#2f5d6f'; paleFallback = '#a8c5ca';
    } else if (shapeKey === 'official') {
      richToken = '--biwa-lake'; paleToken = '--biwa-lake-pale';
      richFallback = '#2f5d6f'; paleFallback = '#a8c5ca';
    } else if (shapeKey === 'accommodation') {
      richToken = '--biwa-moss'; paleToken = '--biwa-accommodation-pale';
      richFallback = '#4d6136'; paleFallback = '#b7bda4';
    } else {
      richToken = '--biwa-ink-soft'; paleToken = '--biwa-extra-pale';
      richFallback = '#6b544d'; paleFallback = '#bdb0a9';
    }
    return visited
      ? tokenColor(richToken, richFallback)
      : tokenColor(paleToken, paleFallback);
  }

  // Single painter shared by the Google marker icons and the in-page
  // legend so the legend is always accurate to what the map draws.
  RoutePreview.markerSvg = function (shapeKey, visited, area) {
    var color = markerColor(shapeKey, visited, area);
    if (shapeKey === 'route-waypoint') {
      // Own 10px canvas — an r4 dot scales to ~8-9px rendered, small and
      // quiet next to the 22px destination discs. Flat style: solid fill,
      // no rim.
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<circle cx="5" cy="5" r="4" fill="' + color + '"/></svg>';
    }
    var glyph = MARKER_GLYPHS[shapeKey] || MARKER_GLYPHS.extra;
    // Solid status-coloured disc (rich visited / pale pending) with a white
    // glyph — every pixel opaque, colour alone carries state; the flat
    // style drops the paper rim.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">' +
      '<circle cx="11" cy="11" r="10" fill="' + color + '"/>' +
      '<g fill="#fff">' + glyph + '</g></svg>';
  };

  // Opaque image icon for the live map — 22px disc for destinations, a
  // quiet 10px dot for route anchors. No always-visible label text (the
  // title tooltip still names the stop on hover).
  RoutePreview.markerIcon = function (mapsNs, shapeKey, visited, area) {
    var size = shapeKey === 'route-waypoint' ? 10 : 22;
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' +
        encodeURIComponent(RoutePreview.markerSvg(shapeKey, visited, area)),
      scaledSize: new mapsNs.Size(size, size),
      anchor: new mapsNs.Point(size / 2, size / 2)
    };
  };

  // Small legend swatch — same painter, rich/visited tone, sized for the
  // legend row.
  RoutePreview.legendShapeSvg = function (shapeKey, area) {
    return RoutePreview.markerSvg(shapeKey, true, area)
      .replace('<svg ', '<svg width="14" height="14" aria-hidden="true" ');
  };

  // Lifecycle-safe map page handle. Owns the Google Map instance plus the
  // marker/polyline sets so re-renders never leak layers; callers pass plain
  // data, never provider internals.
  RoutePreview.createMapPage = function (container, mapsNs) {
    if (!container || !mapsNs) return null;
    container.innerHTML = '';
    var map = new mapsNs.Map(container, {
      center: { lat: 35.22, lng: 136.08 },
      zoom: 10,
      mapTypeControl: false,
      streetViewControl: false
    });
    var markers = [];
    var polylines = [];
    var handles = {
      map: map,
      setMarkers: function (items) {
        markers.forEach(function (entry) { entry.marker.setMap(null); });
        markers = [];
        (items || []).forEach(function (item) {
          // Null-coordinate records are never plotted — a missing lat/lng
          // must not materialise at 0,0.
          if (typeof item.lat !== 'number' || typeof item.lng !== 'number') return;
          var marker = new mapsNs.Marker({
            position: { lat: item.lat, lng: item.lng },
            map: item.visible === false ? null : map,
            title: item.label,
            icon: RoutePreview.markerIcon(mapsNs, item.shape, item.visited, item.area)
          });
          if (item.onClick) marker.addListener('click', item.onClick);
          markers.push({ marker: marker, key: item.key });
        });
      },
      setMarkerVisible: function (predicate) {
        markers.forEach(function (entry) {
          entry.marker.setMap(predicate(entry.key) ? map : null);
        });
      },
      setPolylines: function (items) {
        polylines.forEach(function (p) { p.setMap(null); });
        polylines = [];
        (items || []).forEach(function (item) {
          if (!item.path || !item.path.length) return;
          polylines.push(new mapsNs.Polyline({
            path: item.path.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
            geodesic: true,
            strokeColor: RoutePreview.dayColor(item.dayId),
            strokeOpacity: item.visible === false ? 0.25 : 0.9,
            strokeWeight: 4,
            map: map
          }));
        });
      },
      fitBounds: function (points) {
        var valid = (points || []).filter(function (p) {
          return typeof p.lat === 'number' && typeof p.lng === 'number';
        });
        if (!valid.length) return;
        var bounds = new mapsNs.LatLngBounds();
        valid.forEach(function (p) { bounds.extend({ lat: p.lat, lng: p.lng }); });
        map.fitBounds(bounds, 30);
      }
    };
    return handles;
  };

  // --- elevation profile ---------------------------------------------------------------

  // Terrain profile drawn from the provider's smoothed elevation samples;
  // renders an honest 'unavailable' panel when there is no data.
  RoutePreview.renderElevation = function (svgEl, elevation) {
    if (!svgEl) return;
    var c = RoutePreview.colors();
    if (!elevation || elevation.status !== 'ok' || !elevation.samples || !elevation.samples.length) {
      svgEl.innerHTML =
        '<text x="50%" y="55%" text-anchor="middle" font-size="13" fill="' + c.inkSoft + '">' +
        t('Elevation profile unavailable') + '</text>';
      return;
    }
    var W = 640, H = 120, pad = 8;
    var samples = elevation.samples;
    var minE = Infinity, maxE = -Infinity, maxD = 0;
    samples.forEach(function (s) {
      minE = Math.min(minE, s.elevationMeters);
      maxE = Math.max(maxE, s.elevationMeters);
      maxD = Math.max(maxD, s.distanceMeters || 0);
    });
    var spanE = Math.max(maxE - minE, 1);
    var spanD = Math.max(maxD, 1);
    var d = samples.map(function (s, i) {
      var px = pad + (s.distanceMeters || 0) / spanD * (W - 2 * pad);
      var py = H - pad - (s.elevationMeters - minE) / spanE * (H - 2 * pad);
      return (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }).join(' ');
    svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svgEl.innerHTML =
      '<path d="' + d + ' L' + (W - pad) + ' ' + (H - pad) + ' L' + pad + ' ' + (H - pad) +
      ' Z" fill="' + c.lakeWash + '" stroke="' + c.stop + '" stroke-width="1.5"/>';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RoutePreview;
  global.BiwaRoutePreview = RoutePreview;
})(typeof window !== 'undefined' ? window : globalThis);
