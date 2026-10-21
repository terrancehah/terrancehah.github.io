// Layout + no-offline-UI regression test: the app is ONLINE-FIRST — no
// offline toggle, disclosure, button or status readout may exist anywhere
// in the document or stylesheet. The earlier bug (a stray <p> as a direct
// .biwa-shell child auto-placed by the desktop grid) is guarded by the
// shell-children assertion, and the pinned grid cells keep nav/main on
// one row. Pure static analysis — no browser, no server, no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = path.join(__dirname, "..", "..", "projects", "biwa-ride");
const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
const css = fs.readFileSync(path.join(APP_DIR, "biwa-ride.css"), "utf8");
const I18n = require("../../projects/biwa-ride/biwa-i18n.js");

// Tiny tag-stack parser: returns the direct element children of the
// element matched by `openRe`, each as {tag, attrs}.
function directChildren(src, openRe) {
	const open = src.search(openRe);
	assert.notEqual(open, -1, "container element not found in index.html");
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
	tagRe.lastIndex = open;
	let depth = 0;
	const kids = [];
	let m;
	while ((m = tagRe.exec(src))) {
		const [full, tag, rawAttrs] = m;
		const closing = full[1] === "/";
		const selfClose =
			/\/\s*>$/.test(full) ||
			tag === "meta" ||
			tag === "link" ||
			tag === "img" ||
			tag === "br" ||
			tag === "hr" ||
			tag === "input" ||
			tag === "path" ||
			tag === "rect" ||
			tag === "circle" ||
			tag === "use" ||
			tag === "source";
		if (!closing) {
			depth += 1;
			if (depth === 2) kids.push({ tag, attrs: rawAttrs });
			if (selfClose) depth -= 1;
		} else {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	return kids;
}

test("the shell has exactly nav, main and footer as direct children", () => {
	const kids = directChildren(html, /<div\s+class="biwa-shell">/);
	assert.deepEqual(
		kids.map((k) => k.tag),
		["nav", "main", "footer"],
		"every extra direct child is an auto-placed grid item that shifts the desktop columns",
	);
	assert.match(kids[0].attrs, /class="biwa-nav"/);
	assert.match(kids[1].attrs, /id="biwa-main"/);
	assert.match(kids[2].attrs, /class="biwa-footer"/);
});

test("no offline control, disclosure or status readout exists anywhere", () => {
	assert.doesNotMatch(html, /<details[\s>]/, "no details element at all");
	assert.doesNotMatch(html, /<summary[\s>]/, "no summary element at all");
	assert.doesNotMatch(
		html,
		/biwa-offline-details|biwa-sync-status/,
		"the disclosure/status classes are gone from the markup",
	);
	assert.doesNotMatch(
		html,
		/Offline\s*&|offline-toggle|offline-mode/i,
		"no offline control label survives",
	);
	assert.doesNotMatch(
		css,
		/\.biwa-offline-details|\.biwa-sync-status/,
		"the disclosure/status rules are gone from the stylesheet",
	);
});

test("the footer keeps only its nav and credit — no disclosure grew back", () => {
	const footerKids = directChildren(html, /<footer\s+class="biwa-footer">/);
	assert.deepEqual(
		footerKids.map((k) => k.tag),
		["nav", "p"],
		"footer children are just the link nav and the credit line",
	);
});

test("connection-transition toast strings have Chinese translations", () => {
	I18n.setLang("zh");
	for (const key of [
		"Offline — using your saved itinerary. Changes stay on this phone until the connection returns.",
		"Offline — keep this page open; changes cannot be saved on this phone.",
		"Connection interrupted — using your saved itinerary. Changes stay on this phone until syncing resumes.",
		"Connection restored — your changes are synced.",
	]) {
		const translated = I18n.t(key);
		assert.notEqual(translated, key, "missing zh translation: " + key);
	}
	I18n.setLang("en");
});

test("desktop CSS pins nav, main and footer to explicit grid cells", () => {
	// The Desktop section is the LAST 56rem block in the sheet; earlier
	// ones style components and contain a .biwa-mini-live .biwa-shell rule
	// that must not be mistaken for the grid shell.
	const media = css.slice(css.lastIndexOf("@media (min-width: 56rem)"));
	const block = (sel) => {
		const re = new RegExp(
			sel.replace(/[.#]/g, (m) => "\\" + m) + "\\s*\\{([^}]*)\\}",
		);
		const b = media.match(re);
		assert.ok(b, sel + " rule missing inside the desktop media block");
		return b[1];
	};
	// Selector anchored to a line start so `.biwa-mini-live .biwa-shell`
	// cannot match the same pattern.
	const shell = media.match(/(?:^|\n)\s*\.biwa-shell\s*\{([^}]*)\}/);
	assert.ok(
		shell && /display:\s*grid/.test(shell[1]),
		"shell is the two-column grid",
	);
	assert.match(block(".biwa-nav"), /grid-column:\s*1[^0-9]/);
	assert.match(block(".biwa-nav"), /grid-row:\s*1[^0-9]/);
	assert.match(block("#biwa-main"), /grid-column:\s*2[^0-9]/);
	assert.match(block("#biwa-main"), /grid-row:\s*1[^0-9]/);
	assert.match(block(".biwa-footer"), /grid-column:\s*2[^0-9]/);
	assert.match(block(".biwa-footer"), /grid-row:\s*2[^0-9]/);
});
