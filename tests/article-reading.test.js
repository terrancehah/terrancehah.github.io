/* Deterministic offline test for js/article-reading.js.
   Runs the real script inside node:vm against a mocked window/document
   — no browser, no DOM library. Asserts the math (0 before the
   article, 0.5 midway, 1 at its end, clamped on overscroll, short-
   article cases), the duplicate-init guard, rAF coalescing, and every
   re-measure trigger (img load/error capture, fonts.ready,
   ResizeObserver, pageshow).

   Run:  node tests/article-reading.test.js   (from repo root)
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
	path.join(__dirname, "..", "js", "article-reading.js"),
	"utf8",
);

/* --- tiny DOM/browser mock ------------------------------------------- */
function makeEl(tag) {
	return {
		tagName: tag.toUpperCase(),
		className: "",
		children: [],
		style: {},
		attrs: {},
		appendChild(c) {
			this.children.push(c);
		},
		setAttribute(k, v) {
			this.attrs[k] = v;
		},
	};
}

function makeWorld(opts) {
	const opts0 = opts || {};
	const winListeners = {};
	const docListeners = {};
	const rafQueue = [];
	const created = []; // elements appended to body
	const article = opts0.hasArticle === false ? null : makeEl("article");
	if (article) {
		article.className = "article-content";
		article._rect = opts0.rect || {
			top: 0,
			height: 3000,
			bottom: 3000,
		};
		article.getBoundingClientRect = function () {
			return article._rect;
		};
	}
	/* non-article pages opt in via [data-reading-progress]; pass a rect
	   to simulate a marked <main> */
	const readingTarget = opts0.readingTarget ? makeEl("main") : null;
	if (readingTarget) {
		readingTarget._rect = opts0.readingTarget;
		readingTarget.getBoundingClientRect = function () {
			return readingTarget._rect;
		};
	}

	const document = {
		readyState: opts0.readyState || "complete",
		body: { appendChild: (el) => created.push(el) },
		createElement: (t) => makeEl(t),
		querySelector: (sel) => {
			if (sel === ".article-content") return article;
			if (sel === "[data-reading-progress]") return readingTarget;
			if (sel === ".article-reading-progress") {
				return (
					created.find(
						(e) => e.className === "article-reading-progress",
					) || (opts0.preexistingBar ? preexistingBar : null)
				);
			}
			return null;
		},
		addEventListener: (t, fn, cap) => {
			(docListeners[t] = docListeners[t] || []).push({ fn, cap });
		},
		fonts:
			opts0.fonts === false
				? undefined
				: { ready: { then: (fn) => (world.fontsReady = fn) } },
	};
	const preexistingBar = makeEl("div");
	preexistingBar.className = "article-reading-progress";

	const world = {
		window: {
			innerHeight: opts0.innerHeight || 800,
			addEventListener: (t, fn, o) => {
				(winListeners[t] = winListeners[t] || []).push(fn);
			},
			requestAnimationFrame: (fn) => rafQueue.push(fn),
			ResizeObserver:
				opts0.ro === false
					? undefined
					: function (cb) {
							world.roCallback = cb;
							return { observe: (el) => (world.roTarget = el) };
						},
		},
		document,
		console,
	};
	world.created = created;
	world.article = article;
	world.readingTarget = readingTarget;
	world.winListeners = winListeners;
	world.docListeners = docListeners;
	world.fireWin = (t) => (winListeners[t] || []).forEach((f) => f());
	world.fireDoc = (t, target) =>
		(docListeners[t] || []).forEach((l) => l.fn({ target }));
	world.flushRaf = () => {
		const q = rafQueue.splice(0);
		q.forEach((f) => f());
	};
	world.fill = () =>
		created.find((e) => e.className === "article-reading-progress")
			?.children[0];
	world.scale = () => {
		const t = world.fill()?.style.transform || "";
		const m = t.match(/scaleX\(([\d.]+)\)/);
		return m ? parseFloat(m[1]) : null;
	};
	return world;
}

function load(world) {
	vm.createContext(world);
	vm.runInContext(SRC, world);
}

let pass = 0;
function check(name, cond) {
	assert.ok(cond, name);
	pass++;
}

/* --- tests ------------------------------------------------------------ */

// happy path: element created with aria-hidden, fill is a child span
{
	const w = makeWorld({ rect: { top: -1600, height: 3000, bottom: 1400 } });
	load(w);
	const bar = w.created.find(
		(e) => e.className === "article-reading-progress",
	);
	check("bar element created", !!bar);
	check("bar is aria-hidden decorative", bar.attrs["aria-hidden"] === "true");
	check("fill child exists", !!w.fill());
	check("no transform before first frame", w.scale() === null);
	w.flushRaf();
	// innerHeight 800, range 2200, -top = 1600 → 0.7273
	check("mid ratio", Math.abs(w.scale() - 1600 / 2200) < 1e-6);
}

// above the article: top > 0 → 0
{
	const w = makeWorld({ rect: { top: 500, height: 3000, bottom: 3500 } });
	load(w);
	w.flushRaf();
	check("above article = 0", w.scale() === 0);
}

// exact end: last article pixel at viewport bottom → 1
{
	const w = makeWorld({ rect: { top: -2200, height: 3000, bottom: 800 } });
	load(w);
	w.flushRaf();
	check("article end = 1", w.scale() === 1);
}

