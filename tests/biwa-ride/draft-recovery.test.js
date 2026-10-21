// Durable-draft lifecycle tests for trip-store.js: every unsent draft is
// persisted before the wire attempt, a 'reload' (new TripStore on the SAME
// localStorage map + fake server) resumes it as pendingDraft ahead of any
// refresh, and the durable copy clears only for acknowledged work.
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

// Same harness shape as trip-store.test.js, except the localStorage map is
// created per test and shared across every store instance it spawns — that
// is what makes 'reload the page' testable. opts.storageThrows simulates a
// browser that denies every write (private mode).
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
		removeItem: (k) => local.delete(k),
	};
	globalThis.document = undefined; // polling guards on this
	globalThis.setInterval = () => 0; // never fire polls in tests
	globalThis.clearInterval = () => {};
	globalThis.addEventListener = () => {};
	globalThis.fetch = fetchImpl;
}

const TripStore = require("../../projects/biwa-ride/trip-store.js");

function jsonRes(status, body) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: () => Promise.resolve(body),
	};
}

// A minimal CAS server — identical contract to trip-store.test.js: GET
// returns the newest trip, PUT compares expectedRevision and answers 409
// (carrying the latest trip) on mismatch.
function makeServer() {
	return {
		trip: null,
		rev: 0,
		down: false,
		authFail: false,
		handleGet() {
			if (this.authFail)
				return Promise.resolve(jsonRes(401, { ok: false }));
			if (this.down) {
				return Promise.resolve(
					jsonRes(503, { ok: false, error: "not_configured" }),
				);
			}
			return Promise.resolve(
				jsonRes(200, { ok: true, trip: this.trip, capabilities: {} }),
			);
		},
		handlePut(body) {
			if (this.authFail)
				return Promise.resolve(jsonRes(401, { ok: false }));
			if (this.down) {
				return Promise.resolve(
					jsonRes(503, { ok: false, error: "not_configured" }),
				);
			}
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
	};
}

function makeFetch(server) {
	const calls = [];
	const impl = (url, opts = {}) => {
		const method = (opts.method || "GET").toUpperCase();
		const call = {
			url: String(url),
			method,
			headers: opts.headers || {},
			body: opts.body ? JSON.parse(opts.body) : null,
		};
		calls.push(call);
		// Fresh JSON per fetch — a real network never shares object identity,
		// and this keeps _seedOwner's in-place revision bump from leaking
		// into later stores through the module-level seed constant.
		if (call.url.endsWith("data/checkpoints.json"))
			return Promise.resolve(
				jsonRes(200, JSON.parse(JSON.stringify(catalogue))),
			);
		if (call.url.endsWith("data/trip-seed.json"))
			return Promise.resolve(
				jsonRes(200, JSON.parse(JSON.stringify(seed))),
			);
		if (call.url.includes("biwa-trip")) {
			return method === "GET"
				? server.handleGet()
				: server.handlePut(call.body);
		}
		return Promise.resolve(jsonRes(404, { ok: false }));
	};
	impl.calls = calls;
	return impl;
}

// A "page load": stub the browser globals around the SHARED localStorage
// map, then construct+init a fresh store. Each call reuses `local`, which
// is exactly what makes a reload observable — memory is wiped, storage is
// not. Returns the store plus the fetch recorder for call inspection.
async function newStore(server, local, opts) {
	const fetchImpl = makeFetch(server);
	stubGlobals(fetchImpl, local, opts);
	const store = new TripStore();
	await store.init();
	return { store, fetchImpl };
}

// The one edit every test uses — an innocuous custom stop appended to the
// draft so the persisted copy is provably the user's mutation, not the seed.
const CUSTOM_STOP = {
	placeId: "custom-recovery-stop",
	label: "Recovery test stop",
	category: "custom",
	programmes: [],
};
function editDraft(store) {
	return store.save(function (draft) {
		draft.places = (draft.places || []).concat([CUSTOM_STOP]);
	});
}
function draftPlaces(storageMap) {
	const raw = storageMap.get(DRAFT_KEY);
	return raw ? JSON.parse(raw).places : null;
}

// --- durable draft lifecycle ---------------------------------------------------

test("a failed write is persisted and a reloaded instance resumes it at its own base", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	assert.equal(first.store.trip.revision, 1, "init seeded the owner doc");

	server.down = true; // PUT will 503
	await editDraft(first.store);
	assert.equal(first.store.state, "unavailable");
	assert.ok(draftPlaces(local), "draft persisted before the wire attempt");

	// Reload on the same storage: the draft resumes as pendingDraft BEFORE
	// any refresh can adopt over it, keeping its own CAS base revision.
	server.down = false;
	const second = await newStore(server, local);
	// init retried the restored draft the moment its first read succeeded —
	// no poll cycle needed. The write went against the draft's OWN base
	// revision, never a bumped server revision.
	assert.equal(second.store.state, "saved");
	assert.equal(second.store.pendingDraft, null);
	const puts = second.fetchImpl.calls.filter((c) => c.method === "PUT");
	assert.equal(
		puts[puts.length - 1].body.expectedRevision,
		1,
		"retry wrote against the draft base, not a bumped revision",
	);
	assert.equal(local.has(DRAFT_KEY), false, "durable copy cleared on ack");
});

