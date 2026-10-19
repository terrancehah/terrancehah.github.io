#!/usr/bin/env python3
"""Offline regression for the Pacey's landing neat-annotations captions.

  * markup: the six .landing-feature-caption figcaptions carry a mixed
    direction sequence (ann-nw, ann-ne, ann-n, ann-ne, ann-nw, ann-n in
    document order), 'ann ann-no-mark', landing-mobile-only, the matching
    landing-caption--* semantic modifier, non-empty real text (the
    accessible label — no data-note needed), and no inline arrow SVGs
  * wiring: the vendored stylesheet is linked BEFORE pacey-landing.css
    so the scoped overrides win on equal specificity
  * vendor files: neat-annotations.css + MIT LICENSE exist, unmodified
    upstream shape (ann/ann-n base rules present)
  * styles: desktop guard hides .landing-feature-caption.ann; inside the
    <=46rem block the caption shows, the ::before arrow is forced
    visible and placed in the caption's top gap, and ::after (the
    attr(data-note) duplicate) is disabled; .landing-caption-arrow is
    fully removed

Run:  python3 tests/check-pacey-annotations.py   (from repo root)
"""

import os
import re
import sys
from html.parser import HTMLParser

FAILS = []
ROOT = os.path.join(os.path.dirname(__file__), "..")
INDEX = os.path.join(ROOT, "pacey", "index.html")
LANDING = os.path.join(ROOT, "pacey", "pacey-landing.css")
VEND = os.path.join(ROOT, "pacey", "vendor", "neat-annotations",
                    "neat-annotations.css")
LIC = os.path.join(ROOT, "pacey", "vendor", "neat-annotations", "LICENSE")

html = open(INDEX, errors="ignore").read()
css = open(LANDING, errors="ignore").read()


