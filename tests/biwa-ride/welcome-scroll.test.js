// welcome-scroll.test.js — the welcome-back scroll helper extracted
// verbatim from biwa-ride.js between the WELCOME_SCROLL markers and run in
// a VM sandbox with fake DOM/window/storage. No browser, no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "../../projects/biwa-ride/biwa-ride.js");

function extract() {
	const src = fs.readFileSync(SRC, "utf8");
	const m = src.match(
		/\/\/ WELCOME_SCROLL_BEGIN[\s\S]*?\/\/ WELCOME_SCROLL_END/,
	);
	assert.ok(m, "WELCOME_SCROLL markers present in biwa-ride.js");
	return m[0];
}

// A fresh fake world per test — clock, storage, DOM queries and listeners
// are all driven explicitly.
function world(opts) {
	opts = opts || {};
	let T = opts.now || 1_000_000;
	const state = {
		T,
		storage: {},
		throwStorage: !!opts.throwStorage,
		scrollToCalls: [],
		raf: [],
		visibilityState: "visible",
		reducedMotion: !!opts.reducedMotion,
		sheetOpen: false,
		editorActive: false,
		miniActive: false,
		touchDrag: null,
	};
	const sel = {};
	// Live-target card — the test controls its rect per scenario.
	const card = {
		rect: opts.cardRect || { top: 1200, height: 120 },
		hidden: false,
		getBoundingClientRect() {
			return this.rect;
		},
	};
	sel['.biwa-track-row[data-current="true"] .biwa-stop-card'] = opts.noCard
		? null
		: card;
	sel["dialog[open]"] = opts.dialogOpen ? { open: true } : null;
	sel["[data-dragging]"] = opts.dragging ? {} : null;
	// opts.nav supplies a visible bottom nav/sidebar stub — _pos drives the
	// position the fake getComputedStyle reports (mobile fixed vs desktop
	// sticky sidebar).
	sel[".biwa-nav"] = opts.nav || null;
	state.timeline = {
		classList: { contains: (c) => opts.onTimeline !== false },
	};
	sel["view-timeline"] = state.timeline;

	const document_ = {
		visibilityState: state.visibilityState,
		_listeners: {},
		addEventListener(t, f) {
			(this._listeners[t] = this._listeners[t] || []).push(f);
		},
		querySelector(s) {
			return sel[s] || null;
		},
		getElementById(id) {
			return sel[id] || null;
		},
	};
	const window_ = {
		innerHeight: 800,
		scrollY: opts.scrollY || 0,
		scrollTo(o) {
			state.scrollToCalls.push(o);
			this.scrollY = o.top;
		},
		getComputedStyle(el) {
			return {
				display: el && el._hidden ? "none" : "block",
				position: (el && el._pos) || "static",
			};
		},
		_listeners: {},
		addEventListener(t, f) {
			(this._listeners[t] = this._listeners[t] || []).push(f);
		},
	};
	const localStorage_ = {
		getItem(k) {
			if (state.throwStorage) throw new Error("denied");
			return k in state.storage ? state.storage[k] : null;
		},
		setItem(k, v) {
			if (state.throwStorage) throw new Error("denied");
			state.storage[k] = v;
		},
	};
	state.els = { "biwa-mini-bar": null };
	const sandbox = {
		document: document_,
		window: window_,
		localStorage: localStorage_,
		requestAnimationFrame: (f) => state.raf.push(f),
		Date: { now: () => T },
		Number,
		Math,
		els: state.els,
		store: {
			get editorActive() {
				return state.editorActive;
			},
		},
		isSheetOpen: () => state.sheetOpen,
		prefersReducedMotion: () => state.reducedMotion,
		miniCheckin: { isActive: () => state.miniActive },
	};
	Object.defineProperty(sandbox, "touchDrag", {
		get: () => state.touchDrag,
	});
	vm.createContext(sandbox);
	state.api = vm.runInContext(extract() + "\n; welcomeBack", sandbox);
	state.advance = (ms) => {
		T += ms;
	};
	state.fire = (target, type) => {
		document_.visibilityState = state.visibilityState;
		const map =
			target === "window" ? window_._listeners : document_._listeners;
		(map[type] || []).forEach((f) => f({}));
	};
	state.input = () => state.fire("window", "keydown");
	state.flush = () => state.raf.splice(0).forEach((f) => f());
	state.stamp = () =>
		state.storage["biwa:v2:last-active-at"]
			? Number(state.storage["biwa:v2:last-active-at"])
			: null;
	state.card = card;
	return state;
}

