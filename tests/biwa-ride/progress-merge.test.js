// Progress-merge tests for trip-store.js: routine check-ins from paired
// same-owner devices auto-combine on CAS-409 (no keep-mine dialog), while
// plan edits keep the explicit conflict. The durable draft carries its
// merge metadata under a reserved local-only field so a reload mid-write
// can still merge; the field must never reach the wire.
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

// Same harness shape as draft-recovery.test.js — a shared localStorage map
// per test makes 'reload the page' observable. Deep-cloned JSON on every
// fetch keeps object identity honest across store instances.
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
		json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
	};
}

// Minimal CAS server — GET returns the newest trip, PUT compares
// expectedRevision and answers 409 (carrying the latest trip) on mismatch.
// gateNextPut holds the next PUT until released; holdAtPut holds the Nth
// trip-PUT (post-seed numbering, so tests can stall a specific queued
// write); failNextPuts 503s that many PUTs — all deterministic mid-queue
// levers for ack-boundary testing.
function makeServer() {
	const server = {
		trip: null,
		rev: 0,
		down: false,
		putCount: 0,
		gateNextPut: null,
		holdAtPut: -1,
		holdRelease: null,
		failNextPuts: 0,
		bumpOnNextPut: false,
		handleGet() {
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
			if (this.gateNextPut) {
				const release = this.gateNextPut;
				this.gateNextPut = null;
				return release.then(() => this._put(body));
			}
			if (this.putCount === this.holdAtPut && this.holdRelease) {
				const gate = this.holdRelease;
				this.holdRelease = null;
				this.putCount += 1;
				return gate.then(() => this._put(body));
			}
			this.putCount += 1;
			return this._put(body);
		},
		_put(body) {
			if (this.down || this.failNextPuts > 0) {
				if (this.failNextPuts > 0) this.failNextPuts -= 1;
				return Promise.resolve(
					jsonRes(503, { ok: false, error: "not_configured" }),
				);
			}
			if (this.bumpOnNextPut) {
				this.bumpOnNextPut = false;
				// Another device wrote between our reads — CAS must fail.
				this.rev += 1;
				this.trip = Object.assign(
					{},
					JSON.parse(JSON.stringify(this.trip)),
					{ revision: this.rev },
				);
				return Promise.resolve(
					jsonRes(409, {
						ok: false,
						error: "conflict",
						trip: this.trip,
					}),
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
	return server;
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

async function newStore(server, local, opts) {
	const fetchImpl = makeFetch(server);
	stubGlobals(fetchImpl, local, opts);
	const store = new TripStore();
	await store.init();
	return { store, fetchImpl };
}

// Simulate a paired device's write directly against the fake server —
// clone so the shared doc object is never mutated in place.
function remoteWrite(server, mutator) {
	const doc = JSON.parse(JSON.stringify(server.trip));
	mutator(doc);
	server.trip = doc;
	server.rev += 1;
	server.trip.revision = server.rev;
	return server.trip;
}

function tick(store, occId, value) {
	return store.applyLocalProgress(function (p) {
		if (value === false) delete p.visitStatus[occId];
		else p.visitStatus[occId] = true;
	});
}

function putsOf(fetchImpl) {
	return fetchImpl.calls.filter((c) => c.method === "PUT");
}

// --- progress-only auto-merge -------------------------------------------------

test("paired-device tick auto-merges: local tickA + remote tickB land together, no dialog", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	assert.equal(first.store.trip.revision, 1);

	// The paired phone checks a different stop — the doc advances to rev2.
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s2"] = true;
	});

	const result = await tick(first.store, "day1-s1", true);
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null, "no keep-mine dialog");
	assert.equal(server.rev, 3, "merged retry landed as rev3");
	assert.deepEqual(
		Object.keys(server.trip.visitStatus).sort(),
		["day1-s1", "day1-s2"],
		"both ticks preserved server-side",
	);
	assert.deepEqual(
		Object.keys(first.store.localProgress.visitStatus).sort(),
		["day1-s1", "day1-s2"],
		"the mirror carries the merged progress",
	);
	assert.equal(
		first.store.trip.visitStatus["day1-s2"],
		true,
		"view shows the remote tick",
	);
	// Seed write + the rejected attempt + the merged retry.
	assert.equal(putsOf(first.fetchImpl).length, 3);
});

test("a remote write of the SAME flag is satisfied without a second PUT", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s1"] = true;
	});
	const result = await tick(first.store, "day1-s1", true);
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null);
	assert.equal(server.rev, 2, "no extra write — merged equals server");
	// Seed write + the single rejected attempt — no merged PUT needed.
	assert.equal(putsOf(first.fetchImpl).length, 2);
});

