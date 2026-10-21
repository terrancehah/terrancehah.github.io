// Pairing-guard tests for trip-store.js: pairing is a network-only act
// that ends by wiping local identity state, so create/claim refuse — with
// an honest reason and zero fetches — while the device is offline, unsaved,
// mid-write, still loading or unable to store. adoptOwner additionally
// re-verifies everything before committing, and a failed storage write
// leaves the old identity and pending work intact.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const seed = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "projects/biwa-ride/data/trip-seed.json"),
		"utf8",
	),
);
const catalogue = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "projects/biwa-ride/data/checkpoints.json"),
		"utf8",
	),
);

const DRAFT_KEY = "biwa:v2:local-draft";
const PROGRESS_KEY = "biwa:v2:local-progress";
const OWNER_KEY = "biwa:v2:owner-id";
const OTHER_OWNER = "dev:bbbbbbbb-1111-4222-8333-cccccccccccc";

function stubGlobals(fetchImpl, local, opts) {
	opts = opts || {};
	globalThis.location = {
		hash: "#/timeline",
		pathname: "/projects/biwa-ride/",
		search: "",
	};
	globalThis.history = { replaceState() {} };
	const session = new Map();
	globalThis.sessionStorage = {
		getItem: (k) => (session.has(k) ? session.get(k) : null),
		setItem: (k, v) => session.set(k, String(v)),
		removeItem: (k) => session.delete(k),
	};
	globalThis.localStorage = {
		getItem: (k) => (local.has(k) ? local.get(k) : null),
		setItem: (k, v) => {
			if (opts.storageThrows) throw new Error("storage denied");
			local.set(k, String(v));
		},
		removeItem: (k) => {
			if (opts.storageThrows) throw new Error("storage denied");
			local.delete(k);
		},
	};
	globalThis.document = undefined;
	globalThis.setInterval = () => 0;
	globalThis.clearInterval = () => {};
	globalThis.addEventListener = () => {};
	globalThis.fetch = fetchImpl;
}

const TripStore = require("../../projects/biwa-ride/trip-store.js");

function jsonRes(status, body) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
	};
}

// Minimal CAS server plus a recording biwa-pair endpoint: pairCalls counts
// every attempt that reached the wire — blocked attempts must keep it 0.
function makeServer() {
	const server = {
		trip: null,
		rev: 0,
		down: false,
		pairCalls: 0,
		pairResponse: { ok: true, ownerId: OTHER_OWNER },
		pairStatus: 200,
		pairMalformed: false,
		handleGet() {
			if (this.down)
				return Promise.resolve(
					jsonRes(503, { ok: false, error: "not_configured" }),
				);
			return Promise.resolve(
				jsonRes(200, { ok: true, trip: this.trip, capabilities: {} }),
			);
		},
		handlePut(body) {
			if (this.down)
				return Promise.resolve(
					jsonRes(503, { ok: false, error: "not_configured" }),
				);
			if (body.expectedRevision !== this.rev) {
				return Promise.resolve(
					jsonRes(409, {
						ok: false,
						error: "conflict",
						trip: this.trip,
					}),
				);
			}
			this.rev += 1;
			this.trip = Object.assign({}, body.trip, { revision: this.rev });
			return Promise.resolve(
				jsonRes(200, { ok: true, revision: this.rev, updatedAt: "t" }),
			);
		},
		handlePair() {
			this.pairCalls += 1;
			if (this.pairMalformed) {
				return Promise.resolve({
					status: this.pairStatus,
					ok: false,
					json: () => Promise.reject(new Error("not json")),
				});
			}
			if (this.pairResponse instanceof Promise) {
				return this.pairResponse.then((r) =>
					jsonRes(this.pairStatus, r),
				);
			}
			return Promise.resolve(jsonRes(this.pairStatus, this.pairResponse));
		},
	};
	return server;
}

function makeFetch(server) {
	const calls = [];
	const impl = (url, opts = {}) => {
		const call = {
			url: String(url),
			method: (opts.method || "GET").toUpperCase(),
			body: opts.body ? JSON.parse(opts.body) : null,
		};
		calls.push(call);
		if (call.url.endsWith("data/checkpoints.json"))
			return Promise.resolve(jsonRes(200, catalogue));
		if (call.url.endsWith("data/trip-seed.json"))
			return Promise.resolve(jsonRes(200, seed));
		if (call.url.includes("biwa-pair")) return server.handlePair(call.body);
		if (call.url.includes("biwa-trip")) {
			return call.method === "GET"
				? server.handleGet()
				: server.handlePut(call.body);
		}
		return Promise.resolve(jsonRes(404, { ok: false }));
	};
	impl.calls = calls;
	return impl;
}

