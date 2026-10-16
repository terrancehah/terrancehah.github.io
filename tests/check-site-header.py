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

    nav = re.search(r'<nav\b[^>]*class="[^"]*site-nav[^"]*"[^>]*>(.*?)</nav>', h, re.S)
    if not nav:
        FAILS.append(f"{p}: no .site-nav")
    else:
        anchors = re.findall(r'<a\b([^>]*)>([^<]*)</a>', nav.group(1))
        labels = [t.strip() for _, t in anchors]
        if labels != ["Home", "Articles", "Projects", "Playground"]:
            FAILS.append(f"{p}: nav labels {labels}")
        for attrs, text in anchors:
            if "class=" in attrs:
                FAILS.append(f"{p}: nav anchor {text.strip()!r} still has class")
        exp = expect_current(p)
        if exp:
            label, val = exp
            mm = re.search(rf'<a\b([^>]*)>\s*{label}\s*</a>', nav.group(1))
            if not mm or f'aria-current="{val}"' not in mm.group(1):
                FAILS.append(f"{p}: {label} missing aria-current={val}")

    # socials: every link a .site-social-link with a .site-social-icon img
    soc = re.search(r'class="site-social-links"[^>]*>(.*?)</div>', h, re.S)
    if soc:
        links = re.findall(r'<a\b[^>]*>', soc.group(1))
        imgs = re.findall(r'<img\b[^>]*>', soc.group(1))
        for a in links:
            if "site-social-link" not in a:
                FAILS.append(f"{p}: social link without .site-social-link")
        for i in imgs:
            if "site-social-icon" not in i:
                FAILS.append(f"{p}: social img without .site-social-icon")
        if not links:
            FAILS.append(f"{p}: empty .site-social-links")

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
if "@import './site-navigation.css'" not in hdr_css:
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
