// Extraction tests for masthead-scene.js and device-pairing.js: the two
// self-contained modules the application controller wires at boot. Runs
// offline with fake DOM objects — no browser, no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert");

// Modules read browser globals off globalThis (window is undefined in Node).
function stubBrowserGlobals() {
	globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
	globalThis.addEventListener = () => {};
	globalThis.removeEventListener = () => {};
	delete globalThis.IntersectionObserver;
}
stubBrowserGlobals();

const Masthead = require("../../projects/biwa-ride/masthead-scene.js");
const Pairing = require("../../projects/biwa-ride/device-pairing.js");

// Minimal element double: records listeners, exposes the surface the
// modules touch (classList, style, attributes, query results).
function fakeEl(queryResults) {
	const listeners = {};
	return {
		listeners,
		hidden: true,
		textContent: "",
		value: "",
		disabled: false,
		style: { setProperty() {}, display: "", height: "" },
		dataset: {},
		classList: {
			toggled: [],
			toggle(name, force) {
				this.toggled.push([name, force]);
			},
		},
		addEventListener(type, fn) {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		setAttribute() {},
		appendChild() {},
		cloneNode() {
			return fakeEl({});
		},
		getBoundingClientRect() {
			return { width: 0 };
		},
		querySelector() {
			return null;
		},
		querySelectorAll(sel) {
			return (queryResults || {})[sel] || [];
		},
		showModal() {
			this.shown = true;
		},
		close() {
			this.closed = true;
		},
		click(type) {
			(listeners[type || "click"] || []).forEach((f) =>
				f({ target: this }),
			);
		},
	};
}

// --- masthead-scene -------------------------------------------------------------

test("masthead init tolerates a missing scene", () => {
	assert.equal(Masthead.init(null), null);
	assert.equal(Masthead.init(undefined), null);
});

test("masthead init boots, gates motion and is idempotent per element", () => {
	const scene = fakeEl({ ".biwa-scene-belt-half": [] });
	const handle = Masthead.init(scene);
	assert.ok(handle, "handle returned for a real scene");
	// applySceneMotion ran at boot: motion allowed → is-paused false.
	assert.deepEqual(scene.classList.toggled, [["is-paused", false]]);
	const again = Masthead.init(scene);
	assert.equal(again, handle, "re-init with the same element is a no-op");
	// A different element tears down and re-boots cleanly.
	const other = fakeEl({ ".biwa-scene-belt-half": [] });
	const otherHandle = Masthead.init(other);
	assert.notEqual(otherHandle, handle);
	Masthead.destroy();
});

test("masthead pauses the scene under reduced motion", () => {
	globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
	const scene = fakeEl({ ".biwa-scene-belt-half": [] });
	Masthead.init(scene);
	assert.deepEqual(scene.classList.toggled, [["is-paused", true]]);
	Masthead.destroy();
	stubBrowserGlobals();
});

// --- device-pairing -------------------------------------------------------------

function makePairing(overrides) {
	const elements = {
		open: fakeEl(),
		dialog: fakeEl(),
		show: fakeEl(),
		code: fakeEl(),
		codeNote: fakeEl(),
		input: fakeEl(),
		claim: fakeEl(),
		status: fakeEl(),
		close: fakeEl(),
	};
	const calls = { reload: 0, adopted: [], notified: [], blockReason: null };
	const store = Object.assign(
		{
			createPairCode: () => Promise.resolve({ ok: true, code: "ABCDEF" }),
			claimPairCode: () =>
				Promise.resolve({
					ok: true,
					ownerId: "dev:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				}),
			adoptOwner: (id) => {
				calls.adopted.push(id);
				return true;
			},
			getPairingBlockReason: () => calls.blockReason,
		},
		overrides || {},
	);
	const opts = {
		store,
		elements,
		translate: (k) => "T:" + k,
		reload: () => {
			calls.reload += 1;
		},
		notify: (m) => {
			calls.notified.push(m);
		},
	};
	return { elements, calls, opts, init: () => Pairing.init(opts) };
}

test("pairing init tolerates missing controls and missing options", () => {
	assert.equal(Pairing.init(null), null);
	assert.equal(Pairing.init({}), null);
	const store = { createPairCode() {}, claimPairCode() {} };
	assert.ok(
		Pairing.init({ store, elements: {} }),
		"empty element set still wires",
	);
});

test("pairing open/close drive the dialog", () => {
	const ctx = makePairing();
	ctx.init();
	ctx.elements.open.click();
	assert.equal(ctx.elements.dialog.shown, true);
	assert.equal(ctx.elements.status.textContent, "", "status cleared on open");
	ctx.elements.close.click();
	assert.equal(ctx.elements.dialog.closed, true);
});

test("pairing show mints and displays a spaced code", async () => {
	const ctx = makePairing();
	ctx.init();
	ctx.elements.show.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(ctx.elements.code.textContent, "A B C D E F");
	assert.equal(ctx.elements.code.hidden, false);
	assert.equal(ctx.elements.codeNote.hidden, false);
	assert.equal(ctx.elements.show.disabled, false, "button re-enabled");
});

test("pairing show reports failures without a code", async () => {
	// A non-network failure (server said no) keeps the generic create error;
	// transport-level failures map to the connection notice instead.
	const ctx = makePairing({
		createPairCode: () => Promise.resolve({ ok: false }),
	});
	ctx.init();
	ctx.elements.show.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /Could not create a code/);
	assert.equal(ctx.elements.code.textContent, "");
});

test("pairing claim validates length, then adopts the owner and reloads", async () => {
	const ctx = makePairing();
	ctx.init();
	ctx.elements.input.value = "bad";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /invalid or expired/);
	assert.equal(ctx.calls.reload, 0);

	ctx.elements.input.value = "abcdef";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(ctx.calls.adopted, [
		"dev:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	]);
	assert.equal(ctx.calls.reload, 1, "reboot under the adopted identity");
});

test("pairing claim failure stays put", async () => {
	const ctx = makePairing({
		claimPairCode: () =>
			Promise.resolve({ ok: false, error: "code_expired" }),
	});
	ctx.init();
	ctx.elements.input.value = "ZZZZZZ";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /invalid or expired/);
	assert.equal(ctx.calls.reload, 0);
});

// --- pairing guards (offline / unsaved / not-ready / storage) -------------------

test("blocked show announces once and never calls the store", async () => {
	let created = 0;
	const ctx = makePairing({
		createPairCode: () => {
			created += 1;
			return Promise.resolve({ ok: true, code: "ABCDEF" });
		},
	});
	ctx.calls.blockReason = "offline";
	ctx.init();
	ctx.elements.show.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(created, 0, "guarded before the network call");
	assert.equal(ctx.elements.show.disabled, false, "button never disabled");
	assert.match(ctx.elements.status.textContent, /No connection/);
	assert.deepEqual(ctx.calls.notified, [
		"T:No connection. Unable to pair devices. Your unsaved changes stay on this phone.",
	]);
});

test("blocked claim announces the reason — never an invalid-code message", async () => {
	let claimed = 0;
	const ctx = makePairing({
		claimPairCode: () => {
			claimed += 1;
			return Promise.resolve({ ok: true, ownerId: "dev:x" });
		},
	});
	ctx.calls.blockReason = "unsaved_changes";
	ctx.init();
	ctx.elements.input.value = "ABCDEF";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(claimed, 0);
	assert.match(ctx.elements.status.textContent, /not saved online yet/);
	assert.equal(ctx.calls.notified.length, 1);
});

test("an unsaved edit arriving during the claim flight blocks adoption", async () => {
	// The claim returns a valid owner id, but the device gained unsent work
	// while the response was in flight — adopt must be refused, not reloaded.
	const ctx = makePairing();
	// Reason is null at click time, then 'unsaved_changes' when the
	// response lands.
	let phase = "clean";
	ctx.opts.store.getPairingBlockReason = () =>
		phase === "clean" ? null : "unsaved_changes";
	ctx.init();
	ctx.elements.input.value = "ABCDEF";
	ctx.elements.claim.click();
	phase = "dirty";
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(ctx.calls.adopted, [], "adoptOwner never called");
	assert.equal(ctx.calls.reload, 0);
	assert.match(ctx.elements.status.textContent, /not saved online yet/);
	assert.equal(ctx.calls.notified.length, 1);
});

test("a refused adoptOwner reports the storage reason, not an invalid code", async () => {
	const ctx = makePairing({
		adoptOwner: () => false,
	});
	ctx.init();
	ctx.elements.input.value = "ABCDEF";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /cannot safely store/);
	assert.equal(ctx.calls.reload, 0);
});

test("dialog open previews a known block reason without toasting", () => {
	const ctx = makePairing();
	ctx.calls.blockReason = "not_ready";
	ctx.init();
	ctx.elements.open.click();
	assert.equal(ctx.elements.dialog.shown, true);
	assert.match(ctx.elements.status.textContent, /finish loading/);
	assert.equal(
		ctx.calls.notified.length,
		0,
		"open is quiet — attempts notify",
	);
});

test("an offline claim with an empty input gets the offline notice, not invalid", async () => {
	let claimed = 0;
	const ctx = makePairing({
		claimPairCode: () => {
			claimed += 1;
			return Promise.resolve({ ok: false });
		},
	});
	ctx.calls.blockReason = "offline";
	ctx.init();
	// Empty input — the guard runs BEFORE the length check.
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(claimed, 0, "never reached the wire");
	assert.match(ctx.elements.status.textContent, /No connection/);
	assert.doesNotMatch(ctx.elements.status.textContent, /invalid or expired/);
});

test("a rate-limited answer gets its own message, not invalid code", async () => {
	const ctx = makePairing({
		claimPairCode: () =>
			Promise.resolve({ ok: false, error: "rate_limited" }),
	});
	ctx.init();
	ctx.elements.input.value = "ABCDEF";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /Too many pairing attempts/);
	assert.doesNotMatch(ctx.elements.status.textContent, /invalid or expired/);
	assert.equal(ctx.calls.notified.length, 1);
});

test("an unknown claim error is honest generic failure, not invalid code", async () => {
	const ctx = makePairing({
		claimPairCode: () => Promise.resolve({ ok: false, error: "upstream" }),
	});
	ctx.init();
	ctx.elements.input.value = "ABCDEF";
	ctx.elements.claim.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.match(ctx.elements.status.textContent, /Unable to pair right now/);
	assert.doesNotMatch(ctx.elements.status.textContent, /invalid or expired/);
});

test("index.html loads the modules before the application controller", () => {
	const fs = require("fs");
	const path = require("path");
	const html = fs.readFileSync(
		path.join(__dirname, "../../projects/biwa-ride/index.html"),
		"utf8",
	);
	for (const src of [
		"masthead-scene.js",
		"device-pairing.js",
		"offline-cache.js",
		"mini-checkin.js",
	]) {
		const at = html.indexOf('src="' + src + '"');
		assert.ok(at > -1, src + " is linked");
		assert.ok(
			at < html.indexOf('src="biwa-ride.js"'),
			src + " loads before the controller",
		);
	}
});
