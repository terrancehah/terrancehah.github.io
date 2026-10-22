// mini-checkin.test.js — the check-in button's staged feedback
// lifecycle, driven with a fake button and a deterministic fake clock
// (no DOM, no wall time).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const MiniCheckin = require("../../projects/biwa-ride/mini-checkin.js");

const T = MiniCheckin.TIMINGS; // {TEXT_EXIT_MS, DRAW_MS, HOLD_MS, RESTORE_MS}

// Fake <button> + inner label/tick: only the surface the module touches
// — classList, disabled, attributes, getBoundingClientRect, querySelector.
function fakeEl() {
	const attrs = {};
	return {
		setAttribute: (k, v) => {
			attrs[k] = String(v);
		},
		getAttribute: (k) => (k in attrs ? attrs[k] : null),
		removeAttribute: (k) => {
			delete attrs[k];
		},
		hasAttribute: (k) => k in attrs,
		getBoundingClientRect: () => ({}),
	};
}
function fakeButton() {
	const classes = new Set();
	const attrs = {};
	const label = Object.assign(fakeEl(), { textContent: "Mark as Completed" });
	const tick = fakeEl();
	tick.setAttribute("hidden", ""); // the markup ships the tick hidden
	return {
		label,
		tick,
		disabled: false,
		classList: {
			add: (c) => classes.add(c),
			remove: (c) => classes.delete(c),
			contains: (c) => classes.has(c),
		},
		setAttribute: (k, v) => {
			attrs[k] = String(v);
		},
		getAttribute: (k) => (k in attrs ? attrs[k] : null),
		removeAttribute: (k) => {
			delete attrs[k];
		},
		hasAttribute: (k) => k in attrs,
		querySelector: (sel) =>
			sel === ".biwa-mini-complete-label"
				? label
				: sel === ".biwa-mini-complete-tick"
					? tick
					: null,
	};
}

// Deterministic clock — advance(ms) fires every timer due inside the
// window, including timers those callbacks schedule, in order.
function fakeClock() {
	let now = 0;
	const q = [];
	return {
		setTimeout: (fn, ms) => {
			const t = { fn, at: now + ms };
			q.push(t);
			return t;
		},
		clearTimeout: (id) => {
			const i = q.indexOf(id);
			if (i >= 0) q.splice(i, 1);
		},
		advance: (ms) => {
			const end = now + ms;
			for (;;) {
				q.sort((a, b) => a.at - b.at);
				if (!q.length || q[0].at > end) break;
				now = q[0].at;
				q.shift().fn();
			}
			now = end;
		},
		pending: () => q.length,
	};
}

function rig(overrides) {
	const button = fakeButton();
	const clock = fakeClock();
	const released = [];
	const mc = MiniCheckin.create(
		Object.assign(
			{
				button,
				translate: (s, vars) =>
					s.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k]) || m),
				onRelease: () => released.push(true),
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
				prefersReducedMotion: false,
			},
			overrides || {},
		),
	);
	return { button, clock, released, mc };
}

const phase = (b) =>
	["is-saving", "is-text-exiting", "is-checked", "is-restoring"].filter((c) =>
		b.classList.contains(c),
	);

test('begin keeps the visible "Mark as Completed" text and locks + busies the button', () => {
	const { button, mc } = rig();
	const token = mc.begin({ name: "Hikone Castle" });
	assert.equal(typeof token, "number");
	assert.equal(mc.isActive(), true);
	assert.equal(button.disabled, true, "locked while saving");
	assert.equal(button.getAttribute("aria-busy"), "true");
	assert.deepEqual(phase(button), ["is-saving"]);
	assert.equal(
		button.tick.hasAttribute("hidden"),
		true,
		"text-only: the tick is display:none while saving",
	);
	assert.equal(button.label.hasAttribute("hidden"), false);
	assert.equal(
		button.label.textContent,
		"Mark as Completed",
		"the visible text stays Mark as Completed — not Saving…",
	);
	assert.equal(
		button.getAttribute("aria-label"),
		"Marking Hikone Castle as completed",
		"only aria reports the write",
	);
});

