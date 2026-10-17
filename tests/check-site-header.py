#!/usr/bin/env python3
"""Offline regression check for the shared site header SSOT.

Verifies, for every page that loads js/footer.js (the shared-shell
consumers):
  * header carries the semantic shared classes
    (.site-header > .site-header-inner > .site-header-brand
     > h1.site-header-title, nav.site-nav, .site-social-links)
  * nav contains exactly the four destinations with the correct
    aria-current ("page" on index pages, "location" on detail pages)
  * no presentation utility classes remain on nav anchors
  * every social link has a >=44px hook (.site-social-link) with a
    .site-social-icon img and no old w-8/contacts classes
  * the page resolves the shared header stylesheet (direct
    /styles/site-header.css link, or styles/style.css which imports it)
  * no page-private md:/lg: breakpoint utilities remain inside the
    header's structure elements
  * CSS files stay brace/paren balanced

Run:  python3 tests/check-site-header.py   (from repo root)
Exits non-zero on any failure.
"""

import os
import re
import sys
from html.parser import HTMLParser


class HeaderParser(HTMLParser):
    """Extract nav anchors and social links from a <header> fragment.
    Tolerates multi-line tags — formatters may split attributes and
    the close of a tag across lines."""

    def __init__(self):
        super().__init__()
        self.stack = []            # open tags with their classes
        self.nav_anchors = []      # [(attrs_dict, text)]
        self.social_links = []     # [attrs_dict]
        self.social_imgs = []      # [attrs_dict]
        self._cur_a = None         # anchor being accumulated
        self._in_nav = False
        self._in_socials = False

    @staticmethod
    def _cls(attrs):
        return dict(attrs).get("class", "")

    def handle_starttag(self, tag, attrs):
        cls = self._cls(attrs)
        if tag == "nav" and "site-nav" in cls:
            self._in_nav = True
        if "site-social-links" in cls:
            self._in_socials = True
        self.stack.append(cls)
        if tag == "a" and (self._in_nav or self._in_socials):
            self._cur_a = [dict(attrs), ""]
        if tag == "img" and self._in_socials:
            self.social_imgs.append(dict(attrs))

    def handle_data(self, data):
        if self._cur_a is not None and self._in_nav:
            self._cur_a[1] += data

    def handle_endtag(self, tag):
        if tag == "a" and self._cur_a is not None:
            if self._in_nav:
                self.nav_anchors.append((self._cur_a[0],
                                         self._cur_a[1].strip()))
            else:
                self.social_links.append(self._cur_a[0])
            self._cur_a = None
        cls = self.stack.pop() if self.stack else ""
        if tag == "nav" and "site-nav" in cls:
            self._in_nav = False
        if "site-social-links" in cls:
            self._in_socials = False

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(REPO)

SKIP_DIRS = {"node_modules", ".archive", ".vercel", ".git", "pacey", "biwa-ride"}
FAILS = []


def expect_current(path):
    """(label, aria-current value) each page's nav must mark."""
    base = os.path.basename(path)
    if path == "./index.html":
        return ("Home", "page")
    if base == "articles.html":
        return ("Articles", "page")
    if base == "projects.html":
        return ("Projects", "page")
    if base == "playground.html":
        return ("Playground", "page")
    if "/articles/" in path:
        return ("Articles", "location")
    if "/playground/" in path:
        return ("Playground", "location")
    if "/projects/" in path:
        return ("Projects", "location")
    return None


def consumers():
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(".html"):
                p = os.path.join(root, f)
                if "footer.js" in open(p, errors="ignore").read():
                    yield p


def check_css_balance(path):
    d = mn = pa = 0
    for c in open(path).read():
        if c == "{":
            d += 1
        elif c == "}":
            d -= 1
            mn = min(mn, d)
        elif c == "(":
            pa += 1
        elif c == ")":
            pa -= 1
    if d != 0 or mn < 0 or pa != 0:
        FAILS.append(f"{path}: unbalanced CSS (depth end={d} min={mn} parens={pa})")


for p in sorted(consumers()):
    s = open(p, errors="ignore").read()
    m = re.search(r'<header\b[^>]*>(.*?)</header>', s, re.S)
    if not m:
        FAILS.append(f"{p}: no <header>")
        continue
    h = m.group(1)

    for cls in ("site-header-inner", "site-header-brand", "site-header-title",
                "site-nav", "site-social-links"):
        if cls not in h:
            FAILS.append(f"{p}: missing .{cls}")
    if 'class="site-header"' not in m.group(0):
        FAILS.append(f"{p}: <header> missing .site-header")

    # no page-private breakpoint utilities inside the shared header shell
    for bad in re.findall(r'class="[^"]*(?:md:|lg:|w-\[|w-8|navbutton|contacts)[^"]*"', h):
        FAILS.append(f"{p}: leftover utility/legacy class {bad[:70]}")

    hp = HeaderParser()
    hp.feed(h)
    if not hp.nav_anchors:
        FAILS.append(f"{p}: no .site-nav anchors")
    else:
        labels = [t for _, t in hp.nav_anchors]
        if labels != ["Home", "Articles", "Projects", "Playground"]:
            FAILS.append(f"{p}: nav labels {labels}")
        for attrs, text in hp.nav_anchors:
            if attrs.get("class"):
                FAILS.append(f"{p}: nav anchor {text!r} still has class")
        exp = expect_current(p)
        if exp:
            label, val = exp
            hit = [a for a, t in hp.nav_anchors if t == label]
            if not hit or hit[0].get("aria-current") != val:
                FAILS.append(f"{p}: {label} missing aria-current={val}")

    # socials: every link a .site-social-link with a .site-social-icon img
    if not hp.social_links:
        FAILS.append(f"{p}: empty .site-social-links")
    for a in hp.social_links:
        if "site-social-link" not in a.get("class", ""):
            FAILS.append(f"{p}: social link without .site-social-link")
    for i in hp.social_imgs:
        if "site-social-icon" not in i.get("class", ""):
            FAILS.append(f"{p}: social img without .site-social-icon")

    # stylesheet coverage: direct link, or styles/style.css (imports it)
    direct = "/styles/site-header.css" in s
    via_legacy = bool(re.search(r'href="[^"]*styles/style\.css"', s))
    if not direct and not via_legacy:
        FAILS.append(f"{p}: no shared header stylesheet coverage")

for css in ("styles/site-header.css", "styles/site-navigation.css",
            "styles/site-footer.css", "styles/style.css", "styles/homepage.css"):
    check_css_balance(css)

# SSOT assertions on the sheets themselves
nav_css = open("styles/site-navigation.css").read()
hdr_css = open("styles/site-header.css").read()
# quote-tolerant: the file may use single or double quotes
if not re.search(r"@import\s+['\"]\./site-navigation\.css['\"]", hdr_css):
    FAILS.append("site-header.css does not import site-navigation.css")
if "grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)" not in hdr_css:
    FAILS.append("site-header.css missing desktop grid")
hp = open("styles/homepage.css").read()
if re.search(r'padding-(top|bottom):\s*\d', hp) and "> header" in hp and \
   re.search(r'body\.home-page > header[^}]*padding', hp, re.S):
    FAILS.append("homepage.css still carries header padding")
sc = open("styles/style.css").read()
if re.search(r'(^|\n)\s*header img', sc):
    FAILS.append("style.css still has unscoped header img rule")
if re.search(r'(^|\n)\s*header h1', sc):
    FAILS.append("style.css still has unscoped header h1 rule")

print(f"checked {len(list(consumers()))} consumers")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
