#!/usr/bin/env python3
"""Offline regression check for the optimized-image pipeline.

  * manifest integrity: every source still exists with the recorded
    sha256/bytes; every variant exists, byte-matches, and decodes to
    the recorded dimensions
  * markup references: every generated src/srcset URL in consumer HTML
    resolves to a manifest variant and back to a preserved original
  * coverage: no remaining main-content img references a local raster
    file that still qualifies as a candidate (>=250KB or edge>1920,
    non-animated) without an optimized srcset — i.e. nothing forgotten
  * gallery viewers read data-full-src / currentSrc, not bare img.src

Run:  python3 tests/check-site-images.py   (from repo root)
"""

import hashlib
import json
import os
import re
import sys
from html.parser import HTMLParser

FAILS = []
SKIP = {"node_modules", ".archive", ".vercel", ".git", "pacey",
        "biwa-ride", ".venv", "venv", "dist"}
OUT = "resources/optimized"
ICON_CLASSES = ("site-social-icon", "handwriting-crossout")
RASTER = (".jpg", ".jpeg", ".png", ".webp")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_local(page, src):
    if "://" in src or src.startswith(("//", "data:")):
        return None
    cand = src.lstrip("/") if src.startswith("/") else \
        os.path.normpath(os.path.join(os.path.dirname(page), src))
    while cand.startswith("../") or cand == "..":
        cand = cand[3:] if cand != ".." else ""
    return cand if os.path.isfile(cand) else None


class ImgScan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.imgs = []

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.imgs.append((self.getpos()[0], dict(attrs)))

    handle_startendtag = handle_starttag


def consumers():
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            if f.endswith(".html"):
                p = os.path.join(root, f)
                if "footer.js" in open(p, errors="ignore").read():
                    yield p


man_path = os.path.join(OUT, "manifest.json")
if not os.path.isfile(man_path):
    print("no manifest"); sys.exit(1)
man = json.load(open(man_path))

# --- manifest integrity ----------------------------------------------------
from PIL import Image
for src, e in man["sources"].items():
    if not os.path.isfile(src):
        FAILS.append(f"manifest source missing: {src}")
        continue
    if sha256(src) != e["sha256"]:
        FAILS.append(f"source modified after optimize: {src}")
    if os.path.getsize(src) != e["bytes"]:
        FAILS.append(f"source size drifted: {src}")
    for v in e["variants"]:
        p = v["path"]
        if not os.path.isfile(p):
            FAILS.append(f"variant missing: {p}")
            continue
        if os.path.getsize(p) != v["bytes"]:
            FAILS.append(f"variant bytes drifted: {p}")
        try:
            with Image.open(p) as im:
                if im.size != (v["width"], v["height"]):
                    FAILS.append(f"{p}: dims {im.size} != manifest "
                                 f"{v['width']}x{v['height']}")
        except Exception:
            FAILS.append(f"variant undecodable: {p}")

# --- markup references + coverage ------------------------------------------
for page in sorted(consumers()):
    s = open(page, errors="ignore").read()
    scan = ImgScan()
    scan.feed(s)
    for ln, a in scan.imgs:
        cls = a.get("class", "")
        if any(c in cls for c in ICON_CLASSES) \
                or a.get("aria-hidden") == "true" or "h-8" in cls:
            continue
        src = a.get("src", "")
        gen = src.lstrip("/")
        if gen.startswith(OUT + "/"):
            orig = man.get("by_variant", {}).get(gen)
            if not orig:
                FAILS.append(f"{page} L{ln}: generated src orphaned "
                             f"{src[:60]}")
            for part in (a.get("srcset") or "").split(","):
                part = part.strip()
                if part:
                    url = part.rpartition(" ")[0]
                    if resolve_local(page, url) is None:
                        FAILS.append(f"{page} L{ln}: dangling srcset "
                                     f"{url[:60]}")
        else:
            loc = resolve_local(page, src)
            if loc and loc.lower().endswith(RASTER):
                with Image.open(loc) as im:
                    # MPO/JPEG multi-frame = multi-picture still, allowed;
                    # other multi-frame formats are true animations
                    animated = getattr(im, "n_frames", 1) > 1 \
                        and im.format not in ("MPO", "JPEG")
                    big = (os.path.getsize(loc) >= 250 * 1024
                           or max(im.size) > 1920) and not animated
                if big and not a.get("srcset"):
                    FAILS.append(f"{page} L{ln}: forgotten candidate "
                                 f"{src[:60]}")

# --- markup well-formedness: no attributes after a self-closing slash --------
for page in sorted(consumers()):
    s = open(page, errors="ignore").read()
    for m in re.finditer(r'/\s+(?=(?:srcset|sizes|data-full-src|width|height)=)',
                         s):
        FAILS.append(f"{page}: attribute after self-closing slash "
                     f"(offset {m.start()})")

