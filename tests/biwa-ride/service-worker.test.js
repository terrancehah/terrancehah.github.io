// service-worker.test.js — offline shell behaviour, exercised in Node with
// fake caches/fetch/self. No browser, no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "../../projects/biwa-ride");
const ORIGIN = "https://example.com";
const BASE = ORIGIN + "/projects/biwa-ride/";

// --- fakes -------------------------------------------------------------------

// Minimal CacheStorage: named stores of url -> response, enough surface
// for the worker (open/keys/delete/match, addAll/put/match per cache).
function fakeCacheStorage(fetchImpl) {
	const stores = new Map();
	function makeCache(name) {
		const entries = new Map();
		return {
			entries,
			addAll(urls) {
				return Promise.all(
					urls.map((rel) =>
						Promise.resolve(fetchImpl(BASE + rel)).then((res) => {
							// addAll rejects on any non-2xx — a partial shell never
							// installs, matching the real Cache API contract.
							if (!res || !res.ok)
								throw new Error("bad asset " + rel);
							entries.set(new URL(rel, BASE).href, res);
						}),
					),
				);
			},
			match(req) {
				const url = typeof req === "string" ? req : req.url;
				return Promise.resolve(entries.get(url));
			},
			put(req, res) {
				const url = typeof req === "string" ? req : req.url;
				entries.set(url, res);
				return Promise.resolve();
			},
		};
	}
	return {
		_stores: stores,
		open(name) {
			if (!stores.has(name)) stores.set(name, makeCache(name));
			return Promise.resolve(stores.get(name));
		},
		keys() {
			return Promise.resolve([...stores.keys()]);
		},
		delete(name) {
			stores.delete(name);
			return Promise.resolve(true);
		},
		match(req) {
			const url = typeof req === "string" ? req : req.url;
			for (const store of stores.values()) {
				if (store.entries.has(url))
					return Promise.resolve(store.entries.get(url));
			}
			return Promise.resolve(undefined);
		},
	};
}

function fakeResponse(status, contentType, extra) {
	return Object.assign(
		{
			ok: status >= 200 && status < 300,
			status,
			type: "basic",
			redirected: false,
			url: "",
			headers: {
				get: (h) => (h === "content-type" ? contentType || null : null),
			},
			clone() {
				return fakeResponse(status, contentType, extra);
			},
		},
		extra || {},
	);
}

function htmlReq(url) {
	return {
		url,
		method: "GET",
		mode: "navigate",
		headers: { get: () => null },
	};
}
function getReq(url) {
	return { url, method: "GET", mode: "cors", headers: { get: () => null } };
}
// event doubles capture respondWith/waitUntil promises.
function evt() {
	return {
		waitUntil(p) {
			this.wait = p;
		},
		respondWith(p) {
			this.response = p;
		},
	};
}

function loadWorker(overrides) {
	// Re-require with fresh globals so SELF_BASE/SCOPE resolve per test.
	globalThis.self = {
		location: { href: BASE + "service-worker.js" },
		addEventListener() {},
		clients: {
			claim() {
				return Promise.resolve("claimed");
			},
		},
	};
	Object.assign(globalThis.self, overrides || {});
	const key = require.resolve("../../projects/biwa-ride/service-worker.js");
	delete require.cache[key];
	return require("../../projects/biwa-ride/service-worker.js");
}

// --- tests ---------------------------------------------------------------------

test("install pre-caches the whole allowlist", async () => {
	const sw = loadWorker();
	const assets = (url) => fakeResponse(200, "text/plain");
	globalThis.caches = fakeCacheStorage(assets);
	globalThis.fetch = assets;
	const e = evt();
	sw.install(e);
	await e.wait;
	const store = caches._stores.get(sw.SHELL_CACHE);
	assert.ok(store, "shell cache created");
	assert.equal(store.entries.size, sw.SHELL_URLS.length);
	// Every allowlist entry resolves to a path inside the app directory.
	for (const url of store.entries.keys()) {
		assert.ok(url.startsWith(BASE), url + " inside scope");
	}
});

test("failed install rejects instead of reporting ready", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(404));
	globalThis.fetch = () => Promise.resolve(fakeResponse(404));
	const e = evt();
	sw.install(e);
	await assert.rejects(() => e.wait, /bad asset|404|addAll/);
});

test("activation evicts only old biwa shell caches", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200));
	// Seed foreign + stale caches.
	await caches.open("biwa-ride-shell-v0");
	await caches.open(sw.SHELL_CACHE);
	await caches.open("other-site-cache");
	await caches.open("biwa-ride-tiles-v2"); // ours but not a shell — kept
	const e = evt();
	sw.activate(e);
	const result = await e.wait;
	assert.equal(result, "claimed", "clients.claim() ran");
	const names = await caches.keys();
	assert.deepEqual(
		names.sort(),
		[sw.SHELL_CACHE, "biwa-ride-tiles-v2", "other-site-cache"].sort(),
	);
});