test("saved settles through the staged sequence, then releases once", () => {
	const { button, clock, released, mc } = rig();
	const token = mc.begin({ name: "Hikone Castle" });
	mc.settle(token, "saved", false);
	assert.deepEqual(
		phase(button),
		["is-text-exiting"],
		"ack lifts the text away first",
	);
	assert.equal(button.getAttribute("aria-busy"), null, "busy cleared");
	assert.equal(button.disabled, true, "still locked");

	clock.advance(T.TEXT_EXIT_MS);
	assert.deepEqual(phase(button), ["is-checked"], "tick drawing phase");
	assert.equal(
		button.getAttribute("aria-label"),
		"Completed Hikone Castle",
	);
	assert.equal(released.length, 0, "no release while the tick draws");

	clock.advance(T.DRAW_MS + T.HOLD_MS - 1);
	assert.deepEqual(phase(button), ["is-checked"], "still holding the tick");
	clock.advance(1);
	assert.deepEqual(phase(button), ["is-restoring"], "text restoring");
	assert.equal(
		button.getAttribute("aria-label"),
		"Mark Hikone Castle as completed",
		"the accessible label restores with the face",
	);
	assert.equal(released.length, 0, "the bar still shows the old stop");
	assert.equal(mc.isActive(), true);

	clock.advance(T.RESTORE_MS);
	assert.equal(mc.isActive(), false);
	assert.deepEqual(phase(button), [], "back to the idle face");
	assert.equal(button.disabled, false);
	assert.equal(button.label.textContent, "Mark as Completed");
	assert.equal(
		button.getAttribute("aria-label"),
		null,
		"idle leaves the label for the re-render to paint",
	);
	assert.equal(released.length, 1, "caller re-renders exactly once");
});

test("'local' succeeds only with a provably durable mirror", () => {
	let { button, mc } = rig();
	let token = mc.begin({ name: "A" });
	mc.settle(token, "local", true);
	assert.deepEqual(
		phase(button),
		["is-text-exiting"],
		"durable local stages the tick",
	);

	const r2 = rig();
	token = r2.mc.begin({ name: "A" });
	r2.mc.settle(token, "local", false);
	assert.deepEqual(
		phase(r2.button),
		[],
		"an undurable buffer never shows green",
	);
	assert.equal(r2.mc.isActive(), false, "reset immediately");
	assert.equal(r2.released.length, 1, "still repaints the bar");
});

test("error, unavailable and conflict reset with no green tick", () => {
	for (const result of ["error", "unavailable", "conflict"]) {
		const { button, released, mc } = rig();
		const token = mc.begin({ name: "A" });
		mc.settle(token, result, true);
		assert.deepEqual(phase(button), [], result + " shows no phase face");
		assert.equal(
			button.tick.hasAttribute("hidden"),
			true,
			result + " never reveals the tick",
		);
		assert.equal(mc.isActive(), false, result + " released immediately");
		assert.equal(button.disabled, false);
		assert.equal(button.label.textContent, "Mark as Completed");
		assert.equal(released.length, 1, result + " repaints once");
	}
});

test("a duplicate settle after staging began is ignored", () => {
	const { button, clock, released, mc } = rig();
	const token = mc.begin({ name: "A" });
	mc.settle(token, "saved", false);
	mc.settle(token, "saved", false); // same token, but phase moved on
	mc.settle(token, "error", true); // late errors can't abort the tick
	clock.advance(T.TEXT_EXIT_MS);
	assert.deepEqual(phase(button), ["is-checked"], "the staging still ran");
	clock.advance(T.DRAW_MS + T.HOLD_MS + T.RESTORE_MS);
	assert.equal(released.length, 1, "released exactly once");
});

test("a stale token is ignored — no tick on the wrong episode", () => {
	const { button, mc } = rig();
	const dead = mc.begin({ name: "Old stop" });
	mc.cancel(); // e.g. the day switched mid-flight
	const live = mc.begin({ name: "New day stop" });
	mc.settle(dead, "saved", false); // the old write finally resolves
	assert.equal(mc.isActive(), true, "the live episode is untouched");
	assert.deepEqual(
		phase(button),
		["is-saving"],
		"the dead episode cannot flash its tick",
	);
	mc.settle(live, "saved", false);
	assert.deepEqual(
		phase(button),
		["is-text-exiting"],
		"only the live episode stages",
	);
});