test("server advanced during reload: retry conflicts, never overwrites", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	server.down = true;
	await editDraft(first.store);
	assert.ok(draftPlaces(local));

	// "Another device" advances the owner doc while this tab is gone —
	// the outage is this tab's view, the server itself stays up.
	server.down = false;
	const other = JSON.parse(JSON.stringify(server.trip));
	other.visitStatus = { "day1-start": true };
	server.handlePut({ expectedRevision: 1, trip: other });
	assert.equal(server.rev, 2);

	const second = await newStore(server, local);
	// init's post-refresh retry already ran the draft against its own base
	// (rev 1): the CAS failed and the conflict surfaced during boot.
	assert.equal(second.store.state, "conflict");
	assert.ok(second.store.conflict, "explicit conflict surfaced");
	assert.ok(second.store.pendingDraft, "draft retained as conflict side");
	assert.equal(second.store.latestServer.revision, 2);
	// The CAS failed — the server doc is untouched (still the other edit).
	assert.equal(server.rev, 2);
	assert.equal(server.trip.revision, 2);
	assert.ok(server.trip.visitStatus["day1-start"], "server edit kept");
	// And the draft stays durable — it is not silently discarded either.
	assert.ok(draftPlaces(local), "conflicted draft remains recoverable");
});

test("a saved draft is removed from durable storage", async () => {
	const local = new Map();
	const server = makeServer();
	const { store } = await newStore(server, local);
	await editDraft(store);
	assert.equal(store.state, "saved");
	assert.equal(store.pendingDraft, null);
	assert.equal(local.has(DRAFT_KEY), false);
	assert.equal(store.draftPersisted, false);
});

test("a localOnly persisted draft resumes and sends on online load", async () => {
	const local = new Map();
	const server = makeServer();
	server.down = true; // backend absent at first boot
	const first = await newStore(server, local);
	assert.equal(first.store.localOnly, true);
	const res = await editDraft(first.store);
	assert.equal(res, "local");
	assert.ok(draftPlaces(local), "localOnly draft is durable too");

	// Online reload: no server doc exists yet, so init itself retries the
	// restored draft rather than seeding the blueprint over it.
	server.down = false;
	const second = await newStore(server, local);
	assert.equal(second.store.state, "saved");
	assert.equal(second.store.pendingDraft, null);
	assert.ok(
		server.trip.places.some((p) => p.placeId === CUSTOM_STOP.placeId),
		"the unsent edit reached the server on resume",
	);
	assert.equal(local.has(DRAFT_KEY), false);
});

test("explicit discard and load-latest drop the draft and adopt server progress", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// Draft A: unsent work; the user discards it — durable copy goes and the
	// store re-adopts whatever the server says.
	server.down = true;
	await editDraft(first.store);
	server.down = false;
	await first.store.discardPendingDraft();
	assert.equal(first.store.pendingDraft, null);
	assert.equal(local.has(DRAFT_KEY), false);
	assert.equal(first.store.trip.revision, 1, "server view restored");

	// Draft B: force a conflict, then "load latest" — same lifecycle: the
	// draft dies, the server's progress fields mirror locally. The write
	// fails while unreachable so the draft stays durable, then another
	// device advances the doc before the retry.
	server.down = true;
	await editDraft(first.store);
	assert.ok(local.has(DRAFT_KEY));
	server.down = false;
	const other = JSON.parse(JSON.stringify(server.trip));
	other.visitStatus = { "day1-end": true };
	server.handlePut({ expectedRevision: 1, trip: other }); // rev -> 2
	const conflict = await first.store.retryPendingDraft();
	assert.equal(conflict, "conflict");
	await first.store.resolveConflictReload();
	assert.equal(first.store.conflict, null);
	assert.equal(first.store.pendingDraft, null);
	assert.equal(local.has(DRAFT_KEY), false);
	assert.equal(first.store.trip.revision, 2);
	assert.ok(
		first.store.localProgress.visitStatus["day1-end"],
		"server progress mirrored through normal adoption",
	);
});