const AWAY = 5 * 60 * 1000;

test("first visit scrolls the current row's card to the top margin", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	assert.equal(s.raf.length, 1, "one frame scheduled");
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
	assert.equal(s.scrollToCalls[0].top, 1200 - 16);
	assert.equal(s.scrollToCalls[0].behavior, "smooth");
});

test("a stamp younger than 5 min preserves position (quick reload/tab)", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.storage["biwa:v2:last-active-at"] = String(s.T - (AWAY - 1));
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("exactly 5 min away counts as a return — scrolls once", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.storage["biwa:v2:last-active-at"] = String(s.T - AWAY);
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
});

test("pending attempts do not schedule until boot is ready", () => {
	const s = world();
	s.api.init();
	s.api.maybe();
	assert.equal(s.raf.length, 0);
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
});

test("a visible tab for >5 min never re-arms by itself", () => {
	const s = world();
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
	// Six quiet minutes pass, then a poll-render — nothing re-scrolls.
	s.advance(AWAY + 60000);
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
});

test("return after >=5 min away via visibility scrolls once; duplicates stay quiet", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	// A recent stamp keeps the BOOT quiet — the return path is what fires.
	s.storage["biwa:v2:last-active-at"] = String(s.T - 60 * 1000);
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
	s.visibilityState = "hidden";
	s.fire("document", "visibilitychange");
	s.advance(AWAY + 1);
	s.visibilityState = "visible";
	s.fire("document", "visibilitychange");
	s.flush();
	assert.equal(s.scrollToCalls.length, 1, "resume scheduled the scroll");
	// Duplicate focus/pageshow resumes must not re-arm a second scroll.
	s.fire("window", "focus");
	s.fire("window", "pageshow");
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
});

test("a quick hide/show under 5 min does not scroll", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.storage["biwa:v2:last-active-at"] = String(s.T - 60 * 1000);
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	s.visibilityState = "hidden";
	s.fire("document", "visibilitychange");
	s.advance(60 * 1000);
	s.visibilityState = "visible";
	s.fire("document", "visibilitychange");
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("a duplicate departure does not move the away stamp", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.storage["biwa:v2:last-active-at"] = String(s.T - 60 * 1000);
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	s.fire("window", "pagehide"); // departs at T
	s.advance(4 * 60 * 1000);
	s.fire("window", "pagehide"); // duplicate — must NOT reset awayAt
	s.advance(2 * 60 * 1000); // total absence 6 min
	s.fire("window", "pageshow");
	s.flush();
	assert.equal(s.scrollToCalls.length, 1, "age measured from the real exit");
});

