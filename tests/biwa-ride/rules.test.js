/* tests/biwa-ride/rules.test.js — focused regression tests for the pure
 * checkpoint rules and Maps-link builders. Run: node --test tests/biwa-ride/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'projects', 'biwa-ride');
const Rules = require(path.join(ROOT, 'checkpoint-rules.js'));
const MapLinks = require(path.join(ROOT, 'map-links.js'));
const Preview = require(path.join(ROOT, 'route-preview.js'));

const checkpoints = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'checkpoints.json'), 'utf8'));
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trip-seed.json'), 'utf8'));

function freshTrip() {
  const trip = JSON.parse(JSON.stringify(seed));
  trip.places = JSON.parse(JSON.stringify(checkpoints.places));
  return trip;
}

// --- catalogue integrity -----------------------------------------------------

test('catalogue holds 33 unique places: 17 official + 10 rally + 3 stays + 4 extras', () => {
  const places = checkpoints.places;
  assert.strictEqual(places.length, 33);
  const ids = new Set(places.map(p => p.placeId));
  assert.strictEqual(ids.size, 33);
  const official = places.filter(p => p.programmes.some(x => x.startsWith('official-')));
  const rally = places.filter(p => p.programmes.includes('rally'));
  const stays = places.filter(p => p.category === 'accommodation');
  const extras = places.filter(p => !p.programmes.length && p.category !== 'accommodation');
  assert.strictEqual(official.length, 17);
  assert.strictEqual(rally.length, 10);
  assert.deepStrictEqual(stays.map(p => p.placeId).sort(),
    ['stay-comfort', 'stay-hana', 'stay-rinkoso']);
  assert.strictEqual(extras.length, 4);
  const mizudori = places.find(p => p.placeId === 'mizudori-station');
  assert.deepStrictEqual(mizudori.programmes.sort(), ['official-north', 'rally']);
});

test('临湖庄 is one place — no separate 1-17/108-17 Katsuno record', () => {
  const places = checkpoints.places;
  const rinkoso = places.find(p => p.placeId === 'stay-rinkoso');
  assert.strictEqual(rinkoso.label, '临湖庄');
  assert.ok(rinkoso.address.includes('Katsuno'), 'copied address kept verbatim');
  assert.strictEqual(rinkoso.googlePlaceId, 'ChIJ8Zenbz6bAWAR7ihwYMZr7Mg');
  // No phantom record may carry the old "1-17 Katsuno"/"108-17" endpoint
  // addresses — the copied destination IS this accommodation.
  assert.strictEqual(places.filter(p =>
    (p.address || '').includes('1-17') ||
    (p.address || '').includes('108-17') ||
    (p.label || '').includes('1-17') ||
    (p.label || '').includes('108-17')).length, 0);
});

test('official areas hold exactly 5 / 4 / 5 / 3 checkpoints', () => {
  const trip = freshTrip();
  assert.strictEqual(Rules.officialPlacesForArea(trip, 'south').length, 5);
  assert.strictEqual(Rules.officialPlacesForArea(trip, 'east').length, 4);
  assert.strictEqual(Rules.officialPlacesForArea(trip, 'north').length, 5);
  assert.strictEqual(Rules.officialPlacesForArea(trip, 'west').length, 3);
});

test('canonical places keep verbatim source coords; extras stay null-coord with resolvers', () => {
  let canonical = 0;
  for (const p of checkpoints.places) {
    if (p.source) {
      canonical += 1;
      assert.strictEqual(p.lat, p.source.latitude, `${p.placeId} lat`);
      assert.strictEqual(p.lng, p.source.longitude, `${p.placeId} lng`);
      assert.ok(p.lat >= 34 && p.lat <= 36, `${p.placeId} lat near Biwa`);
      assert.ok(p.lng >= 135 && p.lng <= 137, `${p.placeId} lng near Biwa`);
    } else {
      // The seven Google-ID/address-only places never invent stored coords;
      // they must carry at least one resolver for transient lookup.
      assert.strictEqual(p.lat, null, `${p.placeId} stores no invented lat`);
      assert.strictEqual(p.lng, null, `${p.placeId} stores no invented lng`);
      assert.ok(p.googlePlaceId || p.address, `${p.placeId} needs a resolver`);
    }
  }
  assert.strictEqual(canonical, 26);
});

test('seed order matches the blueprint: endpoints and every stop in order', () => {
  const blueprint = {
    'day-1': {
      start: 'stay-hana', end: 'stay-comfort',
      stops: ['official-south-otsu', 'rally-rental', 'rally-mizunomori',
        'official-south-kusatsu', 'official-south-marriott', 'rally-mentai',
        'official-east-chomei', 'extra-chomeiji-183', 'official-east-mitsuya']
    },
    'day-2': {
      start: 'stay-comfort', end: 'stay-rinkoso',
      stops: ['rally-castle', 'official-east-hikone', 'rally-dome',
        'mizudori-station', 'rally-shiotsu', 'extra-oura',
        'official-west-boat', 'official-west-stagex']
    },
    'day-3': {
      start: 'stay-rinkoso', end: 'rally-rental',
      stops: ['extra-takashima-station', 'extra-ukawa',
        'official-south-otsuka', 'rally-kitahira', 'official-south-shiga',
        'rally-ogoto', 'rally-otsukan', 'official-south-otsu']
    }
  };
  for (const day of seed.days) {
    const spec = blueprint[day.dayId];
    assert.deepStrictEqual(day.start, { placeId: spec.start }, `${day.dayId} start`);
    assert.deepStrictEqual(day.end, { placeId: spec.end }, `${day.dayId} end`);
    assert.deepStrictEqual(day.stops.map(s => s.placeId), spec.stops, `${day.dayId} order`);
    // Occurrence ids are stable and sequential.
    assert.deepStrictEqual(day.stops.map(s => s.occurrenceId),
      spec.stops.map((_, i) => `day${day.dayId.slice(4)}-s${i + 1}`));
  }
  // All ten rally stops appear in the itinerary.
  const scheduled = new Set(seed.days.flatMap(d => d.stops.map(s => s.placeId)));
  for (const p of checkpoints.places.filter(p => p.programmes.includes('rally'))) {
    assert.ok(scheduled.has(p.placeId), `${p.placeId} scheduled`);
  }
});

// --- progress rules ------------------------------------------------------------

test('rally requires all ten; official areas count one-per-area', () => {
  const trip = freshTrip();
  // Check one checkpoint in each official area → 4/4 covered, 0/10 rally.
  for (const area of Rules.OFFICIAL_AREAS) {
    const first = Rules.officialPlacesForArea(trip, area.key)[0];
    Rules.checkProgramme(trip, 'official', first.placeId, true);
  }
  assert.strictEqual(Rules.officialAreaProgress(trip).complete, true);
  assert.strictEqual(Rules.rallyProgress(trip).complete, false);
  assert.strictEqual(Rules.groupChecklist(trip).complete, false);

  // Nine of ten rally stops is not enough.
  for (const p of Rules.rallyPlaces(trip).slice(0, 9)) {
    Rules.checkProgramme(trip, 'rally', p.placeId, true);
  }
  assert.strictEqual(Rules.rallyProgress(trip).done, 9);
  assert.strictEqual(Rules.rallyProgress(trip).complete, false);
  const last = Rules.rallyPlaces(trip)[9];
  Rules.checkProgramme(trip, 'rally', last.placeId, true);
  assert.strictEqual(Rules.rallyProgress(trip).complete, true);
  assert.strictEqual(Rules.groupChecklist(trip).complete, true);
  assert.strictEqual(Rules.groupChecklist(trip).label, 'Group checklist complete');
});

test('shared Mizudori keeps independent rally vs official status', () => {
  const trip = freshTrip();
  Rules.checkProgramme(trip, 'rally', 'mizudori-station', true);
  assert.strictEqual(Rules.rallyProgress(trip).done, 1);
  const north = Rules.officialAreaProgress(trip).areas.find(a => a.key === 'north');
  assert.strictEqual(north.checked, 0);
  assert.strictEqual(north.covered, false);
});

// --- arrival semantics: one tick = visit flag + every programme family -------

test('ticking the shared Mizudori occurrence marks BOTH programme families', () => {
  const trip = freshTrip();
  const mizudori = trip.places.find(p => p.placeId === 'mizudori-station');
  // One row, one tick — the stop sits in day-2 as a shared checkpoint.
  Rules.applyArrival(trip, 'day2-s4', mizudori, true);
  assert.strictEqual(trip.visitStatus['day2-s4'], true, 'arrival flag on the row');
  assert.strictEqual(trip.programmeStatus.rally['mizudori-station'], true);
  assert.strictEqual(trip.programmeStatus.official['mizudori-station'], true);
  assert.strictEqual(Rules.arrivalChecked(trip, 'day2-s4', mizudori), true);
  // Unticking clears both families again but keeps the row's own visit flag
  // (visits and programme stamps are separate signals).
  Rules.applyArrival(trip, 'day2-s4', mizudori, false);
  assert.strictEqual(trip.programmeStatus.rally['mizudori-station'], undefined);
  assert.strictEqual(trip.programmeStatus.official['mizudori-station'], undefined);
});

test('ticking a programme place on one day shows checked on every occurrence', () => {
  const trip = freshTrip();
  const castle = trip.places.find(p => p.placeId === 'rally-castle');
  // Castle on day-2 ticked → its day-1 catalogue twin reads visited too.
  trip.days[0].stops.push({ occurrenceId: 'day1-s10', placeId: 'rally-castle' });
  Rules.applyArrival(trip, 'day2-s1', castle, true);
  assert.strictEqual(Rules.arrivalChecked(trip, 'day1-s10', castle), true);
  // Clearing the programme status does not clear the OTHER row's own
  // arrival visit flag.
  trip.visitStatus['day1-s10'] = true;
  Rules.applyArrival(trip, 'day2-s1', castle, false);
  assert.strictEqual(trip.visitStatus['day1-s10'], true, 'own visit survives un-ticking');
  assert.strictEqual(Rules.arrivalChecked(trip, 'day1-s10', castle), true);
});

test('endpoint rows tick and count as next destination', () => {
  const trip = freshTrip();
  const day = trip.days[0];
  const hana = trip.places.find(p => p.placeId === 'stay-hana');
  // The start endpoint is the first unvisited destination.
  const next = Rules.nextUnvisitedStop(trip, day);
  assert.strictEqual(next.occurrenceId, 'day-1-start');
  assert.strictEqual(next.placeId, 'stay-hana');
  Rules.applyArrival(trip, 'day-1-start', hana, true);
  const next2 = Rules.nextUnvisitedStop(trip, day);
  assert.strictEqual(next2.kind, 'stop', 'after the start, the first stop is next');
  // The day's lodging is a valid next destination once every stop is done.
  for (const s of day.stops) Rules.applyArrival(trip, s.occurrenceId,
    trip.places.find(p => p.placeId === s.placeId), true);
  const next3 = Rules.nextUnvisitedStop(trip, day);
  assert.strictEqual(next3.occurrenceId, 'day-1-end');
  assert.strictEqual(next3.placeId, 'stay-comfort');
});

test('removing a stop from the itinerary does not lose programme progress', () => {
  const trip = freshTrip();
  const castle = trip.places.find(p => p.placeId === 'rally-castle');
  Rules.applyArrival(trip, 'day2-s1', castle, true);
  // Remove Hikone Castle from day-2 — progress unchanged, re-add.
  trip.days[1].stops = trip.days[1].stops.filter(s => s.placeId !== 'rally-castle');
  assert.strictEqual(Rules.rallyProgress(trip).done, 1);
  trip.days[1].stops.push({ occurrenceId: 'day2-s9', placeId: 'rally-castle' });
  assert.strictEqual(Rules.rallyProgress(trip).done, 1);
});

test('moving a stop across days preserves its occurrenceId and progress', () => {
  const trip = freshTrip();
  trip.visitStatus['day1-s1'] = true;
  Rules.moveStopBetweenDays(trip, 'day-1', 'day1-s1', 'day-3');
  assert.strictEqual(trip.days[0].stops.length, 8);
  const moved = trip.days[2].stops[trip.days[2].stops.length - 1];
  assert.strictEqual(moved.occurrenceId, 'day1-s1');
  assert.strictEqual(trip.visitStatus['day1-s1'], true, 'visit flag stays with the row');
});

test('reordering stops preserves occurrenceIds and visit flags', () => {
  const trip = freshTrip();
  trip.visitStatus['day1-s1'] = true;
  const stops = trip.days[0].stops;
  [stops[0], stops[1]] = [stops[1], stops[0]];
  // Start endpoint is still first; after it the swapped-in stop is next.
  trip.visitStatus['day-1-start'] = true;
  const nextAfterStart = Rules.nextUnvisitedStop(trip, trip.days[0]);
  assert.strictEqual(nextAfterStart.occurrenceId, 'day1-s2');
  assert.strictEqual(trip.visitStatus['day1-s1'], true);
});

test('visits are per occurrence — repeated visits of a place stay distinct', () => {
  const trip = freshTrip();
  // A place can occur twice in one itinerary as separate occurrences, each
  // with its own visit flag.
  const occurrences = Rules.occurrencesOf(trip, 'rally-castle');
  assert.deepStrictEqual(occurrences,
    [{ dayId: 'day-2', occurrenceId: 'day2-s1', kind: 'stop' }]);
  trip.days[1].stops.push({ occurrenceId: 'day2-s9', placeId: 'rally-castle' });
  // Endpoints and all stops ticked except the second castle occurrence.
  trip.visitStatus['day-2-start'] = true;
  trip.visitStatus['day-2-end'] = true;
  for (const s of trip.days[1].stops) trip.visitStatus[s.occurrenceId] = true;
  delete trip.visitStatus['day2-s9'];
  // Only the second castle occurrence is unvisited — the earlier visit stands.
  const next = Rules.nextUnvisitedStop(trip, trip.days[1]);
  assert.strictEqual(next.occurrenceId, 'day2-s9');
  assert.strictEqual(next.placeId, 'rally-castle');
});

test('blueprint endpoints frame every day; missing endpoints skip, never invent', () => {
  const trip = freshTrip();
  const d1 = Rules.dayPoints(trip, trip.days[0]);
  assert.strictEqual(d1[0].kind, 'start');
  assert.strictEqual(d1[0].placeId, 'stay-hana');
  assert.strictEqual(d1[d1.length - 1].kind, 'end');
  assert.strictEqual(d1[d1.length - 1].placeId, 'stay-comfort');
  const d3 = Rules.dayPoints(trip, trip.days[2]);
  assert.strictEqual(d3[0].placeId, 'stay-rinkoso');
  assert.strictEqual(d3[d3.length - 1].placeId, 'rally-rental');
  // A cleared endpoint produces no phantom row.
  trip.days[0].end = null;
  const d1b = Rules.dayPoints(trip, trip.days[0]);
  assert.strictEqual(d1b[d1b.length - 1].kind, 'stop');
});

test('route points mix stored coords with transient googlePlaceId anchors', () => {
  const trip = freshTrip();
  const routed = Rules.routePoints(trip, trip.days[0]);
  // stay-hana has null coords — it rides on its Google place id instead.
  assert.deepStrictEqual(routed.points[0], { googlePlaceId: 'ChIJywsFgWAMAWAR7ceHyARQ9Gw' });
  assert.deepStrictEqual(routed.points[routed.points.length - 1],
    { googlePlaceId: 'ChIJX3VF3cfUA2ARNUBR5VdDmIs' });
  // Canonical checkpoint rows carry coordinates.
  const otsu = routed.points[1];
  assert.strictEqual(typeof otsu.lat, 'number');
  assert.strictEqual(typeof otsu.lng, 'number');
  // Every blueprint row resolves — nothing reported unroutable, nothing
  // degenerates to a 0,0 anchor.
  assert.deepStrictEqual(routed.unroutable, []);
  assert.ok(routed.points.every(p => !(p.lat === 0 && p.lng === 0)));
});

// --- map links ------------------------------------------------------------------

test('directions links omit origin for current-position handoff and encode Japanese', () => {
  const url = MapLinks.directionsUrl({ lat: 35.012715, lng: 135.8658363 });
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'));
  assert.ok(url.includes('destination=35.012715%2C135.8658363'));
  assert.ok(url.includes('travelmode=driving'));
  assert.ok(!url.includes('origin='));
  const details = MapLinks.placeDetailsUrl({ label: '大津港' });
  assert.ok(details.includes(encodeURIComponent('大津港')));
});

test('day directions split into sections of at most 3 intermediate waypoints', () => {
  const pts = Array.from({ length: 9 }, (_, i) => ({ lat: 35 + i * 0.01, lng: 136, label: 'p' + i }));
  const sections = MapLinks.dayDirectionsUrls(pts);
  assert.strictEqual(sections.length, 2); // 9 points → 5+5 overlapping
  for (const s of sections) {
    const wp = /waypoints=([^&]+)/.exec(s.url);
    if (wp) assert.ok(wp[1].split('%7C').length <= MapLinks.MAX_INTERMEDIATE_WAYPOINTS);
  }
  // every point preserved, order maintained via overlapping boundaries
  assert.ok(sections[1].url.includes('origin=' + encodeURIComponent('35.04,136')));
});

test('pin and nearby links anchor on coordinates', () => {
  assert.ok(MapLinks.pinUrl({ lat: 1.5, lng: 2.5 }).includes('query=1.5%2C2.5'));
  const nearby = MapLinks.nearbySearchUrl('bicycle repair shop', { lat: 35.2, lng: 136.1 });
  assert.ok(nearby.includes('bicycle%20repair%20shop'));
  assert.ok(nearby.includes('35.2%2C136.1'));
});

// --- route preview helpers ----------------------------------------------------

test('encoded polyline decodes to ordered lat/lng points', () => {
  // Google's canonical example vector from the polyline docs.
  const pts = Preview.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.strictEqual(pts.length, 3);
  assert.ok(Math.abs(pts[0].lat - 38.5) < 1e-5 && Math.abs(pts[0].lng + 120.2) < 1e-5);
  assert.ok(Math.abs(pts[2].lat - 43.252) < 1e-4 && Math.abs(pts[2].lng + 126.453) < 1e-4);
});

test('coordinate signature detects stale responses but ignores visit flags', () => {
  const before = Preview.signatureOf([{ lat: 35.012715, lng: 135.8658363 }]);
  const same = Preview.signatureOf([{ lat: 35.0127154, lng: 135.86583629 }]);
  assert.strictEqual(before, same); // same stop to 5dp — checkbox ticks never invalidate
  const moved = Preview.signatureOf([{ lat: 35.02, lng: 135.86 }]);
  assert.notStrictEqual(before, moved); // an edit must invalidate the preview
});

// --- page meta contract ---------------------------------------------------------

test('referrer policy is strict-origin-when-cross-origin (Google key needs origin)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const meta = /<meta name="referrer" content="([^"]+)"/.exec(html);
  assert.ok(meta, 'referrer meta present');
  // no-referrer would break the HTTP-referrer-restricted Maps browser key.
  assert.strictEqual(meta[1], 'strict-origin-when-cross-origin');
});

test('schematic fallback contains no provider polyline and is honestly labelled', () => {
  // renderSchematic only accepts user stop points — it has no routePath arg,
  // so Google geometry can never reach the fallback by construction.
  assert.strictEqual(Preview.renderSchematic.length, 2); // (container, points) only
});
