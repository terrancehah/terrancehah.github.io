/* Deterministic offline test for js/site-image-viewer.js.
   ------------------------------------------------------------
   Runs the real shared script inside node:vm against a mocked
   window/document — no browser, no DOM library. Asserts:

     * anchor-wrapped gallery images open the modal dialog with the
       data-full-src original (and preventDefault stops navigation)
     * caption precedence: data-gallery-caption → figure figcaption →
       sibling .image-caption → alt, all via textContent
     * only clicks on the dialog backdrop itself close it — content
       clicks do not
     * the close event (Escape, close button, backdrop) restores the
       exact prior body overflow and refocuses the opener
     * bare images get the keyboard contract (role=button, tabindex,
       aria-label, Enter/Space) — anchors already have one
     * no showModal support → nothing is bound (anchors stay native)
     * a second script load cannot double-bind
     * a load error surfaces the status line; the next open resets it

   Run:  node tests/site-image-viewer.test.js   (repo root)
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
	path.join(__dirname, "..", "js", "site-image-viewer.js"),
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
		parentElement: null,
		style: {},
		dataset: {},
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
			c.parentElement = el;
		},
		get nextElementSibling() {
			if (!el.parentElement) return null;
			const i = el.parentElement.children.indexOf(el);
			return el.parentElement.children[i + 1] || null;
		},
		insertAdjacentHTML(pos, html) {
			(el._adjacent = el._adjacent || []).push(html);
		},
		addEventListener(t, fn) {
			(el._ls[t] = el._ls[t] || []).push(fn);
		},
		fire(t, ev) {
			ev = ev || {};
			if (!ev.preventDefault) {
				ev.preventDefault = () => {
					ev._pd = true;
				};
			}
			if (!ev.stopPropagation) {
				ev.stopPropagation = () => {
					ev._sp = true;
				};
			}
			(el._ls[t] || []).forEach((f) => f(ev));
			return ev;
		},
		click() {
			return el.fire("click", { target: el });
		},
		matches(sel) {
			return sel
				.split(",")
				.map((s) => s.trim())
				.some(
					(s) =>
						s === el.tagName.toLowerCase() ||
						(s[0] === "." && el.classList.contains(s.slice(1))) ||
						(s[0] === "[" &&
							s.endsWith("]") &&
							el.attrs[s.slice(1, -1)] !== undefined),
				);
		},
		closest(sel) {
			for (let n = el; n; n = n.parentElement) {
				if (n.matches && n.matches(sel)) return n;
			}
			return null;
		},
		contains(other) {
			for (let n = other; n; n = n.parentElement) {
				if (n === el) return true;
			}
			return false;
		},
		/* tag selector or .class — one level of descent per call is
		   enough for figcaption lookups */
		querySelector(sel) {
			const walk = (n) =>
				n.children
					.map((c) => (c.matches(sel) ? c : walk(c)))
					.find(Boolean) || null;
			return walk(el);
		},
		focus() {
			el._focused = true;
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
		contains(c) {
			return this._get().has(c);
		},
	};
	return el;
}

/* find the first descendant with a class anywhere below root */
function findClass(root, cls) {
	for (const c of root.children) {
		if (c.className.split(" ").includes(cls)) return c;
		const hit = findClass(c, cls);
		if (hit) return hit;
	}
	return null;
}

function makeWorld(opts = {}) {
	const document = {
		readyState: "complete",
		documentElement: makeEl("html"),
		body: makeEl("body"),
		activeElement: null,
		created: [],
		createElement(t) {
			const el = makeEl(t);
			/* dialog gets mock-native modal behaviour unless the world
			   says the API is missing */
			if (t === "dialog" && opts.dialogSupport !== false) {
				el.showModal = function () {
					el.open = true;
				};
				el.close = function () {
					el.open = false;
					el.fire("close", {});
				};
			}
			/* focus() records the active element for the refocus check */
			el.focus = function () {
				document.activeElement = el;
			};
			document.created.push(el);
			return el;
		},
		querySelectorAll(sel) {
			return sel.includes("gallery-image") ||
				sel.includes("cursor-pointer")
				? opts.imgs || []
				: [];
		},
		querySelector(sel) {
			return sel === ".site-image-viewer"
				? findClass(document.body, "site-image-viewer")
				: null;
		},
		getElementById(id) {
			const walk = (n) => {
				if (n.id === id) return n;
				for (const c of n.children) {
					const hit = walk(c);
					if (hit) return hit;
				}
				return null;
			};
			return walk(document.body);
		},
		addEventListener() {},
	};
	return {
		window: {},
		document,
		console,
	};
}