test("same-key untick wins as the latest local action through a merge", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	await tick(first.store, "day1-s1", true); // saved → rev2

	// Remote device bumps the doc (an unrelated plan note); locally the
	// user unticks the same stop — the uncheck must win on merge.
	remoteWrite(server, (doc) => {
		doc.notes = "remote note";
	});
	assert.equal(server.trip.visitStatus["day1-s1"], true);

	const result = await tick(first.store, "day1-s1", false);
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null);
	assert.equal(
		server.trip.visitStatus["day1-s1"],
		undefined,
		"the untick landed — deleted, not true",
	);
	assert.equal(server.trip.notes, "remote note", "remote edit preserved");
	assert.equal(first.store.localProgress.visitStatus["day1-s1"], undefined);
});

test("visit and programme deltas merge across memberships", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s1"] = true;
	});
	// Mizudori is a member of BOTH rally and official — ticking it through
	// the programme families is one delta each; a rally-only place must not
	// gain an official flag.
	const result = await first.store.applyLocalProgress(function (p) {
		p.visitStatus["day1-s3"] = true;
		p.programmeStatus.rally = p.programmeStatus.rally || {};
		p.programmeStatus.official = p.programmeStatus.official || {};
		p.programmeStatus.rally["mizudori-station"] = true;
		p.programmeStatus.official["mizudori-station"] = true;
		p.programmeStatus.rally["rally-mizunomori"] = true;
		p.programmeStatus.official["rally-mizunomori"] = true; // wrong family
	});
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null);
	const doc = server.trip;
	assert.equal(doc.visitStatus["day1-s3"], true);
	assert.equal(doc.visitStatus["day2-s1"], true, "remote tick preserved");
	assert.equal(doc.programmeStatus.rally["mizudori-station"], true);
	assert.equal(doc.programmeStatus.official["mizudori-station"], true);
	assert.equal(doc.programmeStatus.rally["rally-mizunomori"], true);
	assert.equal(
		doc.programmeStatus.official["rally-mizunomori"],
		undefined,
		"delta for a non-member family never applies",
	);
});

test("a delta for a deleted stop is dropped, never resurrected", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	// Remote plan edit removes day1-s3 entirely.
	remoteWrite(server, (doc) => {
		doc.days[0].stops = doc.days[0].stops.filter(
			(s) => s.occurrenceId !== "day1-s3",
		);
	});
	const result = await tick(first.store, "day1-s3", true);
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null);
	assert.equal(
		server.trip.visitStatus["day1-s3"],
		undefined,
		"deleted occurrence stays deleted",
	);
	// No PUT retry needed — merged equals server, so adoption satisfied it.
	assert.equal(putsOf(first.fetchImpl).length, 2);
	// The skipped delta must be RETIRED by the ack: it can never be
	// reflected on the doc, so leaving it tracked would pin pendingDraft
	// and block pairing forever.
	assert.equal(first.store._pendingDeltaList().length, 0);
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.state, "saved");
	assert.equal(first.store.hasUnsavedChanges(), false);
	assert.equal(
		first.store.localProgress.visitStatus["day1-s3"],
		undefined,
		"mirror dropped the dead tick too",
	);
	assert.equal(
		await first.store._retryPendingDraft(),
		"skipped",
		"nothing left for the next poll to retry",
	);
});

test("a second conflict keeps progress durable — unsent, never a dialog", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s2"] = true;
	});
	// The merged retry meets a THIRD revision — the other device wrote
	// between our conflict read and the merge write.
	const realPut = server._put.bind(server);
	server._put = function (body) {
		// First PUT 409s on revision; the merged retry (expectedRevision 2)
		// hits the bumped rev 3.
		if (body.expectedRevision === 2) {
			server.rev = 3;
			server.trip.revision = 3;
		}
		return realPut(body);
	};
	const result = await tick(first.store, "day1-s1", true);
	assert.notEqual(result, "saved");
	assert.equal(first.store.conflict, null, "progress-only never dialogs");
	assert.ok(first.store.pendingDraft, "merged work stays durable");
	const raw = JSON.parse(local.get(DRAFT_KEY));
	assert.equal(raw.visitStatus["day1-s1"], true);
	assert.equal(raw.visitStatus["day1-s2"], true);
	// The durable metadata says this is still progress-only work.
	assert.equal(raw._biwaLocalProgress.progressOnly, true);
	assert.ok(
		raw._biwaLocalProgress.changes.some(
			(c) =>
				c.kind === "visit" && c.key === "day1-s1" && c.value === true,
		),
	);
});