test("a second begin while active is a no-op", () => {
	const { mc } = rig();
	const first = mc.begin({ name: "A" });
	const second = mc.begin({ name: "B" });
	assert.equal(second, null, "double-tap cannot re-enter");
	mc.settle(first, "saved", false);
	assert.equal(mc.isActive(), true);
});

test("cancel in EVERY phase prevents late visuals and releases", () => {
	// Each tuple: ms to advance into the staged sequence before cancel.
	for (const [label, lead] of [
		["saving", 0],
		["text-exit", T.TEXT_EXIT_MS - 1],
		["checked/drawing", T.TEXT_EXIT_MS + 1],
		["checked/holding", T.TEXT_EXIT_MS + T.DRAW_MS + T.HOLD_MS - 1],
		["restoring", T.TEXT_EXIT_MS + T.DRAW_MS + T.HOLD_MS + 1],
	]) {
		const { button, clock, released, mc } = rig();
		const token = mc.begin({ name: "A" });
		mc.settle(token, "saved", false);
		clock.advance(lead);
		mc.cancel();
		assert.equal(mc.isActive(), false, label);
		assert.deepEqual(phase(button), [], label + " — face reset");
		assert.equal(button.disabled, false, label);
		// Any timers the cancelled episode armed must be dead — draining
		// the rest of the sequence can produce no visuals or release.
		clock.advance(T.TEXT_EXIT_MS + T.DRAW_MS + T.HOLD_MS + T.RESTORE_MS);
		assert.equal(released.length, 0, label + " — no late release");
		assert.deepEqual(phase(button), [], label + " — no late paint");
	}
});

test("reduced motion shows a static tick for the hold, then idles", () => {
	const { button, clock, released, mc } = rig({ prefersReducedMotion: true });
	const token = mc.begin({ name: "A" });
	mc.settle(token, "saved", false);
	assert.deepEqual(
		phase(button),
		["is-checked"],
		"the tick appears instantly — no text-exit stage",
	);
	assert.equal(button.getAttribute("aria-label"), "Completed A");
	clock.advance(T.HOLD_MS - 1);
	assert.deepEqual(phase(button), ["is-checked"], "held statically");
	clock.advance(1);
	assert.equal(mc.isActive(), false);
	assert.deepEqual(phase(button), [], "straight back to idle, no restoring");
	assert.equal(button.label.textContent, "Mark as Completed");
	assert.equal(released.length, 1);
});

test("prefersReducedMotion accepts a function seam evaluated at settle", () => {
	let reduced = false;
	const { button, clock, released, mc } = rig({
		prefersReducedMotion: () => reduced,
	});
	const token = mc.begin({ name: "A" });
	reduced = true; // preference flips between tap and ack — settle honours it
	mc.settle(token, "saved", false);
	assert.deepEqual(phase(button), ["is-checked"], "static path taken");
	clock.advance(T.HOLD_MS);
	assert.equal(released.length, 1);
});

