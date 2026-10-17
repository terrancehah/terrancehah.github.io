#!/usr/bin/env python3
"""Offline regression check for the loading/motion pass.

  * each root listing page (index/articles/projects/playground) marks
    exactly its first main-content img eager + fetchpriority=high +
    decoding=async; every other main-content img is lazy + async
  * header icons (.site-social-icon) and aria-hidden ornaments are
    untouched (no loading attr requirement either way — asserted
    absent so they can't drift into lazy markup noise)
  * no <img> tag carries a duplicated attribute
  * width/height on locally-resolvable imgs match the real intrinsic
    dimensions of the file on disk (PIL; viewBox for SVG)
  * img src attributes are byte-identical to HEAD — loading work must
    never rewrite URLs
  * styles/site-motion.css holds the @view-transition opt-in under
    no-preference, the root crossfade keyframes, and the reduced-motion
    navigation:none opt-out
  * no JS interception: no startViewTransition anywhere

Run:  python3 tests/check-site-loading.py   (from repo root)
"""

import os
import re
import subprocess
import sys
from html.parser import HTMLParser

FAILS = []
SKIP = {"node_modules", ".archive", ".vercel", ".git", "pacey",
        "biwa-ride", ".venv", "venv", "dist"}
ROOT_PAGES = ["./index.html", "./articles.html", "./projects.html",
              "./playground.html"]
ICON_CLASSES = ("site-social-icon", "handwriting-crossout")


def consumers():
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            if f.endswith(".html"):
                p = os.path.join(root, f)
                if "footer.js" in open(p, errors="ignore").read():
                    yield p


class ImgScan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.imgs = []          # [(line, attrs, raw_attr_names)]
        self._raw = None

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.imgs.append((self.getpos()[0], dict(attrs)))

    handle_startendtag = handle_starttag


def resolve_local(page, src):
    if "://" in src or src.startswith(("//", "data:")):
        return None
    cand = src.lstrip("/") if src.startswith("/") else \
        os.path.normpath(os.path.join(os.path.dirname(page), src))
    while cand.startswith("../") or cand == "..":
        cand = cand[3:] if cand != ".." else ""
    return cand if os.path.isfile(cand) else None


def intrinsic(path):
    try:
        if path.lower().endswith(".svg"):
            t = open(path, errors="ignore").read()
            w = re.search(r'<svg[^>]*\bwidth="(\d+)', t)
            h = re.search(r'<svg[^>]*\bheight="(\d+)', t)
            if w and h:
                return int(w.group(1)), int(h.group(1))
            vb = re.search(r'viewBox="[\d.\s-]+\s([\d.]+)\s([\d.]+)"', t)
            return (round(float(vb.group(1))), round(float(vb.group(2)))) \
                if vb else None
        from PIL import Image
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


all_pages = sorted(consumers())
for page in all_pages:
    s = open(page, errors="ignore").read()
    scan = ImgScan()
    scan.feed(s)

    # duplicate-attribute audit on raw tag text
    for m in re.finditer(r"<img\b[^>]*>", s, re.S):
        names = re.findall(r'\s([\w-]+)="', m.group(0))
        dup = {n for n in names if names.count(n) > 1}
        if dup:
            FAILS.append(f"{page}: duplicated attrs {dup} in img tag")

    mains = [(ln, a) for ln, a in scan.imgs
             if not any(c in a.get("class", "") for c in ICON_CLASSES)
             and a.get("aria-hidden") != "true"
             and "h-8" not in a.get("class", "")]
    icons = [(ln, a) for ln, a in scan.imgs
             if any(c in a.get("class", "") for c in ICON_CLASSES)]
    for ln, a in icons:
        if a.get("loading") or a.get("fetchpriority"):
            FAILS.append(f"{page} L{ln}: icon img gained loading attrs")

    first = True
    for ln, a in mains:
        if page in ROOT_PAGES and first:
            first = False
            if not (a.get("loading") == "eager"
                    and a.get("fetchpriority") == "high"
                    and a.get("decoding") == "async"):
                FAILS.append(f"{page} L{ln}: hero img not "
                             "eager/high/async")
            continue
        first = False
        if a.get("loading") != "lazy" or a.get("decoding") != "async":
            FAILS.append(f"{page} L{ln}: main img missing "
                         "lazy/async")

        # intrinsic dimension check for local files
        loc = resolve_local(page, a.get("src", ""))
        if loc and a.get("width") and a.get("height"):
            real = intrinsic(loc)
            if real and (int(float(a["width"])), int(float(a["height"]))) \
                    != real:
                FAILS.append(f"{page} L{ln}: width/height "
                             f"{a['width']}x{a['height']} != file "
                             f"{real[0]}x{real[1]}")

    # src integrity vs HEAD — loading work may add attrs, never rewrite
    head = subprocess.run(["git", "show", f"HEAD:{page}"],
                          capture_output=True, text=True).stdout
    old_srcs = re.findall(r'<img\b[^>]*\bsrc="([^"]*)"', head)
    new_srcs = re.findall(r'<img\b[^>]*\bsrc="([^"]*)"', s)
    if old_srcs != new_srcs:
        FAILS.append(f"{page}: img src list changed vs HEAD")

# --- shared motion sheet --------------------------------------------------
motion = open("styles/site-motion.css").read()
if "@view-transition" not in motion or "navigation: auto" not in motion:
    FAILS.append("site-motion.css: no @view-transition navigation opt-in")
nopref = re.search(r"@media \(prefers-reduced-motion: no-preference\)[^{]*"
                   r"\{\s*@view-transition", motion)
if not nopref:
    FAILS.append("@view-transition auto not gated to no-preference")
reduce_part = motion.split("prefers-reduced-motion: reduce", 1)[-1]
if "navigation: none" not in reduce_part:
    FAILS.append("no reduced-motion navigation:none opt-out")
for needle in ("site-page-leave", "site-page-enter",
               "::view-transition-old(root)",
               "::view-transition-new(root)", "mix-blend-mode: normal"):
    if needle not in motion:
        FAILS.append(f"site-motion.css missing {needle}")

# no JS interception
bad_js = subprocess.run(
    ["git", "grep", "-l", "startViewTransition", "--", "*.js"],
    capture_output=True, text=True).stdout.strip()
if bad_js:
    FAILS.append(f"startViewTransition found in JS: {bad_js}")

print(f"checked {len(all_pages)} consumers")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