// scrolled into the footer past the article → stays 1 (clamped)
{
	const w = makeWorld({ rect: { top: -5000, height: 3000, bottom: -2000 } });
	load(w);
	w.flushRaf();
	check("overscroll clamps to 1", w.scale() === 1);
}

// negative overscroll at top → clamps to 0? (top > 0 gives 0; also
// -top/range < 0 clamps to 0)
{
	const w = makeWorld({ rect: { top: 120, height: 3000, bottom: 3120 } });
	load(w);
	w.flushRaf();
	check("negative overscroll clamps to 0", w.scale() === 0);
}

// short article shorter than the viewport: 0 while it is still below
// the fold, 1 once its bottom is inside the viewport
{
	const w = makeWorld({ rect: { top: 1000, height: 300, bottom: 1300 } });
	load(w);
	w.flushRaf();
	check("short article not yet visible = 0", w.scale() === 0);
	w.article._rect = { top: 100, height: 300, bottom: 400 };
	w.fireWin("scroll");
	w.flushRaf();
	check("short article fully visible = 1", w.scale() === 1);
}

// no article → nothing created, no listeners
{
	const w = makeWorld({ hasArticle: false });
	load(w);
	check("no article → no bar", w.created.length === 0);
	check("no article → no scroll listener", !w.winListeners.scroll);
}

// non-article opt-in: [data-reading-progress] fallback is measured —
// the element's own rect drives the bar, so the footer is excluded by
// construction (same math as articles, no duplicated code path)
{
	const w = makeWorld({
		hasArticle: false,
		readingTarget: { top: -1100, height: 3000, bottom: 1900 },
	});
	load(w);
	w.flushRaf();
	check("opt-in target gets a bar", !!w.fill());
	check("opt-in target measured", w.scale() === 0.5);
	check(
		"ResizeObserver watches the opt-in target",
		w.roTarget === w.readingTarget,
	);
}

// duplicate init: second run sees the existing bar and bails
{
	const w = makeWorld({});
	load(w);
	load(w); // second script execution in the same document
	check(
		"duplicate init → single bar",
		w.created.filter((e) => e.className === "article-reading-progress")
			.length === 1,
	);
}

// rAF coalescing: many events → one update per frame
{
	const w = makeWorld({ rect: { top: -100, height: 3000, bottom: 2900 } });
	load(w);
	w.flushRaf();
	// count transform writes directly on the fill's style
	let writes = 0;
	const fillEl = w.fill();
	Object.defineProperty(fillEl.style, "transform", {
		set() {
			writes++;
		},
		get() {
			return "";
		},
	});
	w.fireWin("scroll");
	w.fireWin("scroll");
	w.fireWin("resize");
	w.flushRaf();
	check("coalesced to one write per frame", writes === 1);
}

// pageshow restores → update scheduled
{
	const w = makeWorld({ rect: { top: 0, height: 3000, bottom: 3000 } });
	load(w);
	w.flushRaf();
	w.article._rect = { top: -2200, height: 3000, bottom: 800 };
	w.fireWin("pageshow");
	w.flushRaf();
	check("pageshow restore updates to 1", w.scale() === 1);
}

// image load/error (capture) retriggers a measure
{
	const w = makeWorld({ rect: { top: 0, height: 3000, bottom: 3000 } });
	load(w);
	w.flushRaf();
	w.article._rect = { top: -1100, height: 3000, bottom: 1900 };
	w.fireDoc("load", { tagName: "IMG" });
	w.flushRaf();
	check("img load re-measures", w.scale() === 0.5);
	w.article._rect = { top: -2200, height: 3000, bottom: 800 };
	w.fireDoc("error", { tagName: "IMG" });
	w.flushRaf();
	check("img error re-measures", w.scale() === 1);
	// non-img events are filtered out — the rect changed below, so a
	// real re-measure would recompute to 0; still 1 after a frame
	// proves no update was scheduled
	w.article._rect = { top: 0, height: 3000, bottom: 3000 };
	w.fireDoc("load", { tagName: "DIV" });
	w.flushRaf();
	check("non-img load filtered", w.scale() === 1);
}

// fonts.ready + ResizeObserver both hook an update
{
	const w = makeWorld({ rect: { top: 0, height: 3000, bottom: 3000 } });
	load(w);
	w.flushRaf();
	check("fonts.ready captured", typeof w.fontsReady === "function");
	check("ResizeObserver watching the article", w.roTarget === w.article);
	w.article._rect = { top: -1100, height: 3000, bottom: 1900 };
	w.fontsReady();
	w.flushRaf();
	check("fonts.ready re-measures", w.scale() === 0.5);
	w.article._rect = { top: -2200, height: 3000, bottom: 800 };
	w.roCallback();
	w.flushRaf();
	check("ResizeObserver re-measures", w.scale() === 1);
}

// loading readyState defers init to DOMContentLoaded
{
	const w = makeWorld({ readyState: "loading" });
	load(w);
	check(
		"loading → waits for DOMContentLoaded",
		w.created.length === 0 && w.docListeners.DOMContentLoaded,
	);
	w.docListeners.DOMContentLoaded.forEach((l) => l.fn());
	check("init on DOMContentLoaded", w.created.length === 1);
}

// no ResizeObserver / no document.fonts → still initializes fine
{
	const w = makeWorld({ ro: false, fonts: false });
	load(w);
	w.flushRaf();
	check("works without RO/fonts", w.created.length === 1 && w.scale() === 0);
}

console.log(`article-reading: ${pass} assertions passed`);
