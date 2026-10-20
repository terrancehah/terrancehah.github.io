/* Deterministic offline test for
   projects/teaching-syllabus-template/teaching-syllabus-template.js.

   Runs the real page script inside node:vm against a mocked
   window/document — no browser, no DOM library. Asserts:

   FAQ drawers
     * a real <button> is injected into each h3 with aria-expanded,
       aria-controls and an aria-hidden chevron
     * panels collapse after binding (is-open removed, inert +
       aria-hidden applied) — the markup ships open for no-JS
     * toggles are synchronous class/ARIA sync — rapid clicks stay
       consistent and each drawer is independent
     * closing a panel that holds focus returns focus to the trigger
     * setup failure fails open — panels stay visible
   Screenshot reveals
     * observer armed with threshold 0 + the 24px bottom rootMargin and
       observes every screenshot before .syllabus-reveals-enabled lands
     * is-visible toggles on enter AND exit (replay)
     * no IntersectionObserver / a throwing observe / an initial or live
       prefers-reduced-motion: reduce all fail open

   Run:  node tests/teaching-syllabus-template.test.js   (repo root)
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
	path.join(
		__dirname,
		"..",
		"projects",
		"teaching-syllabus-template",
		"teaching-syllabus-template.js",
	),
	"utf8",
);

/* --- tiny DOM/browser mock ------------------------------------------- */
function makeEl(tag) {
	const el = {
		tagName: tag.toUpperCase(),
		id: "",
		className: "",
		attrs: {},
		children: [],
		parent: null,
		style: {},
		inert: false,
		_text: "",
		_ls: {},
		get textContent() {
			return el._text;
		},
		set textContent(v) {
			el._text = v;
			el.children = [];
		},
		setAttribute(k, v) {
			el.attrs[k] = String(v);
		},
		removeAttribute(k) {
			delete el.attrs[k];
		},
		getAttribute(k) {
			return el.attrs[k];
		},
		appendChild(c) {
			el.children.push(c);
			c.parent = el;
		},
		insertAdjacentHTML(pos, html) {
			(el._adjacent = el._adjacent || []).push(html);
		},
		addEventListener(t, fn) {
			(el._ls[t] = el._ls[t] || []).push(fn);
		},
		click() {
			(el._ls.click || []).forEach((f) => f());
		},
		focus() {
			el._focused = true;
		},
		contains(other) {
			for (let n = other; n; n = n.parent) {
				if (n === el) return true;
			}
			return false;
		},
		querySelector(sel) {
			const cls = sel.replace(/^\./, "");
			const walk = (n) =>
				n.children
					.map((c) =>
						c.className.split(" ").includes(cls) ? c : walk(c),
					)
					.find(Boolean) || null;
			return walk(el);
		},
	};
	el.classList = {
		_set: (next) => {
			el.className = [...next].join(" ");
		},
		_get: () => new Set(el.className.split(" ").filter(Boolean)),
		add(c) {
			const s = this._get();
			s.add(c);
			this._set(s);
		},
		remove(c) {
			const s = this._get();
			s.delete(c);
			this._set(s);
		},
		toggle(c, force) {
			const s = this._get();
			const on = force === undefined ? !s.has(c) : force;
			on ? s.add(c) : s.delete(c);
			this._set(s);
			return on;
		},
		contains(c) {
			return this._get().has(c);
		},
	};
	return el;
}

