/* offline-cache.js — automatic service-worker registration + offline
 * escape-hatch notifications.
 *
 * ONLINE-FIRST, always: there is no offline mode, no toggle and no
 * status readout — while the app is healthy it says nothing at all. The
 * only surface is a transient toast (the caller's notify) when the
 * connection genuinely drops or comes back:
 *
 *   - definite offline (navigator.onLine false): the saved itinerary
 *     still opens; changes stay on the device until the connection
 *     returns.
 *   - a real wire failure (store.connectionIssue: rejected fetch or
 *     5xx): the connection was interrupted; changes stay on the device
 *     until syncing resumes.
 *   - recovery is claimed only after the STORE proves the wire works
 *     again (a 'saved' state with no unsent draft and no conflict) —
 *     an 'online' event alone is just a hint and never claims synced.
 *
 * Registration is silent: HTTPS/localhost only, an absolute worker URL
 * under /projects/biwa-ride/, and failure never nags — the cache is a
 * fallback, not a feature to report.
 */
(function (global) {
  'use strict';

  var APP_PATH = '/projects/biwa-ride/';
  var WORKER_FILE = 'service-worker.js';

  function originOf() {
    var loc = global.location || {};
    if (loc.origin) return loc.origin;
    return (loc.protocol || 'https:') + '//' + (loc.hostname || '') +
      (loc.port ? ':' + loc.port : '');
  }

  // Explicit absolute app URLs — never resolved against the document's
  // location, so a slashless entry (/projects/biwa-ride) can't skew where
  // the worker registers from or which scope we expect.
  function appUrl(rel) {
    return new URL(rel, originOf() + APP_PATH).href;
  }

  // The app is also linked without a trailing slash; that URL serves the
  // document but sits outside the worker's directory scope for browser
  // dispatch. Canonicalize it in place — query and hash preserved, no
  // redirect — so the loaded/bookmarked URL is offline-controlled. Only
  // the exact app path is rewritten; terms/privacy keep their own.
  function canonicalizeLocation() {
    var loc = global.location;
    if (!loc || loc.pathname !== APP_PATH.slice(0, -1)) return;
    if (!(global.history && global.history.replaceState)) return;
    global.history.replaceState(
      null, '', APP_PATH + (loc.search || '') + (loc.hash || ''));
  }

  // Service workers only work on secure contexts; the site is HTTPS in
  // production and the local dev launcher runs on localhost.
  function secureEnough() {
    var loc = global.location;
    if (!loc) return false;
    if (loc.protocol === 'https:') return true;
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname || '');
  }

  function supported() {
    return !!(global.navigator &&
      'serviceWorker' in global.navigator && secureEnough());
  }

  // init({store, notify, translate}) — registers the worker silently and
  // watches connectivity + store state for genuine outage transitions.
  // Returns {refresh} so the caller can re-evaluate after wiring changes.
  function init(options) {
    var store = options && options.store;
    var notify = (options && options.notify) || function () {};
    var translate = (options && options.translate) ||
      function (key) { return key; };

    // One toast per episode each way — repeated store emits, poll ticks
    // and connectivity events must never stack notifications.
    var episode = { offlineToast: false, restoredToast: false };

    function say(key) { notify(translate(key)); }

    // source: 'event' (connectivity listener/init check) or 'emit' (a
    // real store change). The restored toast may ONLY ride on an emit —
    // an 'online' event fires while the reconnect refresh is still in
    // flight, so claiming synced there would be premature.
    function evaluate(source) {
      var definiteOffline =
        !!(global.navigator && global.navigator.onLine === false);
      var interrupted = !!(store && store.connectionIssue === true);
      if (definiteOffline || interrupted) {
        // Toast once per outage, and only once a trip exists to fall
        // back to — without a cached itinerary "saved" is a lie.
        if (!episode.offlineToast && store && store.trip) {
          episode.offlineToast = true;
          episode.restoredToast = false;
          if (store.storageAvailable === false) {
            say('Offline — keep this page open; changes cannot be saved on this phone.');
          } else if (definiteOffline) {
            say('Offline — using your saved itinerary. Changes stay on this phone until the connection returns.');
          } else {
            say('Connection interrupted — using your saved itinerary. Changes stay on this phone until syncing resumes.');
          }
        }
        return;
      }
      // Healthy signals again — but the restored toast waits for the
      // store to have proven it: a successful authoritative read/write
      // produced a 'saved' state with no unsent draft and no open
      // conflict. A bare 'online' event only arms the wait.
      if (source === 'emit' && episode.offlineToast && store &&
          store.state === 'saved' &&
          !store.pendingDraft && !store.conflict) {
        if (!episode.restoredToast) {
          episode.restoredToast = true;
          say('Connection restored — your changes are synced.');
        }
        // Episode over — re-arm so the NEXT outage can toast again.
        episode.offlineToast = false;
        episode.restoredToast = false;
      }
    }

    if (supported()) {
      // Canonicalize before registering so the loaded/bookmarked URL
      // sits inside the worker's dispatch scope.
      canonicalizeLocation();
      var p = null;
      try {
        p = global.navigator.serviceWorker.register(appUrl(WORKER_FILE));
      } catch (e) {
        p = null;
      }
      // Silent by design — while online the app works whether or not
      // the worker lands; the cache is a fallback, not a feature.
      if (p && typeof p.then === 'function') p.catch(function () {});
    }

    if (global.addEventListener) {
      global.addEventListener('online', function () { evaluate('event'); });
      global.addEventListener('offline', function () { evaluate('event'); });
    }
    if (store && typeof store.onChange === 'function') {
      store.onChange(function () { evaluate('emit'); });
    }
    evaluate('event');
    return { refresh: function () { evaluate('emit'); } };
  }

  var api = { init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BiwaOfflineCache = api;
})(typeof window !== 'undefined' ? window : globalThis);