test("offline tick survives reload and merges after a remote advance", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	const offline = await tick(first.store, "day1-s1", true);
	assert.notEqual(offline, "saved");
	assert.ok(JSON.parse(local.get(DRAFT_KEY)), "durable copy persisted");

	// While we were offline the paired phone ticked another stop.
	server.down = false;
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s2"] = true;
	});

	// Reload: the restored draft retries at its own base, 409s, and its
	// persisted merge metadata replays the tick onto the fresh doc.
	const second = await newStore(server, local);
	assert.equal(second.store.state, "saved");
	assert.equal(second.store.conflict, null);
	assert.deepEqual(Object.keys(server.trip.visitStatus).sort(), [
		"day1-s1",
		"day1-s2",
	]);
	assert.equal(local.has(DRAFT_KEY), false, "durable copy cleared on ack");
});

test("mixed plan+progress conflict keeps the dialog — keep-mine preserves progress", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// A plan edit (plan seq) makes the pending work mixed even when a tick
	// rides inside the same draft.
	await first.store.save(function (d) {
		d.visitStatus["day1-s1"] = true;
	});
	assert.equal(server.trip.visitStatus["day1-s1"], true, "baseline saved");

	// Tick in flight + a plan edit queued behind it → the pending work is
	// MIXED when the first write conflicts.
	let releaseTick;
	server.gateNextPut = new Promise((r) => {
		releaseTick = r;
	});
	const pTick = first.store.applyLocalProgress(function (p) {
		p.visitStatus["day1-s4"] = true;
	});
	const pPlan = first.store.save(function (d) {
		d.places.push({
			placeId: "custom-mixed",
			label: "Mixed stop",
			category: "custom",
			programmes: [],
		});
	});
	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s1"] = true;
		doc.notes = "remote note";
	});
	releaseTick();
	const results = await Promise.all([pTick, pPlan]);
	assert.equal(results[0], "conflict");
	assert.equal(results[1], "conflict");
	assert.equal(first.store.state, "conflict");
	assert.ok(first.store.conflict, "explicit conflict declared");
	assert.equal(
		first.store.conflict.draft.visitStatus["day1-s4"],
		true,
		"conflict draft still carries the LOCAL tick — overlay never leaked",
	);
	assert.equal(
		first.store.conflict.server.visitStatus["day1-s4"],
		undefined,
		"server side is untouched",
	);
	assert.ok(
		first.store.conflict.draft.places.some(
			(p) => p.placeId === "custom-mixed",
		),
		"plan edit survives in the draft",
	);

	// Keep-mine: the reapply replaces the whole shared snapshot — the local
	// plan edit AND the local ticks survive (whole-snapshot replace is the
	// documented 'keep mine' semantics, never a merge).
	const reapplied = await first.store.resolveConflictReapply();
	assert.equal(reapplied, "saved");
	assert.deepEqual(
		Object.keys(server.trip.visitStatus).sort(),
		["day1-s1", "day1-s4"],
		"local progress lands whole",
	);
	assert.ok(server.trip.places.some((p) => p.placeId === "custom-mixed"));
});

test("queued progress writes keep every op and the mirror consistent", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// Hold the first PUT so the second tick queues behind it while a remote
	// tick lands — both local ops must survive the merge chain.
	let releaseFirst;
	server.gateNextPut = new Promise((r) => {
		releaseFirst = r;
	});
	const pA = tick(first.store, "day1-s1", true);
	const pB = tick(first.store, "day1-s4", true);
	// Remote advance while PUT1 is still in flight.
	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s2"] = true;
	});
	releaseFirst();
	const [rA, rB] = await Promise.all([pA, pB]);
	assert.equal(rA, "saved");
	assert.equal(rB, "saved");
	assert.equal(first.store.conflict, null);
	assert.deepEqual(Object.keys(server.trip.visitStatus).sort(), [
		"day1-s1",
		"day1-s4",
		"day2-s2",
	]);
	assert.deepEqual(
		Object.keys(first.store.localProgress.visitStatus).sort(),
		["day1-s1", "day1-s4", "day2-s2"],
		"mirror never flickers a pending tick out",
	);
});

