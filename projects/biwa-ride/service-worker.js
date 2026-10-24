/* service-worker.js — offline shell for /projects/biwa-ride/ ONLY.
 *
 * What it caches: the app's own shell — HTML, local CSS/JS, the checkpoint
 * catalogue, the trip seed and the artwork the page actually references —
 * pre-cached at install so the itinerary, check-ins and notes reopen
 * without a connection.
 *
 * What it never caches: API traffic (trip state, provider proxies), Google
 * details/photos/routes/elevation, map tiles, third-party requests and any
 * request outside the allowlist. Provider content is transient by design
 * and simply unavailable offline.
 *
 * Online-first: every recognized document and allowlisted asset is
 * fetched bounded network-first — a live answer always wins and (when it
 * validates) refreshes its own canonical cache key, so the fallback copy
 * tracks the last successful online visit. An unrecognized in-scope path
 * is left to the network untouched: the worker never substitutes the app
 * for an unknown page, never writes a wrong/error/redirected document,
 * and never caches runtime HTML outside the allowlist.
 *
 * IMPORTANT: bump SHELL_VERSION whenever ANY cached content changes —
 * the offline fallback serves only what the current generation holds.
 * Updates ride the natural waiting-worker lifecycle (no skipWaiting, no
 * forced reloads), which keeps HTML and its assets on one generation.
 *
 * Scope caveat: browsers dispatch navigations to the worker owning the
 * longest matching scope — this one only ever sees URLs under its own
 * directory. A no-trailing-slash visit (/projects/biwa-ride) is outside
 * that scope by default and is not claimed here.
 */
"use strict";

var SHELL_VERSION = "v27";
var SHELL_CACHE = "biwa-ride-shell-" + SHELL_VERSION;
var NAV_TIMEOUT_MS = 3500;

// The worker's own directory is its scope — every path below is relative
// to /projects/biwa-ride/.
var SELF_BASE =
	typeof self !== "undefined" && self.location && self.location.href
		? self.location.href
		: "https://localhost/projects/biwa-ride/service-worker.js";
var SCOPE_URL = new URL("./", SELF_BASE);
var SCOPE_PATH = SCOPE_URL.pathname; // '/projects/biwa-ride/'
var SELF_ORIGIN = SCOPE_URL.origin;
var API_PREFIX = SCOPE_PATH + "api/";

// Precached documents use Vercel's clean URLs (cleanUrls:true serves the
// .html files at the extensionless path, and the dev server resolves them
// the same way), so the cached keys match what a browser actually
// navigates to. Values give each entry's on-disk file for integrity checks.
var SHELL_DOCS = {
	"./": "index.html",
	terms: "terms.html",
	privacy: "privacy.html",
};

var SHELL_ASSETS = [
	"biwa-tokens.css",
	"biwa-ride.css",
	"geo-distance.js",
	"checkpoint-rules.js",
	"map-links.js",
	"trip-store.js",
	"route-preview.js",
	"stop-distances.js",
	"biwa-i18n.js",
	"masthead-scene.js",
	"device-pairing.js",
	"offline-cache.js",
	"mini-checkin.js",
	"endpoint-change.js",
	"biwa-ride.js",
	"data/checkpoints.json",
	"data/trip-seed.json",
	// Masthead art actually referenced by index.html / biwa-ride.css.
	"assets/tree-01.svg",
	"assets/tree-02.svg",
	"assets/tree-03.svg",
	"assets/tree-04.svg",
	"assets/tree-05.svg",
	"assets/tree-06.svg",
	"assets/walker-01-loop.gif",
	"assets/walker-02-loop.gif",
	"assets/walker-03-loop.gif",
	"assets/walker-04-loop.gif",
	"assets/walker-05-loop.gif",
	"assets/cyclist-01-loop.gif",
	"assets/cyclist-02-loop.gif",
	"assets/cyclist-03-loop.gif",
	"assets/wired-flat-1984-torii.svg",
	"assets/wired-flat-1940-pagoda.svg",
	"assets/shrine-01.png",
	"assets/shrine-02.png",
	"assets/maple-leaf-flat.svg",
	// Tabler Icons license — terms.html links it for attribution.
	"assets/tabler-icons-license.txt",
];