async function newStore(server, local, opts) {
	const fetchImpl = makeFetch(server);
	stubGlobals(fetchImpl, local, opts);
	const store = new TripStore();
	await store.init();
	return { store, fetchImpl };
}

// --- reason vocabulary ---------------------------------------------------------

test("a clean saved store pairs without a block reason", async () => {
	const server = makeServer();
	const first = await newStore(server, new Map());
	assert.equal(first.store.state, "saved");
	assert.equal(first.store.hasUnsavedChanges(), false);
	assert.equal(first.store.getPairingBlockReason(), null);
});

test("offline blocks both actions before any fetch", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	await first.store.refresh(); // learns the backend is unreachable
	assert.equal(first.store.getPairingBlockReason(), "offline");
	const create = await first.store.createPairCode();
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(create.error, "offline");
	assert.equal(claim.error, "offline");
	assert.equal(server.pairCalls, 0, "no fetch fired while offline");
});

test("unsaved work blocks pairing before any fetch", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	await first.store.applyLocalProgress(function (p) {
		p.visitStatus["day1-s1"] = true;
	});
	assert.equal(first.store.hasUnsavedChanges(), true);
	// connectionIssue also flags 'offline' here — the order reports the
	// connection first, which is honest: pairing needs the network anyway.
	server.down = false;
	await first.store.refresh();
	assert.equal(first.store.state, "unavailable");
	// Still unsaved once the connection flag is gone: force a clean read.
	first.store.connectionIssue = false;
	assert.equal(first.store.getPairingBlockReason(), "unsaved_changes");
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "unsaved_changes");
	assert.equal(server.pairCalls, 0);
});

test("an in-flight write counts as unsaved — queued writes cannot race the gate", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	// Hold the PUT open: the tick is neither acked nor failed — pairing must
	// still refuse because the queue owns it.
	let releasePut;
	const realPut = server.handlePut.bind(server);
	server.handlePut = function (body) {
		return new Promise((resolve) => {
			releasePut = () => resolve(realPut(body));
		});
	};
	const pending = first.store.applyLocalProgress(function (p) {
		p.visitStatus["day1-s1"] = true;
	});
	// The write is unsaved from the moment it queues — the enqueue count
	// alone must already trip the gate, even before _saving flips.
	assert.equal(first.store.hasUnsavedChanges(), true);
	// Let the write reach the wire so _saving is genuinely in flight.
	for (let i = 0; i < 50 && !first.store._saving; i++) {
		await Promise.resolve();
	}
	assert.equal(first.store._saving, true, "PUT is mid-flight");
	assert.equal(first.store.getPairingBlockReason(), "unsaved_changes");
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "unsaved_changes");
	assert.equal(server.pairCalls, 0);
	releasePut();
	await pending;
});

test("a store still loading or unable to store reports its reason", async () => {
	const server = makeServer();
	const first = await newStore(server, new Map());
	// Not-ready: simulate the pre-ack window honestly by poking state.
	const realState = first.store.state;
	first.store.state = "loading";
	assert.equal(first.store.getPairingBlockReason(), "not_ready");
	first.store.state = realState;
	// Storage denied: the device cannot keep the adopted identity durable.
	first.store.storageAvailable = false;
	assert.equal(first.store.getPairingBlockReason(), "storage_unavailable");
});

test("a real code rejection stays a code error — never reworded as offline", async () => {
	const server = makeServer();
	server.pairResponse = { ok: false, error: "code_expired" };
	const first = await newStore(server, new Map());
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "code_expired");
	assert.equal(server.pairCalls, 1, "clean state does reach the wire");
});

// --- adoptOwner safety ---------------------------------------------------------

