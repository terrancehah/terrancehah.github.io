#!/usr/bin/env python3
"""Offline regression check for the reading-progress + press-feedback
pass.

  * every articles/*.html detail page includes /js/article-reading.js
    exactly once, with defer
  * no non-article page includes it
  * articles.css carries the .article-reading-progress bar rules
  * listing/homepage markup marks tappable cards .site-pressable and
    styles/site-motion.css supplies the coarse-pointer :active rule
  * hover lift/zoom rules in the page sheets sit behind
    (hover: hover) and (pointer: fine)
  * CSS braces/parens balanced

Run:  python3 tests/check-article-reading.py   (from repo root)
"""

import glob
import re
import sys
from html.parser import HTMLParser

FAILS = []


class ScriptCheck(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reading_srcs = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            a = dict(attrs)
            if "article-reading.js" in a.get("src", ""):
                self.reading_srcs.append(a)


# --- script includes -----------------------------------------------------
article_pages = sorted(glob.glob("articles/*.html"))
assert len(article_pages) == 14, f"expected 14 articles, got {len(article_pages)}"
for p in article_pages:
    parser = ScriptCheck()
    parser.feed(open(p, errors="ignore").read())
    n = len(parser.reading_srcs)
    if n != 1:
        FAILS.append(f"{p}: article-reading.js included {n} times")
    elif "defer" not in parser.reading_srcs[0] \
            or parser.reading_srcs[0]["src"] != "/js/article-reading.js":
        FAILS.append(f"{p}: script tag missing defer or absolute /js/ src")

for p in glob.glob("*.html") + glob.glob("projects/**/*.html", recursive=True) \
        + glob.glob("playground/*.html"):
    if "article-reading.js" in open(p, errors="ignore").read():
        FAILS.append(f"{p}: non-article page includes article-reading.js")

# --- CSS: progress bar rules ----------------------------------------------
css = open("articles/articles.css").read()
for needle in (".article-reading-progress", "position: fixed",
               "height: 3px", "pointer-events: none",
               ".article-reading-progress-fill", "scaleX(0)",
               "--article-reading-progress-color"):
    if needle not in css:
        FAILS.append(f"articles.css missing {needle}")
if re.search(r"\.article-reading-progress[^{]*\{[^}]*transition", css):
    FAILS.append("progress bar must not have a transition")

# --- pressable markup + shared motion sheet --------------------------------
for path, names in (("articles.html", ("article-hero", "article-card")),
                    ("projects.html", ("project-hero", "project-card")),
                    ("playground.html", ("toy-hero", "toy-card"))):
    s = open(path).read()
    for name in names:
        total = len(re.findall(rf'class="{name}[ "]', s))
        marked = len(re.findall(rf'class="{name} site-pressable', s))
        if total == 0 or marked != total:
            FAILS.append(f"{path}: {name} pressable {marked}/{total}")

idx = open("index.html").read()
tiles = len(re.findall(r'class="[^"]*\barticle-link site-pressable\b', idx))
stray = re.findall(r'class="[^"]*article-link-(?:inner|label|title|arrow)[^"]*site-pressable', idx)
if tiles == 0:
    FAILS.append("index.html: no .article-link.site-pressable tiles")
if stray:
    FAILS.append(f"index.html: site-pressable on non-tile parts {len(stray)}")

motion = open("styles/site-motion.css").read()
# the element-qualified :is(article, a).site-pressable:active selector
# is what outranks .card:active (0,2,0) — a bare class would tie and
# lose to the later-loading page sheets
SEL = ":is(article, a).site-pressable"
if "@media (hover: none), (pointer: coarse)" not in motion \
        or f"{SEL}:active" not in motion or "scale(0.985)" not in motion:
    FAILS.append("site-motion.css missing coarse-pointer press rule")
for needle in ("prefers-reduced-motion",
               f"{SEL}:active", f"{SEL}:hover", f"{SEL} img",
               "transform: none"):
    if needle not in motion:
        FAILS.append(f"site-motion.css reduced-motion guard missing {needle}")
# the reduced-motion block must contain the hover + image overrides
reduce_block = motion.split("prefers-reduced-motion", 1)[1]
for needle in (f"{SEL}:active", f"{SEL}:hover", f"{SEL} img"):
    if needle not in reduce_block:
        FAILS.append(f"site-motion.css: {needle} not inside reduce block")

hdr = open("styles/site-header.css").read()
if not re.search(r'@import\s+["\']\./site-motion\.css["\']', hdr):
    FAILS.append("site-header.css does not import site-motion.css")

# --- hover rules wrapped for fine pointers only ---------------------------
WRAPPED = {
    "articles/articles.css": [".article-card:hover",
                              ".article-card:hover .article-card-image img",
                              ".article-hero:hover"],
    "projects/projects.css": [".project-card:hover",
                              ".project-card:hover .project-card-image img",
                              ".project-hero:hover"],
    "playground/playground.css": [".toy-card:hover",
                                  ".toy-card:hover .toy-card-image img",
                                  ".toy-hero:hover"],
    "styles/homepage.css": [".article-link:hover", ".photo-item:hover img"],
}
for path, sels in WRAPPED.items():
    s = open(path).read()
    if "(prefers-reduced-motion: no-preference)" not in s:
        FAILS.append(f"{path}: hover gates missing no-preference")
    for sel in sels:
        # the rule must not appear at top level — only inside the
        # gated media wrapper (fine pointer + no reduced-motion pref,
        # so reduced-motion users never get the lift/zoom at all)
        stripped = re.sub(
            r"@media \(hover: hover\) and \(pointer: fine\) and "
            r"\(prefers-reduced-motion: no-preference\) \{.*?\n\}", "",
            s, flags=re.S)
        if re.search(r"^" + re.escape(sel) + r" \{", stripped, re.M):
            FAILS.append(f"{path}: {sel} still applies on all pointers")

# --- balance ---------------------------------------------------------------
for f in ["articles/articles.css", "projects/projects.css",
          "playground/playground.css", "styles/homepage.css",
          "styles/site-motion.css", "styles/site-header.css"]:
    d = mn = pa = 0
    for c in open(f).read():
        d += c == "{"
        d -= c == "}"
        mn = min(mn, d)
        pa += c == "("
        pa -= c == ")"
    if d or mn < 0 or pa:
        FAILS.append(f"{f}: unbalanced (depth {d}, min {mn}, parens {pa})")

print(f"checked {len(article_pages)} articles + listing/homepage markup")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