function load(world) {
	vm.createContext(world);
	vm.runInContext(SRC, world);
}

/* fixtures */
function galleryImg({ alt, fullSrc, caption } = {}) {
	const a = makeEl("a");
	a.className = "syllabus-image-link";
	a.attrs.href = fullSrc;
	const img = makeEl("img");
	img.className = "syllabus-screenshot";
	img.alt = alt || "";
	img.src = "thumb.webp";
	img.currentSrc = "thumb.webp";
	if (fullSrc) img.dataset.fullSrc = fullSrc;
	if (caption) img.dataset.galleryCaption = caption;
	a.appendChild(img);
	return { a, img };
}

let pass = 0;
function check(name, cond) {
	assert.ok(cond, name);
	pass++;
}

/* --- linked images open the modal with the original ----------------- */
{
	const { a, img } = galleryImg({
		alt: "Class calendar",
		fullSrc: "/resources/x/original.png",
		caption: "Class calendar",
	});
	const w = makeWorld({ imgs: [img] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	check("dialog injected", dialog && dialog.tagName === "DIALOG");

	const ev = a.click();
	check("anchor click opens the dialog", dialog.open === true);
	check("navigation prevented — viewer stays on-page", ev._pd === true);
	const enlarged = findClass(dialog, "site-image-viewer-image");
	check("full-res original used", enlarged.src === img.dataset.fullSrc);
	check("alt copied", enlarged.alt === "Class calendar");
	check(
		"caption from data-gallery-caption",
		findClass(dialog, "site-image-viewer-caption")._text ===
			"Class calendar",
	);
	check(
		"scroll locked while open",
		w.document.body.style.overflow === "hidden",
	);
}

/* --- caption precedence ladder --------------------------------------- */
{
	const fig = makeEl("figure");
	const fImg = makeEl("img");
	fImg.className = "cursor-pointer";
	fImg.alt = "Figure alt";
	fImg.dataset.fullSrc = "x.png";
	const fc = makeEl("figcaption");
	fc._text = "Figure caption";
	fig.appendChild(fImg);
	fig.appendChild(fc);

	/* article layout: the img sits inside a wrapper div and the
	   .image-caption is that wrapper's next sibling — same shape the
	   inline viewers crawled */
	const holder = makeEl("div");
	const wrap = makeEl("div");
	const cImg = makeEl("img");
	cImg.className = "cursor-pointer";
	cImg.alt = "Caption alt";
	const cap = makeEl("div");
	cap.className = "image-caption";
	cap._text = "Sibling caption";
	wrap.appendChild(cImg);
	holder.appendChild(wrap);
	holder.appendChild(cap);

	const bare = makeEl("img");
	bare.className = "cursor-pointer";
	bare.alt = "Bare alt";

	const w = makeWorld({ imgs: [fImg, cImg, bare] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	const caption = findClass(dialog, "site-image-viewer-caption");

	fImg.click();
	check("figcaption wins over alt", caption._text === "Figure caption");
	cImg.click();
	check("sibling .image-caption next", caption._text === "Sibling caption");
	bare.click();
	check("alt as last resort", caption._text === "Bare alt");
}

/* --- gallery images reuse their labelled section's live heading ------ */
{
	/* mirrors the Notion features: an aria-labelledby section wrapping
	   the linked image — the mechanism keys on the ARIA hook, not on
	   any syllabus-* class name */
	const section = makeEl("section");
	section.className = "feature-block";
	section.setAttribute("aria-labelledby", "feature-title-1");
	const h2 = makeEl("h2");
	h2.id = "feature-title-1";
	h2._text = "Easy-to-view Calendar";
	const { a, img } = galleryImg({ alt: "Calendar view" });
	img.dataset.galleryImage = "";
	section.appendChild(h2);
	section.appendChild(a);

	const w = makeWorld({ imgs: [img] });
	w.document.body.appendChild(section); /* in the document for
		getElementById before the script runs */
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	const caption = findClass(dialog, "site-image-viewer-caption");
	a.click();
	check(
		"caption is the section's labelled heading",
		caption._text === "Easy-to-view Calendar",
	);
	dialog.close();
	h2._text = "Renamed heading";
	a.click();
	check(
		"caption tracks the live heading, not a frozen copy",
		caption._text === "Renamed heading",
	);
}

/* --- overview: no named section → the existing figcaption ------------ */
{
	const fig = makeEl("figure");
	const fImg = makeEl("img");
	fImg.className = "cursor-pointer";
	fImg.dataset.galleryImage = "";
	fImg.alt = "Overview alt";
	const fc = makeEl("figcaption");
	fc._text = "Introducing a user-friendly planner.";
	fig.appendChild(fImg);
	fig.appendChild(fc);
	const w = makeWorld({ imgs: [fImg] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	fImg.click();
	check(
		"unnamed ancestor → existing figcaption",
		findClass(dialog, "site-image-viewer-caption")._text ===
			"Introducing a user-friendly planner.",
	);
}

/* --- backdrop closes, content clicks don't --------------------------- */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	a.click();
	const content = findClass(dialog, "site-image-viewer-content");
	dialog.fire("click", { target: content });
	check("content click keeps it open", dialog.open === true);
	dialog.fire("click", { target: dialog });
	check("backdrop click closes", dialog.open === false);
}

/* --- close restores prior overflow + refocuses the opener ------------ */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	w.document.body.style.overflow = "auto"; /* pre-existing value */
	a.click();
	check(
		"overflow hidden while open",
		w.document.body.style.overflow === "hidden",
	);
	dialog.close(); /* Escape and the close button land here too */
	check(
		"exact prior overflow restored",
		w.document.body.style.overflow === "auto",
	);
	check("focus handed back to the opener", a._focused === true);
}

/* --- close button + Escape-equivalent close event --------------------- */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	const closeBtn = findClass(dialog, "site-image-viewer-close");
	check(
		"close button is labelled",
		closeBtn.attrs["aria-label"] === "Close image viewer",
	);
	a.click();
	closeBtn.click();
	check("close button closes", dialog.open === false);
	check(
		"x icon is aria-hidden svg",
		(closeBtn._adjacent || []).some(
			(h) => h.includes("aria-hidden") && h.includes("<svg"),
		),
	);
}

/* --- bare images get the keyboard contract --------------------------- */
{
	const img = makeEl("img");
	img.className = "cursor-pointer";
	img.alt = "Kinabalu sunrise";
	img.dataset.fullSrc = "sunrise.jpg";
	const w = makeWorld({ imgs: [img] });
	load(w);
	check("role=button", img.attrs.role === "button");
	check("tabindex=0", img.attrs.tabindex === "0");
	check(
		"aria-label describes the action",
		img.attrs["aria-label"] === "Enlarge image: Kinabalu sunrise",
	);
	const dialog = findClass(w.document.body, "site-image-viewer");
	img.fire("keydown", { key: "x" });
	check("unrelated key ignored", dialog.open !== true);
	const ev = img.fire("keydown", { key: " " });
	check("Space opens", dialog.open === true && ev._pd === true);
	dialog.close();
	img.fire("keydown", { key: "Enter" });
	check("Enter opens too", dialog.open === true);
}

/* --- no showModal support → anchors stay native ----------------------- */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img], dialogSupport: false });
	load(w);
	check(
		"unsupported: no dialog appended",
		!findClass(w.document.body, "site-image-viewer"),
	);
	check(
		"unsupported: no click interception — anchor still navigates",
		(a._ls.click || []).length === 0,
	);
	check(
		"unsupported: bare-image contract skipped too",
		img.attrs.role === undefined,
	);
}