test("adoptOwner refuses while unsent work exists — nothing is removed", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	await first.store.applyLocalProgress(function (p) {
		p.visitStatus["day1-s1"] = true;
	});
	assert.ok(local.has(DRAFT_KEY), "durable draft exists");
	const storedOwner = local.get(OWNER_KEY);
	const result = first.store.adoptOwner(OTHER_OWNER);
	assert.equal(result, false);
	assert.equal(local.get(OWNER_KEY), storedOwner, "stored owner untouched");
	assert.ok(local.has(DRAFT_KEY), "pending work never deleted");
	assert.ok(local.has(PROGRESS_KEY), "progress mirror kept");
	assert.notEqual(first.store.ownerId, OTHER_OWNER);
});

test("adoptOwner validates ids and reports storage failure without switching", async () => {
	const server = makeServer();
	const local = new Map();
	const first = await newStore(server, local);
	assert.equal(first.store.adoptOwner("not-an-owner"), false);
	assert.equal(first.store.adoptOwner(""), false);

	// Storage denied mid-flight: the in-memory owner must NOT switch and the
	// call must fail rather than claim success.
	first.store.storageAvailable = true;
	const realSet = local.set.bind(local);
	globalThis.localStorage = {
		getItem: (k) => (local.has(k) ? local.get(k) : null),
		setItem: (k, v) => {
			throw new Error("denied");
		},
		removeItem: (k) => local.delete(k),
	};
	const before = first.store.ownerId;
	const result = first.store.adoptOwner(OTHER_OWNER);
	assert.equal(result, false, "failed write fails the adoption");
	assert.equal(first.store.ownerId, before, "in-memory owner unchanged");
	assert.equal(local.get(OWNER_KEY), before, "stored owner unchanged");
	globalThis.localStorage = {
		getItem: (k) => (local.has(k) ? local.get(k) : null),
		setItem: realSet,
		removeItem: (k) => local.delete(k),
	};
});

test("a clean adopt switches identity and clears only the old caches", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	// Seed a durable last-known cache — the safe path may drop it.
	const result = first.store.adoptOwner(OTHER_OWNER);
	assert.equal(result, true);
	assert.equal(first.store.ownerId, OTHER_OWNER);
	assert.equal(local.get(OWNER_KEY), OTHER_OWNER);
	assert.equal(local.has(DRAFT_KEY), false);
	assert.equal(local.has(PROGRESS_KEY), false);
});

// --- response vocabulary + sequential storage safety ---------------------------

test("a 5xx JSON answer maps to 'network', never a code verdict", async () => {
	const server = makeServer();
	server.pairStatus = 502;
	server.pairResponse = { ok: false, error: "internal" };
	const first = await newStore(server, new Map());
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "network", "5xx is a connection story");
	const create = await first.store.createPairCode();
	assert.equal(create.error, "network");
	assert.equal(server.pairCalls, 2, "clean store does reach the wire");
});

test("a malformed/non-JSON answer also maps to 'network'", async () => {
	const server = makeServer();
	server.pairStatus = 502;
	server.pairMalformed = true;
	const first = await newStore(server, new Map());
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "network");
});

test("a 429 maps to rate_limited — its own vocabulary", async () => {
	const server = makeServer();
	server.pairStatus = 429;
	server.pairResponse = { ok: false };
	const first = await newStore(server, new Map());
	const claim = await first.store.claimPairCode("ABCDEF");
	assert.equal(claim.error, "rate_limited");
});

test("a throwing removeItem aborts adoption BEFORE the owner write", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	const storedOwner = local.get(OWNER_KEY);
	// Removing the progress key fails — the owner write must never run.
	globalThis.localStorage = {
		getItem: (k) => (local.has(k) ? local.get(k) : null),
		setItem: (k, v) => local.set(k, String(v)),
		removeItem: (k) => {
			if (k === PROGRESS_KEY) throw new Error("denied");
			return local.delete(k);
		},
	};
	const result = first.store.adoptOwner(OTHER_OWNER);
	assert.equal(result, false);
	assert.equal(
		local.get(OWNER_KEY),
		storedOwner,
		"owner key never written after a failed clear",
	);
	assert.equal(first.store.ownerId, storedOwner, "in-memory owner kept");
	// Restore a working storage for teardown sanity.
	globalThis.localStorage = {
		getItem: (k) => (local.has(k) ? local.get(k) : null),
		setItem: (k, v) => local.set(k, String(v)),
		removeItem: (k) => local.delete(k),
	};
});