test("a throwing localStorage is flagged, never silently claimed", async () => {
	const local = new Map();
	const server = makeServer();
	const { store } = await newStore(server, local, { storageThrows: true });
	assert.equal(store.storageAvailable, false, "probe caught the denial");

	const res = await editDraft(store);
	assert.equal(res, "saved", "sync itself still works in memory");
	assert.equal(store.storageAvailable, false);
	assert.equal(
		store.draftPersisted,
		false,
		'no false "persisted" claim — the flag stays honest',
	);
});

test("a restored doc renders before the network answers", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	await editDraft(first.store);
	assert.ok(draftPlaces(local));

	// Reload with the catalogue fetch held open: init must still emit the
	// restored draft — honestly 'disconnected', never a false 'saved' —
	// instead of blank-waiting on the network.
	server.down = false;
	const inner = makeFetch(server);
	const held = (url, opts) =>
		String(url).endsWith("data/checkpoints.json")
			? new Promise(() => {})
			: inner(url, opts);
	stubGlobals(held, local);
	const store = new TripStore();
	const emissions = [];
	store.onChange((st) => emissions.push(st));
	store.init(); // deliberately not awaited — the catalogue never resolves
	assert.ok(store.trip, "restored doc visible before any network answer");
	assert.ok(emissions.length > 0, "an emit painted the restored doc");
	// The view carries the draft's content but is a detached clone —
	// progress overlays must never write into the raw pending object.
	assert.deepEqual(store.trip, store.pendingDraft);
	assert.equal(store.state, "disconnected", "no false saved before ack");
});

test("a restored draft's progress outranks the stale local mirror", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	// The draft itself carries a tick the stored mirror never recorded.
	await first.store.save((d) => {
		d.visitStatus = { "draft-occ": true };
	});
	local.set(
		PROGRESS_KEY,
		JSON.stringify({
			visitStatus: { "stale-occ": true },
			programmeStatus: {},
		}),
	);
	server.down = false;

	const second = await newStore(server, local);
	assert.ok(second.store.localProgress.visitStatus["draft-occ"]);
	assert.ok(
		!second.store.localProgress.visitStatus["stale-occ"],
		"the older mirror never resurrects over the draft",
	);
});

test("an offline discard adopts last-known and never re-sends the draft", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	server.down = true;
	await editDraft(first.store);
	// Discard while unreachable: no read can confirm, but a known
	// authoritative snapshot exists — it is adopted rather than leaving
	// the abandoned draft displayed where a later save would re-send it.
	await first.store.discardPendingDraft();
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.trip.revision, 1, "last-known server doc adopted");
	assert.equal(local.has(DRAFT_KEY), false);
	assert.notEqual(first.store.state, "saved", "outage label stays honest");

	server.down = false;
	await first.store.refresh();
	await first.store.save((d) => {
		d.days[0].label = "fresh edit";
	});
	assert.equal(first.store.state, "saved");
	assert.ok(
		!server.trip.places.some((p) => p.placeId === CUSTOM_STOP.placeId),
		"discarded work never re-sent",
	);
});

test("a discard with no authoritative snapshot keeps the draft recoverable", async () => {
	const local = new Map();
	const server = makeServer();
	server.down = true; // never reachable — no server doc was ever adopted
	const first = await newStore(server, local);
	await editDraft(first.store);
	assert.equal(first.store.latestServer, null);

	await first.store.discardPendingDraft();
	assert.ok(first.store.pendingDraft, "work preserved, not silently lost");
	assert.ok(draftPlaces(local), "and it is durable again");
	assert.equal(first.store.state, "unavailable");
});