# --- gallery viewers use full-src fallback chain -----------------------------
for p in ("articles/mount-kinabalu.html",
          "articles/tnbyy-my-first-camphike.html"):
    t = open(p).read()
    if "dataset.fullSrc" not in t or "enlargedImage.src = this.src" in t:
        FAILS.append(f"{p}: viewer still uses bare this.src")

# --- unit fixtures: scanner context + palette-PNG alpha -----------------------
# import the optimizer's scanner/sizing to prove ancestor tracking is
# correct around void elements and self-closing siblings
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "optimg", os.path.join(os.path.dirname(__file__), "..", "scripts",
                           "optimize-site-images.py"))
opt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(opt)

fixture = """<html><body>
<div class="hero-image"><img src="a.jpg"><br>
<img src="b.jpg"></div>
<div class="article-card-image"><img src="c.jpg"/>
<p>text <img src="d.jpg"> tail</p></div>
<div class="hero-image"><img src="e.jpg"><input type="checkbox"></div>
<div class="gallery"><img src="f.jpg"><img src="g.jpg"></div>
</body></html>"""
sc = opt.ImgScan()
sc.feed(fixture)
ctx = [opt.context_sizes("./index.html", a, anc) for _, a, anc in sc.imgs]
# a: hero ancestor -> hero sizes; b: still inside hero div -> hero;
# c,d: card ancestor -> card; e: second hero -> hero; f,g: none -> root card
want = [opt.SIZES_HERO, opt.SIZES_HERO, opt.SIZES_CARD, opt.SIZES_CARD,
        opt.SIZES_HERO, opt.SIZES_CARD, opt.SIZES_CARD]
if ctx != want:
    FAILS.append(f"scanner context fixture: {ctx} != {want}")
if len(sc.imgs) != 7:
    FAILS.append(f"scanner fixture count {len(sc.imgs)} != 7")

article_fixture = """<article>
<div class="hero-image"><img src="h.jpg"><hr></div>
<figure class="image-block"><img src="i.jpg"/></figure>
<div class="article-card-image"><img src="j.jpg"><br><img src="k.jpg"></div>
</article>"""
sc2 = opt.ImgScan()
sc2.feed(article_fixture)
ctx2 = [opt.context_sizes("./articles/x.html", a, anc)
        for _, a, anc in sc2.imgs]
want2 = [opt.SIZES_ARTICLE_HERO, opt.SIZES_ARTICLE_PHOTO,
         opt.SIZES_CARD, opt.SIZES_CARD]
if ctx2 != want2:
    FAILS.append(f"article scanner fixture: {ctx2} != {want2}")

# update_img_tag: width/height are set independently, attrs land before
# a self-closing tail, and look-alike names (data-width) never match
entry1 = {"variants": [{"path": "resources/optimized/x/y-640.webp",
                        "width": 640, "height": 400, "edge": 640,
                        "bytes": 100}]}
attrs1 = {"src": "y.jpg", "_ancestors": set()}
cases = [
    ('<img src="y.jpg"/>',                          # neither dim
     ['width="640"', 'height="400"', 'srcset="', 'sizes="', '/>'],
     ['/ width=', '/ height=']),
    ('<img src="y.jpg" width="300"/>',              # width only
     ['width="640"', 'height="400"', '/>'],
     ['width="300"', '/ height=']),
    ('<img src="y.jpg" height="200"/>',             # height only
     ['width="640"', 'height="400"', '/>'],
     ['height="200"', '/ width=']),
    ('<img src="y.jpg" data-width="999">',          # look-alike attr
     ['width="640"', 'height="400"', 'data-width="999"'],
     ['data-width="640"']),
]
for tag, must, banned in cases:
    out = opt.update_img_tag(tag, dict(attrs1), entry1, "./index.html")
    for needle in must:
        if needle not in out:
            FAILS.append(f"update_img_tag({tag!r}): missing {needle!r} "
                         f"in {out[:120]!r}")
    for needle in banned:
        if needle in out:
            FAILS.append(f"update_img_tag({tag!r}): found {needle!r} "
                         f"in {out[:120]!r}")
    if out.count('src="') != 1 or out.count('srcset="') != 1:
        FAILS.append(f"update_img_tag({tag!r}): duplicated attrs "
                     f"{out[:120]!r}")

# palette PNG with transparency must keep alpha through load+encode
import io as _io
from PIL import Image as _Img
pal = _Img.new("P", (8, 8))
pal.putpalette([255, 0, 0] * 256)
pal.info["transparency"] = 0
tmp = "/tmp/opt-test-palette.png"
pal.save(tmp)
im2, fmt2 = opt.load_image(tmp)
if im2 is None or "A" not in im2.getbands():
    FAILS.append("palette PNG transparency lost in load_image")
else:
    data, dims = opt.encode_webp(im2, 64, True)
    chk = _Img.open(_io.BytesIO(data))
    if "A" not in chk.getbands():
        FAILS.append("palette PNG alpha lost in webp encode")

print(f"manifest: {len(man['sources'])} sources, "
      f"{sum(len(e['variants']) for e in man['sources'].values())} variants")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