test("offline navigations serve each recognized document from the current shell", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const rootDoc = fakeResponse(200, "text/html");
	const termsDoc = fakeResponse(200, "text/html");
	const privacyDoc = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], rootDoc);
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/terms"], termsDoc);
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/privacy"], privacyDoc);
	globalThis.fetch = () => Promise.reject(new Error("offline"));

	// Every recognized entry — slash, index.html, clean URL, .html and
	// query variants — maps to its own canonical cached document.
	const cases = [
		[BASE, rootDoc],
		[BASE + "index.html", rootDoc],
		[BASE + "?day=2", rootDoc],
		[BASE + "index.html?lang=zh", rootDoc],
		[BASE + "terms", termsDoc],
		[BASE + "terms.html", termsDoc],
		[BASE + "terms?x=1", termsDoc],
		[BASE + "privacy", privacyDoc],
		[BASE + "privacy.html", privacyDoc],
	];
	for (const [variant, doc] of cases) {
		const e = evt();
		sw.fetch(Object.assign(e, { request: htmlReq(variant) }));
		assert.equal(
			await e.response,
			doc,
			variant + " served its own document",
		);
	}
});

test("visiting terms/privacy refreshes only its own key, never the main doc", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const rootDoc = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], rootDoc);
	const termsDoc = fakeResponse(200, "text/html");
	globalThis.fetch = () => Promise.resolve(termsDoc);

	// Network-first: the live terms answer is returned AND refreshes the
	// terms canonical key — the root document is never touched.
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE + "terms") }));
	assert.equal(await e.response, termsDoc);
	assert.equal(
		await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]),
		rootDoc,
		"the main shell document is never overwritten by another page",
	);
	assert.equal(
		(await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/terms"])).status,
		200,
		"the terms canonical key holds the fresh copy",
	);
});

test("unrecognized in-scope navigations are left to the network", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	await cache.put(
		sw.DOC_BY_PATH["/projects/biwa-ride/"],
		fakeResponse(200, "text/html"),
	);
	globalThis.fetch = () => Promise.resolve(fakeResponse(404, "text/html"));
	function bypassed(url) {
		const e = evt();
		sw.fetch(Object.assign(e, { request: htmlReq(url) }));
		return !("response" in e); // respondWith never called → untouched
	}
	assert.ok(bypassed(BASE + "not-a-page"), "unknown page");
	assert.ok(bypassed(BASE + "sub/nested"), "nested path");
	// The no-trailing-slash URL sits outside this worker's directory
	// scope by default — it must not be claimed here either.
	assert.ok(bypassed(ORIGIN + "/projects/biwa-ride"), "no trailing slash");
});

test("the current-generation shell wins even when an old cache exists", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	// A poisoned OLD generation — a cross-cache match must never serve it.
	const oldCache = await caches.open("biwa-ride-shell-v0");
	await oldCache.put(BASE, fakeResponse(200, "text/html"));
	const shell = fakeResponse(200, "text/html");
	const cache = await caches.open(sw.SHELL_CACHE);
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], shell);
	globalThis.fetch = () => Promise.reject(new Error("offline"));
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, shell, "current generation served");
});

test("a cache miss fetches bounded and refreshes the canonical key", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE); // empty shell
	const page = fakeResponse(200, "text/html");
	globalThis.fetch = () => Promise.resolve(page);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, page, "live answer on miss");
	const cached = await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]);
	assert.ok(cached, "a validated live answer refreshes the fallback copy");
	assert.equal(cached.status, 200);
});

test("a miss with a dead network rejects instead of faking a shell", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	await caches.open(sw.SHELL_CACHE);
	globalThis.fetch = () => Promise.reject(new Error("offline"));
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	await assert.rejects(() => e.response);
});

test("a miss on a hanging network is bounded by the navigation timeout", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	await caches.open(sw.SHELL_CACHE);
	globalThis.fetch = () => new Promise(() => {}); // hangs forever
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	await assert.rejects(() => e.response, /timeout/);
});

test("a hanging network falls back to the cached document after the bound", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const doc = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], doc);
	globalThis.fetch = () => new Promise(() => {}); // hangs forever
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	// ~3.5s real wait: the bound expires, then the fallback serves.
	assert.equal(await e.response, doc, "bounded network-first, then cache");
});