var SHELL_URLS = Object.keys(SHELL_DOCS).concat(SHELL_ASSETS);

// Navigation pathname -> canonical cached document. Only pathname is
// keyed — every query variant resolves to the same clean-URL document.
var DOC_BY_PATH = {};
DOC_BY_PATH[SCOPE_PATH] = new URL("./", SCOPE_URL).href;
DOC_BY_PATH[SCOPE_PATH + "index.html"] = DOC_BY_PATH[SCOPE_PATH];
DOC_BY_PATH[SCOPE_PATH + "terms"] = new URL("terms", SCOPE_URL).href;
DOC_BY_PATH[SCOPE_PATH + "terms.html"] = DOC_BY_PATH[SCOPE_PATH + "terms"];
DOC_BY_PATH[SCOPE_PATH + "privacy"] = new URL("privacy", SCOPE_URL).href;
DOC_BY_PATH[SCOPE_PATH + "privacy.html"] = DOC_BY_PATH[SCOPE_PATH + "privacy"];

// Absolute-path lookup of allowlisted static assets (the docs above are
// valid GET targets too — e.g. a same-origin fetch of /terms).
var ALLOWLIST_PATHS = {};
SHELL_URLS.forEach(function (rel) {
	ALLOWLIST_PATHS[new URL(rel, SCOPE_URL).pathname] = true;
});

function installEvent(event) {
	event.waitUntil(
		caches.open(SHELL_CACHE).then(function (cache) {
			// One batch: a partial shell rejects the install so a future
			// offline launch never meets a half-broken cache.
			return cache.addAll(SHELL_URLS);
		}),
	);
}

function activateEvent(event) {
	event.waitUntil(
		caches
			.keys()
			.then(function (names) {
				return Promise.all(
					names.map(function (name) {
						// Only OUR versioned shells are evicted — other caches on the
						// origin (or any other site's) are left alone.
						if (
							name.indexOf("biwa-ride-shell-") === 0 &&
							name !== SHELL_CACHE
						) {
							return caches.delete(name);
						}
					}),
				);
			})
			.then(function () {
				// First activation claims already-open pages so the NEXT navigation
				// can serve the cached shell. No forced reload: an in-flight edit
				// is never bounced mid-session.
				return self.clients.claim();
			}),
	);
}

function fetchEvent(event) {
	var request = event.request;
	if (request.method !== "GET") return; // mutations bypass
	var url;
	try {
		url = new URL(request.url);
	} catch (e) {
		return;
	}
	// Third-party requests (Google APIs, map tiles, fonts) are never
	// intercepted — they either reach the network or fail as usual.
	if (url.origin !== SELF_ORIGIN) return;
	// API calls always hit the network; personal data is never written to
	// a cache, and offline API failures surface as honest states.
	if (url.pathname.indexOf(API_PREFIX) === 0) return;
	// Same-origin requests outside this app's directory belong to other
	// pages of the site — left alone.
	if (url.pathname.indexOf(SCOPE_PATH) !== 0) return;

	if (request.mode === "navigate") {
		// Only the recognized app entries get an offline answer — an
		// unknown in-scope page falls through to the network like any
		// miss rather than being silently replaced by the app shell.
		var docUrl = DOC_BY_PATH[url.pathname];
		if (docUrl) event.respondWith(documentResponse(docUrl, request));
		return;
	}
	if (ALLOWLIST_PATHS[url.pathname]) {
		event.respondWith(staticResponse(request));
	}
	// Un-allowlisted on-scope requests fall through to the network.
}