function makeWorld(opts = {}) {
	const items = [];
	const panels = [];
	const faqCount = opts.faqCount === undefined ? 7 : opts.faqCount;
	for (let i = 0; i < faqCount; i++) {
		const item = makeEl("div");
		item.className = "syllabus-faq-item";
		const q = makeEl("h3");
		q.className = "syllabus-faq-question";
		q._text = `Question ${i + 1}?`;
		const p = makeEl("div");
		p.className = "syllabus-faq-panel is-open"; // ships open
		p.id = `syllabus-faq-panel-${i + 1}`;
		const inner = makeEl("div");
		inner.className = "syllabus-faq-panel-inner";
		const ans = makeEl("p");
		ans.className = "syllabus-faq-answer";
		ans._text = `Answer ${i + 1}.`;
		inner.appendChild(ans);
		p.appendChild(inner);
		item.appendChild(q);
		item.appendChild(p);
		item._question = q;
		item._panel = p;
		item._answer = ans;
		items.push(item);
		panels.push(p);
	}
	const shots = [];
	for (let i = 0; i < 6; i++) {
		const s = makeEl("img");
		s.className = "syllabus-screenshot";
		shots.push(s);
	}

	const mq = {
		matches: !!opts.reduced,
		_ls: [],
		addEventListener(t, f) {
			mq._ls.push(f);
		},
		fire(m) {
			mq.matches = m;
			mq._ls.forEach((f) => f());
		},
	};

	const io = {
		cb: null,
		options: null,
		observed: [],
		disconnects: 0,
		instances: 0,
	};
	function IntersectionObserver(cb, options) {
		io.instances++;
		io.cb = cb;
		io.options = options;
		return {
			observe(el) {
				if (
					opts.ioThrowAt !== undefined &&
					io.observed.length === opts.ioThrowAt
				) {
					throw new Error("observe failed");
				}
				io.observed.push(el);
			},
			disconnect() {
				io.disconnects++;
			},
		};
	}

	const createdEls = []; // every element the script injects
	const document = {
		readyState: "complete",
		documentElement: makeEl("html"),
		body: makeEl("body"),
		activeElement: null,
		createElement: (t) => {
			if (opts.createThrows) throw new Error("createElement failed");
			const el = makeEl(t);
			/* focus() records the active element so the focus-handoff
			   assertion can read document.activeElement */
			el.focus = function () {
				document.activeElement = el;
			};
			createdEls.push(el);
			return el;
		},
		querySelectorAll: (sel) =>
			sel === ".syllabus-faq-item"
				? items
				: sel === ".syllabus-faq-panel"
					? panels
					: sel === ".syllabus-faq-toggle"
						? createdEls.filter(
								(e) => e.className === "syllabus-faq-toggle",
							)
						: sel === ".syllabus-screenshot"
							? shots
							: [],
		addEventListener() {},
	};

	/* simulate real-browser behaviour the ordering fix guards against:
	   once a panel turns inert the browser blurs a focused descendant —
	   a contains(activeElement) check made AFTER inert lands would
	   already see null. If the script focused the trigger first, the
	   active element survives this setter. */
	panels.forEach((p) => {
		delete p.inert;
		p._inert = false;
		Object.defineProperty(p, "inert", {
			get() {
				return p._inert;
			},
			set(v) {
				p._inert = v;
				if (v && p.contains(document.activeElement)) {
					document.activeElement = null;
				}
			},
		});
	});

	const world = {
		window: {
			matchMedia: opts.matchMedia === false ? undefined : () => mq,
			IntersectionObserver:
				opts.io === false ? undefined : IntersectionObserver,
		},
		document,
		console,
	};
	world.items = items;
	world.panels = panels;
	world.shots = shots;
	world.mq = mq;
	world.io = io;
	world.rootCls = () =>
		document.documentElement.classList.contains("syllabus-reveals-enabled");
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

/* --- FAQ drawers -------------------------------------------------------*/

// buttons injected, panels collapsed, ARIA + inert synced
{
	const w = makeWorld();
	load(w);
	const item = w.items[0];
	const btn = item._question.children[0];
	check("toggle injected into h3", btn && btn.tagName === "BUTTON");
	check("toggle class", btn.className === "syllabus-faq-toggle");
	check(
		"aria-controls → panel id",
		btn.attrs["aria-controls"] === "syllabus-faq-panel-1",
	);
	check("collapsed after bind", btn.attrs["aria-expanded"] === "false");
	check(
		"panel closed after bind",
		!item._panel.classList.contains("is-open"),
	);
	check(
		"collapsed panel is inert + aria-hidden",
		item._panel.inert === true &&
			item._panel.attrs["aria-hidden"] === "true",
	);
	check(
		"chevron is aria-hidden svg",
		(btn._adjacent || []).some(
			(h) => h.includes("aria-hidden") && h.includes("<svg"),
		),
	);
	check("question text moved into button", btn._text.includes("Question 1"));
	check("no hidden attribute used", !("hidden" in item._panel.attrs));
}

// rapid toggles stay consistent; drawers are independent
{
	const w = makeWorld();
	load(w);
	const a = w.items[0]._question.children[0];
	const b = w.items[1]._question.children[0];
	a.click();
	check("click opens", a.attrs["aria-expanded"] === "true");
	check(
		"panel reopened",
		w.items[0]._panel.classList.contains("is-open") &&
			w.items[0]._panel.inert === false &&
			!("aria-hidden" in w.items[0]._panel.attrs),
	);
	a.click();
	a.click(); // rapid open-close-open → ends open
	check(
		"rapid toggle ends open",
		w.items[0]._panel.classList.contains("is-open") &&
			a.attrs["aria-expanded"] === "true",
	);
	check(
		"independent: drawer 2 untouched",
		!w.items[1]._panel.classList.contains("is-open") &&
			b.attrs["aria-expanded"] === "false",
	);
	b.click();
	check(
		"drawer 2 opens alone",
		w.items[1]._panel.classList.contains("is-open"),
	);
}

// closing a panel that holds focus returns focus to the trigger
{
	const w = makeWorld();
	load(w);
	const btn = w.items[0]._question.children[0];
	btn.click(); // open
	w.document.activeElement = w.items[0]._answer; // focus inside panel
	btn.click(); // close
	check(
		"focus returns to trigger on close",
		w.document.activeElement === btn,
	);
}

// setup failure fails open — panels keep their shipped-open state
{
	const w = makeWorld({ createThrows: true });
	load(w);
	check(
		"createElement throws → panels stay open",
		w.panels.every((p) => p.classList.contains("is-open")),
	);
	check(
		"fail open clears inert/aria-hidden",
		w.panels.every((p) => p.inert === false && !("aria-hidden" in p.attrs)),
	);
}

/* --- screenshot reveals -------------------------------------------------*/

// happy path: observer armed correctly, enabled after all observed
{
	const w = makeWorld();
	load(w);
	check("observer created once", w.io.instances === 1);
	check("threshold 0", w.io.options.threshold === 0);
	check(
		"24px bottom margin",
		w.io.options.rootMargin === "0px 0px -24px 0px",
	);
	check(
		"all six shots observed",
		w.io.observed.length === 6 &&
			w.shots.every((s) => w.io.observed.includes(s)),
	);
	check("enabled class armed", w.rootCls() === true);
}

// enter + exit toggles is-visible (replay on scroll back out)
{
	const w = makeWorld();
	load(w);
	w.io.cb([{ target: w.shots[2], isIntersecting: true }]);
	check("enter → is-visible", w.shots[2].classList.contains("is-visible"));
	w.io.cb([{ target: w.shots[2], isIntersecting: false }]);
	check(
		"exit → is-visible removed",
		!w.shots[2].classList.contains("is-visible"),
	);
}

// no IntersectionObserver → nothing armed, shots untouched
{
	const w = makeWorld({ io: false });
	load(w);
	check("no IO → not enabled", w.rootCls() === false);
	check(
		"no IO → shots untouched",
		w.shots.every((s) => !s.classList.contains("is-visible")),
	);
}

// observe throwing mid-way fails open — enabled never armed
{
	const w = makeWorld({ ioThrowAt: 3 });
	load(w);
	check("observe throw → not enabled", w.rootCls() === false);
	check("observe throw → disconnected", w.io.disconnects === 1);
	check(
		"observe throw → all shots visible",
		w.shots.every((s) => s.classList.contains("is-visible")),
	);
}

// initial prefers-reduced-motion → module never arms
{
	const w = makeWorld({ reduced: true });
	load(w);
	check("reduced → no observer", w.io.instances === 0);
	check("reduced → not enabled", w.rootCls() === false);
}

// live change to reduce tears down; back to no-preference re-arms
{
	const w = makeWorld();
	load(w);
	w.mq.fire(true);
	check("reduce → enabled removed", w.rootCls() === false);
	check("reduce → observer disconnected", w.io.disconnects === 1);
	check(
		"reduce → all shots visible",
		w.shots.every((s) => s.classList.contains("is-visible")),
	);
	w.mq.fire(false);
	check("no-preference → re-observed", w.io.instances === 2);
	check("no-preference → re-enabled", w.rootCls() === true);
}

console.log(`teaching-syllabus-template: ${pass} assertions passed`);