test("a legacy draft without merge metadata stays explicit, never auto-merged", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	// Forge an old-generation durable draft: no _biwaLocalProgress field at
	// all. It must be treated as mixed — auto-merge never guesses.
	const draft = JSON.parse(JSON.stringify(first.store.trip));
	draft.notes = "legacy offline note";
	draft.visitStatus["day1-s1"] = true;
	local.set(DRAFT_KEY, JSON.stringify(draft));

	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s3"] = true;
	});
	const second = await newStore(server, local);
	assert.equal(second.store.state, "conflict");
	assert.ok(second.store.conflict, "legacy draft needs the explicit path");
	assert.equal(second.store.conflict.draft.notes, "legacy offline note");
	assert.equal(second.store.conflict.draft.visitStatus["day1-s1"], true);
});

test("draft metadata rides inside the durable copy but never the wire", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	server.down = true;
	await tick(first.store, "day1-s1", true);
	const raw = JSON.parse(local.get(DRAFT_KEY));
	assert.ok(raw._biwaLocalProgress, "metadata persisted with the draft");
	assert.equal(raw._biwaLocalProgress.progressOnly, true);
	server.down = false;
	await first.store.refresh();
	const retry = await first.store.retryPendingDraft();
	assert.equal(retry, "saved");
	const lastPut = putsOf(first.fetchImpl).slice(-1)[0];
	assert.equal(
		lastPut.body.trip._biwaLocalProgress,
		undefined,
		"reserved field stripped from the payload",
	);
	assert.equal(lastPut.body.trip.visitStatus["day1-s1"], true);
});

// --- ack-boundary regressions (review fixes) -----------------------------------

test("queued plan saves ack only their own batch — a failed B is never acked by A", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// Enqueue planA then planB in the same turn — planB's seq exists BEFORE
	// A's write runs, so a global-seq cap would wrongly ack it on A's ack.
	const pA = first.store.save(function (d) {
		d.notes = "planA";
	});
	const pB = first.store.save(function (d) {
		d.notes = "planB";
		server.failNextPuts = 1; // B's own PUT fails after A succeeded
	});
	const [rA, rB] = await Promise.all([pA, pB]);
	assert.equal(rA, "saved");
	assert.notEqual(rB, "saved");
	assert.equal(
		first.store._pendingPlanSeqs.length,
		1,
		"planB's tracking survived A's ack",
	);
	assert.ok(first.store.pendingDraft, "B's draft kept");

	// Remote device ticks meanwhile; our next tick must NOT auto-merge —
	// B's plan edit is unacked, so the conflict stays explicit.
	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s7"] = true;
	});
	const rD = await tick(first.store, "day1-s1", true);
	assert.equal(rD, "conflict");
	assert.equal(first.store.state, "conflict");
	assert.equal(
		first.store.conflict.draft.notes,
		"planB",
		"the kept draft still carries B's plan edit",
	);
	assert.equal(
		first.store.conflict.draft.visitStatus["day1-s1"],
		true,
		"and the newest tick",
	);
	assert.ok(
		first.store._pendingPlanSeqs.length >= 1,
		"plan seqs still tracked",
	);
});

test("a throwing save mutator retires only its own classification", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	const failed = await first.store.save(function () {
		throw new Error("userland mutator exploded");
	});
	assert.equal(failed, "error");
	assert.equal(first.store._pendingPlanSeqs.length, 0, "rolled back");
	assert.equal(
		first.store.hasUnsavedChanges(),
		false,
		"no phantom pending work blocks pairing",
	);

	// A following progress write still auto-merges — the failed plan save
	// left no residue that would force a mixed conflict.
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s2"] = true;
	});
	const result = await tick(first.store, "day1-s1", true);
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null, "auto-merge, no dialog");
});