// Bounded network fetch for the online-first strategy — a hanging
// connection must not hold the page hostage when a fallback exists.
function fetchWithTimeout(request, ms) {
	return new Promise(function (resolve, reject) {
		var timer = setTimeout(function () {
			reject(new Error("fetch timeout"));
		}, ms);
		fetch(request).then(
			function (res) {
				clearTimeout(timer);
				resolve(res);
			},
			function (err) {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

// The fallback half of network-first: serve the cached copy of this one
// canonical key from the CURRENT shell generation (caches.match across
// every named cache could hand back a stale-generation document), else
// preserve whatever the network gave — an error response or nothing.
function cachedFallback(key, res) {
	return caches
		.open(SHELL_CACHE)
		.then(function (cache) {
			return cache.match(key).then(function (hit) {
				return hit || res;
			});
		})
		.catch(function () {
			return res;
		});
}

// Network-first for every shell entry: try the live wire within the
// bound; a validated answer refreshes its own canonical key (cache.put
// inside the respondWith chain keeps the write alive, and a write
// failure never turns a good online answer into an error); any
// rejection, timeout or non-ok answer falls back to the cached copy.
function networkFirst(key, request, validate) {
	return fetchWithTimeout(request, NAV_TIMEOUT_MS).then(
		function (res) {
			if (validate(res)) {
				// The whole open+put chain is best-effort: a disabled
				// CacheStorage or a failing write can never turn a good
				// online answer into an error.
				return caches
					.open(SHELL_CACHE)
					.then(function (cache) {
						return cache.put(key, res.clone());
					})
					.then(
						function () {
							return res;
						},
						function () {
							return res;
						},
					);
			}
			return cachedFallback(key, res);
		},
		function (err) {
			return cachedFallback(key).then(function (hit) {
				if (hit) return hit;
				throw err;
			});
		},
	);
}

// A document answer is only allowed to refresh its own canonical key —
// ok + basic, and if a redirect was followed it must land on a
// recognized variant of THE SAME document (a cleanUrls .html alias is
// fine; an unrelated redirect never overwrites the fallback).
function validDocResponse(res, docUrl) {
	if (!res || !res.ok || res.type !== "basic") return false;
	var type = res.headers && res.headers.get("content-type");
	if (!type || type.indexOf("text/html") !== 0) return false;
	if (!res.redirected) return true;
	try {
		var finalUrl = new URL(res.url);
		return (
			finalUrl.origin === SELF_ORIGIN &&
			DOC_BY_PATH[finalUrl.pathname] === docUrl
		);
	} catch (e) {
		return false;
	}
}

function documentResponse(docUrl, request) {
	return networkFirst(docUrl, request, function (res) {
		return validDocResponse(res, docUrl);
	});
}

// Same strategy for allowlisted statics — the query string is only a
// cache-buster for these paths, so the canonical pathname is the key.
function staticResponse(request) {
	var path = new URL(request.url).pathname;
	return networkFirst(SELF_ORIGIN + path, request, function (res) {
		if (!res || !res.ok || res.type !== "basic") return false;
		if (!res.redirected) return true;
		try {
			var finalUrl = new URL(res.url);
			return (
				finalUrl.origin === SELF_ORIGIN && finalUrl.pathname === path
			);
		} catch (e) {
			return false;
		}
	});
}

// Browser wiring — kept at the bottom so the pure functions above can be
// exercised in Node without a worker environment.
if (
	typeof self !== "undefined" &&
	typeof self.addEventListener === "function"
) {
	self.addEventListener("install", installEvent);
	self.addEventListener("activate", activateEvent);
	self.addEventListener("fetch", fetchEvent);
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		SHELL_CACHE: SHELL_CACHE,
		SHELL_URLS: SHELL_URLS,
		SHELL_DOCS: SHELL_DOCS,
		DOC_BY_PATH: DOC_BY_PATH,
		NAV_TIMEOUT_MS: NAV_TIMEOUT_MS,
		install: installEvent,
		activate: activateEvent,
		fetch: fetchEvent,
	};
}