test("CSS stages text-exit / drawn-tick / restoring + concentric radius", () => {
	const css = fs.readFileSync(
		path.join(__dirname, "../../projects/biwa-ride/biwa-ride.css"),
		"utf8",
	);
	// The concentric inset radius on mini actions only.
	assert.ok(
		/\.biwa-mini-directions,[\s\S]*?\.biwa-mini-complete[\s\S]*?border-radius:\s*calc\(var\(--biwa-radius-md\)\s*-\s*var\(--biwa-space-sm\)\)/.test(
			css,
		),
		"mini actions use the concentric 6px radius",
	);
	// The drawn tick: unit path, dashoffset 1 -> 0 under .is-checked.
	assert.ok(
		/biwa-mini-checkmark[\s\S]*?stroke-dasharray:\s*1/.test(css),
		"the checkmark stroke is a unit dasharray",
	);
	assert.ok(
		/is-checked[\s\S]*?biwa-mini-checkmark[\s\S]*?stroke-dashoffset:\s*0/.test(
			css,
		),
		"the tick draws under is-checked",
	);
	// The ack face is the completed WASH with the green token stroke —
	// not a solid success button.
	assert.ok(
		/is-checked[^{]*\{[\s\S]*?background:\s*var\(--biwa-wash-completed\)[\s\S]*?color:\s*var\(--biwa-success\)/.test(
			css,
		),
		"checked face is green-on-wash",
	);
	// The styled phases are scoped under .biwa-mini-bar (is-restoring is
	// a JS marker only — the label's base transition fades it back).
	for (const cls of ["is-text-exiting", "is-checked"]) {
		assert.ok(
			css.includes(".biwa-mini-bar .biwa-mini-complete." + cls),
			cls + " is scoped under the mini bar",
		);
	}
	// Structural exclusivity: the tick is display:none outside the ack
	// face and the label display:none inside it — never opacity-only.
	assert.ok(
		/biwa-mini-complete-tick\[hidden\][\s\S]*?biwa-mini-complete-label\[hidden\][\s\S]*?display:\s*none/.test(
			css,
		),
		"[hidden] gates both faces to display:none",
	);
	// Reduced motion removes every mini transition — static faces only.
	assert.ok(
		/prefers-reduced-motion:\s*reduce[\s\S]*?biwa-mini-checkmark[\s\S]*?transition:\s*none/.test(
			css,
		),
		"reduced motion drops every phase transition",
	);
	// The override must be scoped to the phase machine — bare
	// .biwa-mini-checkmark loses specificity to the (0,4,0) is-checked
	// dashoffset rule and the tick would still animate under reduce.
	const mediaBlock =
		css.match(
			/prefers-reduced-motion:\s*reduce[\s\S]*?transition:\s*none;[\s\S]*?\}/g,
		) || [];
	assert.ok(
		mediaBlock.some((b) =>
			/\.biwa-mini-bar\s+\.biwa-mini-complete[^\{]*biwa-mini-checkmark/.test(
				b,
			),
		),
		"media override is scoped under .biwa-mini-bar .biwa-mini-complete phases",
	);
});

test("mini icons are verbatim Tabler upstream — route + check + license", () => {
	const html = fs.readFileSync(
		path.join(__dirname, "../../projects/biwa-ride/index.html"),
		"utf8",
	);
	// Navigate: Tabler Icons "route" — three exact upstream paths, no
	// hand-drawn endpoints, letters or dotted geometry may ever return.
	const dir = html.match(
		/id="biwa-mini-directions"[\s\S]*?<svg[\s\S]*?<\/svg>/,
	)[0];
	const dirPaths = [...dir.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(
		(m) => m[1],
	);
	assert.deepEqual(
		dirPaths,
		[
			"M3 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0",
			"M19 7a2 2 0 1 0 0 -4a2 2 0 0 0 0 4",
			"M11 19h5.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h4.5",
		],
		"navigate uses the exact upstream route geometry",
	);
	assert.ok(!/<text[\s>]/.test(dir), "no hand-drawn endpoint letters");
	assert.ok(!/<circle[\s>]/.test(dir), "no hand-drawn endpoint circles");
	assert.ok(dir.includes('stroke-width="2"'), "upstream stroke weight");
	assert.ok(
		dir.includes('aria-hidden="true"'),
		"decorative svg stays hidden — the anchor's label owns the name",
	);

	// Success tick: Tabler Icons "check" — the exact upstream path, kept
	// drawable via pathLength + the phase class.
	const tick = html.match(/biwa-mini-complete-tick[\s\S]*?<\/svg>/)[0];
	const tickPaths = [...tick.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(
		(m) => m[1],
	);
	assert.deepEqual(
		tickPaths,
		["M5 12l5 5l10 -10"],
		"the tick uses the exact upstream check geometry",
	);
	assert.ok(tick.includes('pathLength="1"'), "unit path for the draw");
	assert.ok(tick.includes('stroke-width="2"'), "upstream stroke weight");
	assert.ok(
		/\shidden[\s>]/.test(tick),
		"the markup ships the tick hidden — text is the only idle face",
	);

	// Provenance: the source comment names the library and the verbatim
	// upstream MIT license ships in assets/.
	assert.ok(/tabler-icons/i.test(html), "source comment credits Tabler");
	const license = fs.readFileSync(
		path.join(
			__dirname,
			"../../projects/biwa-ride/assets/tabler-icons-license.txt",
		),
		"utf8",
	);
	assert.ok(
		/MIT License/.test(license) && /Paweł Kuna/.test(license),
		"upstream MIT license ships verbatim",
	);
});