class CapScan(HTMLParser):
    """Find figcaption.landing-feature-caption and capture their text."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.caps = []
        self._cur = None

    def handle_starttag(self, tag, attrs):
        if tag != "figcaption":
            return
        d = dict(attrs)
        if "landing-feature-caption" in d.get("class", "").split():
            self._cur = {"attrs": d, "text": []}

    def handle_data(self, data):
        if self._cur is not None:
            self._cur["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "figcaption" and self._cur is not None:
            self.caps.append(self._cur)
            self._cur = None


scan = CapScan()
scan.feed(html)
caps = scan.caps
if len(caps) != 6:
    FAILS.append(f"expected 6 landing-feature-caption figcaptions, "
                 f"found {len(caps)}")
for i, c in enumerate(caps, 1):
    cls = c["attrs"].get("class", "").split()
    for need in ("ann", "ann-no-mark", "landing-mobile-only"):
        if need not in cls:
            FAILS.append(f"caption {i}: missing class {need} in {cls}")
    if "data-note" in c["attrs"]:
        FAILS.append(f"caption {i}: unexpected data-note attr — the real "
                     f"text is the label")
    if not "".join(c["text"]).strip():
        FAILS.append(f"caption {i}: empty caption text")
    if "<svg" in "".join(c["text"]):
        FAILS.append(f"caption {i}: still contains an svg child")

if "landing-caption-arrow" in html:
    FAILS.append("index.html still references landing-caption-arrow")

# exact direction + modifier sequence in document order
WANT_SEQ = [
    ("ann-nw", "landing-caption--readiness"),
    ("ann-ne", "landing-caption--trends"),
    ("ann-n", "landing-caption--course"),
    ("ann-ne", "landing-caption--picture"),
    ("ann-nw", "landing-caption--plan"),
    ("ann-n", "landing-caption--recap"),
]
if len(caps) == len(WANT_SEQ):
    for i, (cap, (direction, modifier)) in enumerate(
            zip(caps, WANT_SEQ), 1):
        cls = cap["attrs"].get("class", "").split()
        if direction not in cls:
            FAILS.append(f"caption {i}: direction {direction} missing "
                         f"(has {cls})")
        if modifier not in cls:
            FAILS.append(f"caption {i}: modifier {modifier} missing")
        extra = [d for d in ("ann-nw", "ann-ne", "ann-n")
                 if d in cls and d != direction]
        if extra:
            FAILS.append(f"caption {i}: stray directions {extra}")

# --- stylesheet wiring -----------------------------------------------------
def link_pos(href):
    m = re.search(r'<link[^>]*href="[^"]*' + re.escape(href) + r'"', html)
    return m.start() if m else -1


vpos = link_pos("vendor/neat-annotations/neat-annotations.css")
lpos = link_pos("pacey-landing.css")
if vpos < 0:
    FAILS.append("vendor neat-annotations.css link missing from head")
elif lpos < 0 or vpos > lpos:
    FAILS.append("vendor stylesheet must load BEFORE pacey-landing.css")

# --- vendor files ----------------------------------------------------------
for p, what in ((VEND, "vendored css"), (LIC, "MIT LICENSE")):
    if not os.path.isfile(p):
        FAILS.append(f"missing {what}: {p}")
if os.path.isfile(VEND):
    v = open(VEND, errors="ignore").read()
    for needle in (".ann {", ".ann-nw::before", "@media (forced-colors:",
                   ".ann:not([data-note])::before"):
        if needle not in v:
            FAILS.append(f"vendored css missing upstream rule {needle!r}")
if os.path.isfile(LIC):
    if "MIT License" not in open(LIC, errors="ignore").read():
        FAILS.append("vendor LICENSE is not MIT")

# --- pacey-landing.css structure -------------------------------------------
# desktop guard outside any media block
pre_media = css.split("@media (max-width: 46rem)")[0]
if not re.search(r"\.landing-feature-caption\.ann\s*\{[^}]*display:\s*none",
                 pre_media):
    FAILS.append("desktop guard '.landing-feature-caption.ann{display:none}'"
                 " missing outside the media block")

# media block contents
media = css.split("@media (max-width: 46rem)", 1)[1] \
    if "@media (max-width: 46rem)" in css else ""
block = re.search(
    r"\.landing-feature-caption\.ann\s*\{([^}]*)\}", media)
if not block:
    FAILS.append("no .landing-feature-caption.ann rule inside ≤46rem block")
else:
    body = block.group(1)
    for needle in ("display: block",
                   "width: var(--landing-caption-width, 70%)",
                   "margin-top: var(--pacey-space-lg)",
                   "text-align: left", "font-family: var(--font-caveat)",
                   "--ann-color: var(--pacey-board-copy)",
                   "--ann-mark: transparent", "--ann-rotate: 0deg",
                   "box-shadow: none", "border-radius: 0"):
        if needle not in body:
            FAILS.append(f"caption rule missing {needle!r}")

base_before = re.search(
    r"\.landing-feature-caption\.ann::before\s*\{([^}]*)\}", media)
if not base_before:
    FAILS.append("no ::before base override inside ≤46rem block")
else:
    for needle in ("display: block",
                   "transform: rotate(var(--landing-arrow-tilt, 0deg))"):
        if needle not in base_before.group(1):
            FAILS.append(f"::before base missing {needle!r}")

# per-direction geometries — each ::before flips the stock placement
DIRECTION_RULES = {
    "ann-nw": ("margin-inline-start: auto", "margin-inline-end: 0"),
    "ann-ne": ("margin-inline-start: 0", "margin-inline-end: auto"),
    "ann-n": ("margin-inline: auto",
              "margin-top: calc(var(--pacey-space-md) + 38px)",
              "text-align: center"),
}
for direction in ("ann-nw", "ann-ne", "ann-n"):
    rule = re.search(
        r"\.landing-feature-caption\.ann\." + direction +
        r"\s*\{([^}]*)\}", media)
    if not rule:
        FAILS.append(f"no {direction} element rule in media block")
        continue
    body = rule.group(1)
    for needle in DIRECTION_RULES[direction]:
        if needle not in body:
            FAILS.append(f"{direction} rule missing {needle!r}")
    bef = re.search(
        r"\.landing-feature-caption\.ann\." + direction +
        r"::before\s*\{([^}]*)\}", media)
    if not bef:
        FAILS.append(f"no {direction}::before rule in media block")
        continue
    body = bef.group(1)
    if direction == "ann-nw":
        need = ("left: auto", "right: calc(100% + 8px)", "top: 0",
                "bottom: auto")
    elif direction == "ann-ne":
        need = ("right: auto", "left: calc(100% + 8px)", "top: 0",
                "bottom: auto")
    else:  # ann-n — straight arrow above the centered note
        need = ("top: auto", "bottom: calc(100% + 4px)",
                "left: calc(50% - 23px)", "right: auto")
    for needle in need:
        if needle not in body:
            FAILS.append(f"{direction}::before missing {needle!r}")

# per-caption variation props
MODIFIERS = {
    "readiness": ("70%", "-5deg"), "trends": ("68%", "4deg"),
    "course": ("72%", "-3deg"), "picture": ("70%", "-4deg"),
    "plan": ("69%", "3deg"), "recap": ("71%", "4deg"),
}
for name, (width, tilt) in MODIFIERS.items():
    rule = re.search(
        r"\.landing-caption--" + name + r"\s*\{([^}]*)\}", media)
    if not rule:
        FAILS.append(f"no .landing-caption--{name} rule in media block")
        continue
    body = rule.group(1)
    if f"--landing-caption-width: {width}" not in body:
        FAILS.append(f"--{name}: width {width} missing")
    if f"--landing-arrow-tilt: {tilt}" not in body:
        FAILS.append(f"--{name}: tilt {tilt} missing")

after = re.search(
    r"\.landing-feature-caption\.ann::after\s*\{([^}]*)\}", media)
if not after or "display: none" not in after.group(1):
    FAILS.append("::after must be display:none (no attr(data-note) "
                 "duplicate)")

if "landing-caption-arrow" in css:
    FAILS.append("pacey-landing.css still contains .landing-caption-arrow")

# brace balance on both sheets
for name, text in (("pacey-landing.css", css),
                   ("neat-annotations.css",
                    open(VEND, errors="ignore").read()
                    if os.path.isfile(VEND) else "")):
    if text.count("{") != text.count("}"):
        FAILS.append(f"{name}: unbalanced braces "
                     f"{text.count('{')}/{text.count('}')}")

print(f"captions: {len(caps)} ann-annotated")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