test("API, mutations, third-party and off-scope requests are bypassed", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	globalThis.fetch = () => Promise.resolve(fakeResponse(200));
	function bypassed(request) {
		const e = evt();
		sw.fetch(Object.assign(e, { request }));
		return !("response" in e); // respondWith never called → untouched
	}
	assert.ok(bypassed(getReq(BASE + "api/biwa-trip")), "same-origin API");
	assert.ok(bypassed(getReq(ORIGIN + "/api/biwa-trip")), "site api");
	assert.ok(bypassed(getReq("https://maps.googleapis.com/x")), "google");
	assert.ok(bypassed(getReq(ORIGIN + "/projects/other/app.js")), "off-scope");
	assert.ok(bypassed(getReq(BASE + "data/unlisted.json")), "not allowlisted");
	assert.ok(
		bypassed({
			url: BASE + "api/biwa-trip",
			method: "PUT",
			mode: "cors",
			headers: { get: () => null },
		}),
		"mutation",
	);
});

test("allowlisted static assets are network-first and share a canonical key", async () => {
	const sw = loadWorker();
	const asset = fakeResponse(200, "application/javascript");
	globalThis.caches = fakeCacheStorage(() => Promise.resolve(asset));
	const cache = await caches.open(sw.SHELL_CACHE);
	const stale = fakeResponse(200, "application/javascript", { tag: "stale" });
	await cache.put(BASE + "biwa-ride.js", stale);
	const live = fakeResponse(200, "application/javascript", { tag: "live" });
	let fetched = 0;
	globalThis.fetch = () => {
		fetched++;
		return Promise.resolve(live);
	};
	for (const variant of [
		BASE + "biwa-ride.js",
		BASE + "biwa-ride.js?v=9", // query is only a cache-buster
	]) {
		const e = evt();
		sw.fetch(Object.assign(e, { request: getReq(variant) }));
		assert.equal(
			await e.response,
			live,
			variant + " prefers the live answer",
		);
	}
	assert.equal(fetched, 2, "both variants hit the network");
	const cached = await cache.match(BASE + "biwa-ride.js");
	assert.equal(
		cached.tag,
		"live",
		"the canonical pathname key was refreshed once",
	);
});

test("an offline static request falls back to the cached copy", async () => {
	const sw = loadWorker();
	const asset = fakeResponse(200, "application/javascript");
	globalThis.caches = fakeCacheStorage(() => Promise.resolve(asset));
	const cache = await caches.open(sw.SHELL_CACHE);
	await cache.put(BASE + "biwa-ride.js", asset);
	globalThis.fetch = () => Promise.reject(new Error("offline"));
	const e = evt();
	sw.fetch(Object.assign(e, { request: getReq(BASE + "biwa-ride.js?v=9") }));
	assert.equal(await e.response, asset, "query-stripped canonical fallback");
});

// --- asset integrity -----------------------------------------------------------

test("allowlist covers exactly the assets the app references", () => {
	const sw = loadWorker();
	const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
	const css = fs.readFileSync(path.join(APP_DIR, "biwa-ride.css"), "utf8");

	// Every allowlisted file must exist on disk — a typo'd entry would 404
	// the whole install and silently break offline readiness.
	for (const rel of sw.SHELL_URLS) {
		if (rel === "./") continue;
		// Document entries are clean URLs — they map to an on-disk *.html.
		const file = sw.SHELL_DOCS[rel] || rel;
		assert.ok(fs.existsSync(path.join(APP_DIR, file)), file + " exists");
	}
	const allowed = new Set(sw.SHELL_URLS);

	// All local <script>/<link> refs in index.html must be in the shell.
	for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
		const ref = m[1];
		if (
			ref.startsWith("http") ||
			ref.startsWith("/") ||
			ref.startsWith("#") ||
			ref.startsWith("mailto:")
		)
			continue;
		if (!/\.(js|css|html)$/.test(ref)) continue;
		assert.ok(allowed.has(ref), ref + " is allowlisted");
	}
	// Art actually referenced by index.html and biwa-ride.css (url(...) +
	// src= gifs/svg/pngs) must be cached — no unused source art either.
	const refs = new Set();
	for (const m of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) refs.add(m[1]);
	for (const m of html.matchAll(/src="(assets\/[^"]+)"/g)) refs.add(m[1]);
	// terms.html links non-image assets too (e.g. the Tabler license file).
	const terms = fs.readFileSync(path.join(APP_DIR, "terms.html"), "utf8");
	for (const m of terms.matchAll(/(?:src|href)="(assets\/[^"]+)"/g))
		refs.add(m[1]);
	for (const ref of refs) {
		if (ref.startsWith("data:") || ref.startsWith("http")) continue;
		assert.ok(
			allowed.has(ref),
			"referenced art " + ref + " is allowlisted",
		);
	}
	for (const rel of allowed) {
		if (!rel.startsWith("assets/")) continue;
		assert.ok(
			refs.has(rel),
			"allowlisted art " + rel + " is referenced by the page",
		);
	}
});