/* --- no images → nothing built ---------------------------------------- */
{
	const w = makeWorld({ imgs: [] });
	load(w);
	check(
		"empty page builds nothing",
		!findClass(w.document.body, "site-image-viewer"),
	);
}

/* --- a second script load cannot double-bind -------------------------- */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img] });
	load(w);
	load(w); /* e.g. a duplicated <script> tag */
	check(
		"single dialog after double load",
		w.document.body.children.filter(
			(c) => c.className === "site-image-viewer",
		).length === 1,
	);
	check("click handler bound once", (a._ls.click || []).length === 1);
}

/* --- error status surfaces, then resets on next open ------------------ */
{
	const { a, img } = galleryImg({ fullSrc: "x.png" });
	const w = makeWorld({ imgs: [img] });
	load(w);
	const dialog = findClass(w.document.body, "site-image-viewer");
	const enlarged = findClass(dialog, "site-image-viewer-image");
	const status = findClass(dialog, "site-image-viewer-status");
	a.click();
	check("status hidden on open", status.hidden === true);
	enlarged.fire("error");
	check("error reveals the status line", status.hidden === false);
	dialog.close();
	a.click();
	check("next open resets the error", status.hidden === true);
	check("status copy", status._text === "This image could not be loaded.");
}

console.log(`site-image-viewer: ${pass} assertions passed`);
