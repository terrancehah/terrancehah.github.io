// offline-cache.test.js — silent registration + connection-transition
// toasts, offline with stubbed navigator/location. No browser, no real
// service worker, no status element anywhere.
"use strict";
const test = require("node:test");
const assert = require("node:assert");

const Offline = require("../../projects/biwa-ride/offline-cache.js");

// Swap navigator/location/history per scenario and restore after each test.
const realNavigator = globalThis.navigator;
const realLocation = globalThis.location;
const realSetTimeout = globalThis.setTimeout;
const realHistory = globalThis.history;
const realAddEventListener = globalThis.addEventListener;
test.afterEach(() => {
	Object.defineProperty(globalThis, "navigator", {
		value: realNavigator,
		configurable: true,
		writable: true,
	});
	globalThis.location = realLocation;
	globalThis.setTimeout = realSetTimeout;
	globalThis.history = realHistory;
	globalThis.addEventListener = realAddEventListener;
});
function setBrowser(navigatorValue, loc) {
	Object.defineProperty(globalThis, "navigator", {
		value: navigatorValue,
		configurable: true,
		writable: true,
	});
	globalThis.location = loc || {
		protocol: "https:",
		hostname: "terrancehah.com",
		pathname: "/projects/biwa-ride/",
	};
}

// Store double: holds the fields the module reads, captures onChange.
// connectionIssue is the proof a real wire attempt failed — the
// provisional 'disconnected' boot label alone never counts.
function fakeStore(overrides) {
	return Object.assign(
		{
			trip: { days: [] },
			pendingDraft: null,
			conflict: null,
			state: "saved",
			connectionIssue: false,
			storageAvailable: true,
			_subs: [],
			onChange(fn) {
				this._subs.push(fn);
			},
			emit() {
				this._subs.forEach((f) => f());
			},
		},
		overrides || {},
	);
}

// Captures every notify() call the module makes.
function recorder() {
	const calls = [];
	const fn = (message) => calls.push(message);
	fn.calls = calls;
	return fn;
}

// A registration whose worker is already activated. Scope defaults to the
// test location's origin (port included) so it matches the absolute scope
// offline-cache derives.
function activeReg(origin) {
	const loc = globalThis.location || {};
	const o =
		origin ||
		(loc.protocol || "https:") +
			"//" +
			(loc.hostname || "") +
			(loc.port ? ":" + loc.port : "");
	return {
		scope: o + "/projects/biwa-ride/",
		active: { state: "activated" },
		installing: null,
		addEventListener() {},
		removeEventListener() {},
	};
}

test("a healthy online boot registers silently — no toasts", async () => {
	setBrowser({
		onLine: true,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore();
	Offline.init({ store, notify });
	await new Promise((r) => setTimeout(r, 0));
	store.emit();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(
		notify.calls,
		[],
		"nothing is said while the app is healthy",
	);
});

test("registration failure while online stays silent", async () => {
	setBrowser({
		onLine: true,
		serviceWorker: { register: () => Promise.reject(new Error("denied")) },
	});
	const notify = recorder();
	Offline.init({ store: fakeStore(), notify });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(
		notify.calls,
		[],
		"a failed install is not a user problem online",
	);
});

test("unsupported and insecure environments register nothing and say nothing", () => {
	const notify = recorder();
	setBrowser({ onLine: true }); // no serviceWorker key at all
	Offline.init({ store: fakeStore(), notify });
	setBrowser(
		{
			onLine: true,
			serviceWorker: {
				register() {
					throw new Error("x");
				},
			},
		},
		{ protocol: "http:", hostname: "evil.example.com" },
	);
	Offline.init({ store: fakeStore(), notify });
	assert.deepEqual(notify.calls, []);
});

test("an offline boot with a saved itinerary toasts once, exactly", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore();
	Offline.init({ store, notify });
	await new Promise((r) => setTimeout(r, 0));
	store.emit(); // a second emit must not stack another toast
	store.emit();
	assert.deepEqual(notify.calls, [
		"Offline — using your saved itinerary. Changes stay on this phone until the connection returns.",
	]);
});

test("an offline boot with no trip yet waits — the claim needs a saved itinerary", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ trip: null });
	Offline.init({ store, notify });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(
		notify.calls,
		[],
		"no itinerary cached = nothing to promise",
	);
	// The last-known/draft restore lands — NOW the message is honest.
	store.trip = { days: [] };
	store.emit();
	assert.equal(notify.calls.length, 1);
	assert.match(notify.calls[0], /Offline — using your saved itinerary/);
});