test("user input before the frame cancels the pending scroll", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	assert.equal(s.raf.length, 1);
	s.input(); // keydown before the frame runs
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
	// And it stays cancelled — later renders never re-arm it.
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("storage that throws still tracks in memory without exceptions", () => {
	const s = world({
		throwStorage: true,
		cardRect: { top: 1200, height: 120 },
	});
	assert.doesNotThrow(() => s.api.init());
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	// No stamp = treated as a first visit — still eligible.
	assert.equal(s.scrollToCalls.length, 1);
	s.visibilityState = "hidden";
	s.fire("document", "visibilitychange");
	s.advance(AWAY + 1);
	s.visibilityState = "visible";
	s.fire("document", "visibilitychange");
	s.flush();
	assert.equal(s.scrollToCalls.length, 2, "in-memory away still works");
});

test("map view consumes the attempt without scrolling", () => {
	const s = world({
		onTimeline: false,
		cardRect: { top: 1200, height: 120 },
	});
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("an open dialog, sheet, editor, drag or mini check-in consumes the attempt", () => {
	// Each blocker in isolation.
	[
		(s) => {
			s.sheetOpen = true;
		},
		(s) => {
			s.editorActive = true;
		},
		(s) => {
			s.miniActive = true;
		},
		(s) => {
			s.touchDrag = {};
		},
	].forEach((apply) => {
		const s = world({ cardRect: { top: 1200, height: 120 } });
		apply(s);
		s.api.init();
		s.api.markBootReady();
		s.api.maybe();
		s.flush();
		assert.equal(s.scrollToCalls.length, 0);
	});
	// Dialog case needs the query stub present before init.
	const s = world({ dialogOpen: true, cardRect: { top: 1200, height: 120 } });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("no current row consumes the attempt quietly", () => {
	const s = world({ noCard: true });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
});

test("already-visible card is a no-op; one tucked under the mini bar scrolls", () => {
	// Card fully inside the safe band → visible.
	const s = world({ cardRect: { top: 100, height: 120 } });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
	// Same card but its bottom sits under a visible mini bar → scrolls.
	const s2 = world({ cardRect: { top: 600, height: 120 } });
	s2.els["biwa-mini-bar"] = {
		hidden: false,
		getBoundingClientRect: () => ({ top: 700 }),
	};
	s2.api.init();
	s2.api.markBootReady();
	s2.api.maybe();
	s2.flush();
	assert.equal(s2.scrollToCalls.length, 1);
});

test("a desktop sticky sidebar nav never clamps the visible check", () => {
	// Card fully inside the viewport, sidebar nav shown sticky (desktop) —
	// its top edge is not the viewport bottom, so no scroll.
	const s = world({
		cardRect: { top: 100, height: 120 },
		nav: {
			hidden: false,
			_pos: "sticky",
			getBoundingClientRect: () => ({ top: 300 }),
		},
	});
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
	// Same geometry but a FIXED nav (mobile bottom bar) — the card's bottom
	// sits under it, so the scroll does fire.
	const s2 = world({
		cardRect: { top: 600, height: 120 },
		nav: {
			hidden: false,
			_pos: "fixed",
			getBoundingClientRect: () => ({ top: 700 }),
		},
	});
	s2.api.init();
	s2.api.markBootReady();
	s2.api.maybe();
	s2.flush();
	assert.equal(s2.scrollToCalls.length, 1);
});

test("a focus/pageshow while still hidden keeps the away stamp for the visible return", () => {
	const s = world({ cardRect: { top: 1200, height: 120 } });
	s.storage["biwa:v2:last-active-at"] = String(s.T - 60 * 1000);
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 0);
	// Depart, age past the window, then a stray focus lands while the
	// document is STILL hidden — it must not consume the absence.
	s.visibilityState = "hidden";
	s.fire("document", "visibilitychange");
	s.advance(AWAY + 1);
	s.fire("window", "focus");
	s.flush();
	assert.equal(s.scrollToCalls.length, 0, "hidden focus never arms");
	// The genuine visible event now arms — exactly once.
	s.visibilityState = "visible";
	s.fire("document", "visibilitychange");
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
	s.fire("window", "focus");
	s.flush();
	assert.equal(s.scrollToCalls.length, 1, "duplicate focus stays quiet");
});

test("reduced motion uses an instant jump", () => {
	const s = world({
		reducedMotion: true,
		cardRect: { top: 1200, height: 120 },
	});
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls[0].behavior, "instant");
});

test("the scroll target clamps at zero for a near-top card", () => {
	const s = world({ cardRect: { top: 5, height: 120 } });
	s.api.init();
	s.api.markBootReady();
	s.api.maybe();
	s.flush();
	assert.equal(s.scrollToCalls.length, 1);
	assert.equal(s.scrollToCalls[0].top, 0);
});