test("two queued plan writes both land — no false conflict, then a clean saved", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	const pA = first.store.save(function (d) {
		d.notes = "planA";
	});
	const pB = first.store.save(function (d) {
		d.places.push({
			placeId: "custom-b",
			label: "B stop",
			category: "custom",
			programmes: [],
		});
	});
	const [rA, rB] = await Promise.all([pA, pB]);
	assert.equal(rA, "saved");
	assert.equal(rB, "saved");
	assert.equal(first.store.conflict, null);
	assert.equal(
		first.store.pendingDraft,
		null,
		"fully acked — nothing retained",
	);
	assert.equal(server.trip.notes, "planA");
	assert.ok(server.trip.places.some((p) => p.placeId === "custom-b"));
	assert.equal(
		local.has(DRAFT_KEY),
		false,
		"durable copy cleared once ALL acked",
	);
});

test("a mid-queue ack never claims all-synced while work is unacked", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// Hold the SECOND trip-PUT so A finalizes while B is in flight.
	server.holdAtPut = server.putCount + 1;
	server.holdRelease = new Promise((r) => {
		server._releaseHold = r;
	});
	const pA = first.store.save(function (d) {
		d.notes = "planA";
	});
	const pB = first.store.save(function (d) {
		d.notes = "planB";
	});
	const rA = await pA;
	assert.equal(rA, "saved");
	// A is acked but B is still queued/in flight: the store must keep an
	// honest pending anchor and never report a clean saved state.
	assert.equal(first.store.hasUnsavedChanges(), true);
	assert.ok(first.store.pendingDraft, "durable anchor retained mid-queue");
	assert.ok(local.has(DRAFT_KEY), "durable copy kept while ops unacked");
	// The poll-retry must not race the queued write.
	const retry = await first.store._retryPendingDraft();
	assert.equal(retry, "skipped", "queued writes own the draft right now");

	server._releaseHold();
	const rB = await pB;
	assert.equal(rB, "saved");
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.state, "saved");
	assert.equal(local.has(DRAFT_KEY), false);
});

test("a programme delta whose family membership is gone retires cleanly", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	// Remote plan edit strips Mizudori's official membership — the place
	// stays (still a rally member), so only the official delta is dead.
	remoteWrite(server, (doc) => {
		doc.places.forEach((p) => {
			if (p.placeId === "mizudori-station") p.programmes = ["rally"];
		});
	});
	const result = await first.store.applyLocalProgress(function (p) {
		p.programmeStatus.official = p.programmeStatus.official || {};
		p.programmeStatus.official["mizudori-station"] = true;
	});
	assert.equal(result, "saved");
	assert.equal(first.store.conflict, null);
	assert.equal(
		(server.trip.programmeStatus.official || {})["mizudori-station"],
		undefined,
		"a delta for a family the place left never lands",
	);
	// Retired at ack — no pending wedge, pairing stays reachable.
	assert.equal(first.store._pendingDeltaList().length, 0);
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.state, "saved");
	assert.equal(first.store.hasUnsavedChanges(), false);
	assert.equal(await first.store._retryPendingDraft(), "skipped");
});

test("a deleted-target delta retires while a mid-merge tick stays tracked and lands", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);
	remoteWrite(server, (doc) => {
		doc.days[0].stops = doc.days[0].stops.filter(
			(s) => s.occurrenceId !== "day1-s3",
		);
	});
	// Hold the merge PUT (the second user PUT after the rejected attempt)
	// so a fresh tick records its delta while the merge is in flight.
	server.holdAtPut = server.putCount + 2;
	server.holdRelease = new Promise((r) => {
		server._releaseHold = r;
	});
	const p1 = tick(first.store, "day1-s3", true);
	await new Promise((r) => setTimeout(r, 15)); // let the merge PUT reach the hold
	const p2 = tick(first.store, "day2-s7", true);
	server._releaseHold();
	const r1 = await p1;
	assert.equal(r1, "saved");
	// The deleted stop's delta retired at the merge ack; the tick recorded
	// mid-merge outlives it (seq > mergeSeq) and stays honest work.
	assert.equal(
		first.store.hasUnsavedChanges(),
		true,
		"mid-merge tick still pending",
	);
	const r2 = await p2;
	assert.equal(r2, "saved");
	assert.equal(first.store._pendingDeltaList().length, 0);
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.state, "saved");
	assert.equal(first.store.hasUnsavedChanges(), false);
	assert.equal(
		server.trip.visitStatus["day1-s3"],
		undefined,
		"dead delta never resurrected",
	);
	assert.equal(
		server.trip.visitStatus["day2-s7"],
		true,
		"the newer tick landed through its own write",
	);
});