test('a wire failure toasts "Connection interrupted" once, not on every emit', async () => {
	setBrowser({
		onLine: true, // not a definite no-signal — the wire itself failed
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected" });
	Offline.init({ store, notify });
	store.connectionIssue = true; // a real fetch rejected / 5xx answered
	store.emit();
	store.emit();
	assert.deepEqual(notify.calls, [
		"Connection interrupted — using your saved itinerary. Changes stay on this phone until syncing resumes.",
	]);
});

test("the provisional disconnected boot state does not toast", async () => {
	// init emits 'disconnected' before the first real read answers — only
	// connectionIssue, never the label, may count as an outage.
	setBrowser({
		onLine: true,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected", connectionIssue: false });
	Offline.init({ store, notify });
	store.emit();
	assert.deepEqual(notify.calls, []);
});

test("recovery toasts once, only after a saved state with nothing outstanding", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected" });
	Offline.init({ store, notify });
	assert.equal(notify.calls.length, 1, "offline episode toasted");
	// The wire heals: onLine true, issue cleared, authoritative 'saved',
	// no pending draft, no conflict.
	globalThis.navigator.onLine = true;
	store.connectionIssue = false;
	store.state = "saved";
	store.emit();
	store.emit(); // repeated emits never repeat the toast
	assert.deepEqual(notify.calls.slice(1), [
		"Connection restored — your changes are synced.",
	]);
});

test("an online event alone never claims synced", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected", connectionIssue: true });
	Offline.init({ store, notify });
	assert.equal(notify.calls.length, 1, "interrupted episode toasted");
	// onLine flips true but no successful wire has run yet — the flag is
	// still set and the state is not saved, so "synced" must not appear.
	globalThis.navigator.onLine = true;
	store.emit(); // mid-recovery emit — reconnect refresh still in flight
	assert.equal(notify.calls.length, 1);
	store.connectionIssue = false; // the refresh then actually succeeds
	store.state = "saved";
	store.emit();
	assert.equal(notify.calls.length, 2);
	assert.match(notify.calls[1], /Connection restored/);
});

test("recovery with an unsent draft waits for the send, a conflict stays silent", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected" });
	Offline.init({ store, notify });
	assert.equal(notify.calls.length, 1);
	// Back online but a draft is still pending — not synced yet.
	globalThis.navigator.onLine = true;
	store.connectionIssue = false;
	store.state = "saving";
	store.pendingDraft = { snapshot: {} };
	store.emit();
	assert.equal(notify.calls.length, 1, "pending draft = still not synced");
	// The draft then conflicts — "synced" would be a lie.
	store.state = "conflict";
	store.conflict = { draft: {}, server: {} };
	store.emit();
	assert.equal(notify.calls.length, 1);
	// Resolved cleanly: draft landed, conflict cleared, state saved.
	store.pendingDraft = null;
	store.conflict = null;
	store.state = "saved";
	store.emit();
	assert.equal(notify.calls.length, 2);
	assert.match(notify.calls[1], /Connection restored/);
});

test("a second outage toasts again after a clean recovery", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ state: "disconnected" });
	Offline.init({ store, notify });
	globalThis.navigator.onLine = true;
	store.state = "saved";
	store.emit();
	assert.equal(notify.calls.length, 2, "out + back toasted once each way");
	globalThis.navigator.onLine = false;
	store.emit();
	assert.equal(notify.calls.length, 3, "the next outage re-arms the toast");
	assert.match(notify.calls[2], /Offline — using your saved itinerary/);
});

test("offline with broken storage gets the honest keep-page-open warning", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	const store = fakeStore({ storageAvailable: false });
	Offline.init({ store, notify });
	assert.deepEqual(notify.calls, [
		"Offline — keep this page open; changes cannot be saved on this phone.",
	]);
});

test("notify receives the translated message", async () => {
	setBrowser({
		onLine: false,
		serviceWorker: { register: () => Promise.resolve(activeReg()) },
	});
	const notify = recorder();
	Offline.init({
		store: fakeStore(),
		notify,
		translate: (k) => "ZH:" + k,
	});
	assert.match(notify.calls[0], /^ZH:/, "translation runs inside the module");
});

test("a slashless app entry canonicalizes in place and registers the absolute worker URL", async () => {
	const writes = [];
	globalThis.history = {
		replaceState: (a, b, url) => writes.push(url),
	};
	let registeredWith = null;
	setBrowser(
		{
			onLine: true,
			serviceWorker: {
				register: (url) => {
					registeredWith = url;
					return Promise.resolve(activeReg("http://localhost:3000"));
				},
			},
		},
		{
			// The projects.html card links here — the slashless entry.
			protocol: "http:",
			hostname: "localhost",
			port: "3000",
			href: "http://localhost:3000/projects/biwa-ride?day=2#top",
			pathname: "/projects/biwa-ride",
			search: "?day=2",
			hash: "#top",
		},
	);
	Offline.init({ store: fakeStore(), notify: recorder() });
	assert.equal(
		registeredWith,
		"http://localhost:3000/projects/biwa-ride/service-worker.js",
		"worker URL is absolute under the app directory, port preserved",
	);
	assert.deepEqual(
		writes,
		["/projects/biwa-ride/?day=2#top"],
		"slash added in place — query and hash preserved, no redirect",
	);
});

test("a deep in-app path registers the same absolute worker URL without rewriting", async () => {
	const writes = [];
	globalThis.history = {
		replaceState: (a, b, url) => writes.push(url),
	};
	let registeredWith = null;
	setBrowser(
		{
			onLine: true,
			serviceWorker: {
				register: (url) => {
					registeredWith = url;
					return Promise.resolve(activeReg());
				},
			},
		},
		{
			protocol: "https:",
			hostname: "terrancehah.com",
			href: "https://terrancehah.com/projects/biwa-ride/terms",
			pathname: "/projects/biwa-ride/terms",
			search: "",
			hash: "",
		},
	);
	Offline.init({ store: fakeStore(), notify: recorder() });
	assert.equal(
		registeredWith,
		"https://terrancehah.com/projects/biwa-ride/service-worker.js",
		"scope expectation never derives from the entry path",
	);
	assert.deepEqual(writes, [], "terms/privacy URLs are never canonicalized");
});