// --- network-first specifics ---------------------------------------------------

test("an online navigation prefers the live answer over the cache", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const stale = fakeResponse(200, "text/html", { tag: "stale" });
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], stale);
	const live = fakeResponse(200, "text/html", { tag: "live" });
	globalThis.fetch = () => Promise.resolve(live);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE + "?day=2") }));
	assert.equal(await e.response, live, "the live document wins");
	const cached = await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]);
	assert.equal(
		cached.tag,
		"live",
		"the fallback copy tracks the successful visit",
	);
});

test("a non-ok answer falls back to cache; a bare miss passes it through", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const cached = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], cached);
	const notFound = fakeResponse(404, "text/html");
	globalThis.fetch = () => Promise.resolve(notFound);
	let e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, cached, "HTTP failure serves the fallback");
	// Same failure with nothing cached — the honest error comes through.
	const e2 = evt();
	cache.entries.clear();
	sw.fetch(Object.assign(e2, { request: htmlReq(BASE) }));
	assert.equal(await e2.response, notFound, "no fallback = the real 404");
});

test("a cache write failure never breaks a good online answer", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	cache.put = () => Promise.reject(new Error("quota"));
	const live = fakeResponse(200, "text/html");
	globalThis.fetch = () => Promise.resolve(live);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, live, "online fetch survives a put failure");
});

test("redirect validation: same-document aliases refresh, unrelated never do", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	// cleanUrls: /index.html 308s to / — the answer lands on a recognized
	// variant of the SAME canonical document, so it may refresh the key.
	const clean = fakeResponse(200, "text/html", {
		redirected: true,
		url: BASE,
		tag: "clean",
	});
	globalThis.fetch = () => Promise.resolve(clean);
	let e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE + "index.html") }));
	assert.equal(await e.response, clean);
	const cached = await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]);
	assert.equal(
		cached.tag,
		"clean",
		"a same-document clean-urls redirect refreshes the canonical key",
	);
	// An unrelated redirect target is returned but never written back.
	const stray = fakeResponse(200, "text/html", {
		redirected: true,
		url: ORIGIN + "/elsewhere/login",
	});
	globalThis.fetch = () => Promise.resolve(stray);
	const e2 = evt();
	sw.fetch(Object.assign(e2, { request: htmlReq(BASE + "privacy") }));
	assert.equal(await e2.response, stray);
	assert.equal(
		await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/privacy"]),
		undefined,
		"an unrelated redirect never overwrites the fallback",
	);
});

test("a disabled CacheStorage never breaks a good online answer", async () => {
	const sw = loadWorker();
	// CacheStorage itself refuses to open — the live answer still returns.
	globalThis.caches = {
		open: () => Promise.reject(new Error("storage disabled")),
		keys: () => Promise.resolve([]),
		match: () => Promise.resolve(undefined),
	};
	const live = fakeResponse(200, "text/html");
	globalThis.fetch = () => Promise.resolve(live);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, live, "the open rejection is swallowed");
});

test("a same-path redirect to a foreign origin never refreshes the cache", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const cached = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], cached);
	// A redirect landing on a lookalike path at another origin must fail
	// validation — the cached fallback serves instead.
	const foreign = fakeResponse(200, "text/html", {
		redirected: true,
		url: "https://other.example/projects/biwa-ride/",
	});
	globalThis.fetch = () => Promise.resolve(foreign);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, cached, "foreign redirect is not validated");
	assert.equal(
		await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]),
		cached,
		"the cached document was not overwritten",
	);
});

test("a non-HTML 200 cannot overwrite the cached document", async () => {
	const sw = loadWorker();
	globalThis.caches = fakeCacheStorage(() => fakeResponse(200, "text/html"));
	const cache = await caches.open(sw.SHELL_CACHE);
	const doc = fakeResponse(200, "text/html");
	await cache.put(sw.DOC_BY_PATH["/projects/biwa-ride/"], doc);
	// A JSON-shaped 200 (e.g. an API-style error body) is not a document.
	const json = fakeResponse(200, "application/json");
	globalThis.fetch = () => Promise.resolve(json);
	const e = evt();
	sw.fetch(Object.assign(e, { request: htmlReq(BASE) }));
	assert.equal(await e.response, doc, "JSON never replaces the document");
	assert.equal(
		await cache.match(sw.DOC_BY_PATH["/projects/biwa-ride/"]),
		doc,
		"the cached document was not overwritten",
	);
});