test("a confirmed boundary replace retires the endpoint's pending tick delta", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// A checked-boundary tick goes unsent while the backend is down.
	server.down = true;
	const r0 = await tick(first.store, "day-1-end", true);
	assert.notEqual(r0, "saved");
	assert.equal(
		first.store.localProgress.visitStatus["day-1-end"],
		true,
		"mirror still shows the unsent tick",
	);
	assert.ok(first.store._pendingDeltaList().length >= 1);

	// Confirmed replace of the same boundary — one atomic plan save that
	// also clears both implicit visit keys (mirrors saveEndpoint's call).
	server.down = false;
	const r1 = await first.store.save(
		function (d) {
			d.days[0].end = { placeId: "stay-rinkoso", label: "Rinkoso" };
			d.days[1].start = { placeId: "stay-rinkoso", label: "Rinkoso" };
		},
		{ clearVisitIds: ["day-1-end", "day-2-start"] },
	);
	assert.equal(r1, "saved");
	assert.equal(first.store.state, "saved");
	assert.equal(first.store.pendingDraft, null);
	assert.equal(first.store.hasUnsavedChanges(), false);
	// The superseded tick delta retired even though 'day-1-end' still names
	// a live occurrence — the replacement owns that boundary now.
	assert.equal(first.store._pendingDeltaList().length, 0);
	assert.equal(first.store.localProgress.visitStatus["day-1-end"], undefined);
	assert.equal(server.trip.visitStatus["day-1-end"], undefined);
	assert.equal(server.trip.days[0].end.placeId, "stay-rinkoso");
	assert.equal(server.trip.days[1].start.placeId, "stay-rinkoso");

	// A later merge can't resurrect the old tick under the new lodging.
	remoteWrite(server, (doc) => {
		doc.visitStatus["day1-s2"] = true;
	});
	const r2 = await tick(first.store, "day1-s1", true);
	assert.equal(r2, "saved");
	assert.equal(server.trip.visitStatus["day-1-end"], undefined);
	assert.equal(server.trip.visitStatus["day-2-start"], undefined);
	assert.equal(server.trip.days[0].end.placeId, "stay-rinkoso");
	assert.deepEqual(Object.keys(server.trip.visitStatus).sort(), [
		"day1-s1",
		"day1-s2",
	]);
});

test("a conflicting boundary replace keeps the cleared flags inside its draft", async () => {
	const local = new Map();
	const server = makeServer();
	const first = await newStore(server, local);

	// Same unsent checked-boundary tick, then a remote advance so the
	// endpoint save 409s — mixed work must surface the whole draft.
	server.down = true;
	await tick(first.store, "day-1-end", true);
	server.down = false;
	remoteWrite(server, (doc) => {
		doc.visitStatus["day2-s7"] = true;
	});
	const r1 = await first.store.save(
		function (d) {
			d.days[0].end = { placeId: "stay-rinkoso", label: "Rinkoso" };
			d.days[1].start = { placeId: "stay-rinkoso", label: "Rinkoso" };
		},
		{ clearVisitIds: ["day-1-end", "day-2-start"] },
	);
	assert.equal(r1, "conflict");
	assert.equal(first.store.state, "conflict");
	assert.equal(
		first.store.conflict.draft.days[0].end.placeId,
		"stay-rinkoso",
		"the plan edit survives inside the kept draft",
	);
	assert.equal(
		first.store.conflict.draft.visitStatus["day-1-end"],
		undefined,
		"the explicit clear stays cleared inside it",
	);
	// Keep-mine: the endpoint change AND the clear land; the superseded
	// tick never re-appears under the new destination.
	const r2 = await first.store.resolveConflictReapply();
	assert.equal(r2, "saved");
	assert.equal(server.trip.days[0].end.placeId, "stay-rinkoso");
	assert.equal(server.trip.visitStatus["day-1-end"], undefined);
	assert.equal(server.trip.visitStatus["day-2-start"], undefined);
	assert.equal(first.store._pendingDeltaList().length, 0);
	assert.equal(first.store.hasUnsavedChanges(), false);
});
