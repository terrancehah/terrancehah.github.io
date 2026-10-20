#!/usr/bin/env python3
"""Offline regression check for the teaching-syllabus-template page.

Locks in the semantic/typography refresh of
projects/teaching-syllabus-template/index.html + its page stylesheet:

  * one h1, no forced <br>, no heading disguised as a paragraph
    (the intro lede and cross-link note are real <p> elements; the only
    h3s are the three FAQ questions)
  * exactly seven h2 — five features + pricing + FAQ
  * the page stylesheet is linked exactly once; the duplicate direct
    site-footer/site-header links are gone
  * all six screenshots keep their src/srcset/width/height; the
    overview hero is eager + fetchpriority=high, the five feature
    screenshots stay lazy
  * the Stripe buy-button id/key are frozen — it is a live checkout
    element and must never be edited
  * no utility class recipes remain inside <main>
  * the stylesheet consumes shared --site-text-*/--site-leading-*
    tokens, the 44px action targets, :focus-visible, min-width:0 grid
    safety and the >=56rem feature/pricing grids
  * CSS braces/parens stay balanced

Run:  python3 tests/check-teaching-syllabus-template.py   (from repo root)
"""

import os
import re
import sys
from html.parser import HTMLParser

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(REPO, "projects/teaching-syllabus-template/index.html")
CSS = os.path.join(REPO,
                   "projects/teaching-syllabus-template/"
                   "teaching-syllabus-template.css")
CSS_HREF = ("/projects/teaching-syllabus-template/"
            "teaching-syllabus-template.css")
FAILS = []

html = open(PAGE, errors="ignore").read()
css = open(CSS, errors="ignore").read()


class Scan(HTMLParser):
    """Collects headings, imgs and classes inside <main>, tracking the
    enclosing section class so intro/FAQ roles can be checked."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_main = False
        self.headings = []        # (tag, text, classes, section)
        self.imgs = []            # attrs dict, in document order
        self.anchors = []         # attrs dict, in document order
        self.classes = []         # every class attr inside main
        self._h = None            # open heading accumulator
        self._section = ""
        self._stack = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "main":
            self.in_main = True
        if not self.in_main:
            return
        self.classes.append(cls)
        if tag in ("section", "figure"):
            self._section = cls
        if tag == "img":
            self.imgs.append(a)
        if tag == "a":
            self.anchors.append(a)
        if tag in ("h1", "h2", "h3"):
            self._h = [tag, "", cls]
        self._stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if self._h is not None:
            self._h[1] += data

    def handle_endtag(self, tag):
        if tag == "main":
            self.in_main = False
        if tag in ("section", "figure"):
            self._section = ""
        if tag in ("h1", "h2", "h3") and self._h is not None:
            self.headings.append(
                (self._h[0], " ".join(self._h[1].split()),
                 self._h[2], self._section))
            self._h = None


scan = Scan()
scan.feed(html)

# --- headings -------------------------------------------------------------
h1 = [t for tg, t, _, _ in scan.headings if tg == "h1"]
if h1 != ["Notion Teaching Syllabus Planner"]:
    FAILS.append(f"h1 wrong: {h1}")
h1_frag = re.search(r"<h1\b[^>]*>(.*?)</h1>", html, re.S)
if h1_frag and "<br" in h1_frag.group(1):
    FAILS.append("h1 still carries a forced <br>")

h2s = [(t, s) for tg, t, _, s in scan.headings if tg == "h2"]
if len(h2s) != 7:
    FAILS.append(f"expected 7 h2 (5 features + pricing + faq), got {len(h2s)}")
if sum(1 for _, s in h2s
       if "syllabus-feature" in s.split()) != 5:
    FAILS.append("feature h2 count != 5")
# exactly features 2 and 4 carry the desktop-alternating modifier
n_rev = len(re.findall(r'class="[^"]*\bsyllabus-feature--reverse\b',
                       html))
if n_rev != 2:
    FAILS.append(f"expected 2 .syllabus-feature--reverse, got {n_rev}")
# every feature is a named group: section aria-labelledby → its h2 id
for fid in ("syllabus-feature-calendar", "syllabus-feature-lesson",
            "syllabus-feature-list", "syllabus-feature-sharing",
            "syllabus-feature-covers"):
    if f'id="{fid}"' not in html or \
            f'aria-labelledby="{fid}"' not in html:
        FAILS.append(f"feature missing labelled group {fid}")

# intro copy — lede + the paragraph underneath
for needle in ("A Notion planner for tutors and educators, with your",
               "See upcoming classes in the calendar, prepare each"):
    if needle not in html:
        FAILS.append(f"intro copy missing: {needle[:40]}")

h3s = [(t, s) for tg, t, _, s in scan.headings if tg == "h3"]
if len(h3s) != 7 or not all(s == "syllabus-faq" for _, s in h3s):
    FAILS.append(f"expected exactly 7 FAQ h3s, got {h3s}")
# intro keeps its h1, but neither intro nor crosslink may use h2/h3
# as disguised paragraphs
if any(tg != "h1" and s in ("syllabus-intro", "syllabus-crosslink")
       for tg, _, _, s in scan.headings):
    FAILS.append("intro/crosslink still uses a heading for prose")
if "<br" in re.search(r'syllabus-crosslink.*?</section>', html,
                     re.S).group(0):
    FAILS.append("cross-link paragraph still carries a forced <br>")

# --- faq drawer structure ----------------------------------------------------
# every drawer ships open so no-JS readers see every answer; the page
# script injects the toggle buttons and collapses them after binding
faq_block = re.search(r'syllabus-faq-list.*?</section>', html, re.S)
if not faq_block:
    FAILS.append("no .syllabus-faq-list block")
else:
    fb = faq_block.group(0)
    if len(re.findall(r'class="syllabus-faq-item"', fb)) != 7:
        FAILS.append("expected 7 .syllabus-faq-item")
    if len(re.findall(r'class="syllabus-faq-panel is-open"', fb)) != 7:
        FAILS.append("expected 7 panels shipped .is-open")
    if len(re.findall(r'class="syllabus-faq-panel-inner"', fb)) != 7:
        FAILS.append("expected 7 .syllabus-faq-panel-inner")
    if len(re.findall(r'id="syllabus-faq-panel-\d"', fb)) != 7:
        FAILS.append("faq panels missing stable ids for aria-controls")
    if "hidden" in fb:
        FAILS.append("faq markup uses hidden — breaks the drawer animation")
    # real questions as plain h3 text — the button is injected at runtime
    if "<button" in fb:
        FAILS.append("faq toggle button must be JS-injected, not authored")
    for q in ("Do I need a Notion account?",
              "What is included in the template?",
              "How do I add the template to my workspace?",
              "Can I use it on desktop and mobile?",
              "Can I adapt it to my teaching style?",
              "Can I plan lessons with colleagues?",
              "Is this a subscription?"):
        if q not in fb:
            FAILS.append(f"faq question missing: {q}")

# --- intro actions -----------------------------------------------------------
if "syllabus-action--secondary" in html:
    FAILS.append("removed secondary action is still in the markup")
if html.count('href="#pricing"') != 1 or "Get the template" not in html:
    FAILS.append("primary #pricing action missing/duplicated")
if 'href="#template-preview"' in html:
    FAILS.append("stale #template-preview anchor still linked")

# --- scripts / opt-ins -------------------------------------------------------
if not re.search(r'<main[^>]*data-reading-progress', html):
    FAILS.append("<main> missing data-reading-progress")
if html.count('src="/js/article-reading.js"') != 1 or \
        'src="/js/article-reading.js" defer' not in html:
    FAILS.append("article-reading.js not included exactly once with defer")
if len(re.findall(r'src="[^"]*teaching-syllabus-template\.js"', html)) \
        != 1 or not re.search(
            r'src="[^"]*teaching-syllabus-template\.js"\s*defer', html):
    FAILS.append("page script not included exactly once with defer")
if html.count('src="/js/site-image-viewer.js"') != 1 or \
        'src="/js/site-image-viewer.js" defer' not in html:
    FAILS.append("site-image-viewer.js not included once with defer")
if len(re.findall(r'href="[^"]*site-reading-progress\.css"', html)) != 1:
    FAILS.append("site-reading-progress.css not linked exactly once")
if len(re.findall(r'href="[^"]*site-image-viewer\.css"', html)) != 1:
    FAILS.append("site-image-viewer.css not linked exactly once")

# --- stylesheet links ------------------------------------------------------
if len(re.findall(r'href="[^"]*site-footer\.css"', html)) != 1:
    FAILS.append("site-footer.css link count != 1 (duplicate survived?)")
if len(re.findall(r'href="[^"]*site-header\.css"', html)) != 1:
    FAILS.append("site-header.css link count != 1 (duplicate survived?)")
if len(re.findall(re.escape(CSS_HREF), html)) != 1:
    FAILS.append("page stylesheet link missing or duplicated")

# --- body/main semantics + utility residue ---------------------------------
if 'class="syllabus-page"' not in html:
    FAILS.append("<body> missing .syllabus-page")
if not re.search(r'<main\s+class="syllabus-main"', html):
    FAILS.append("<main> missing .syllabus-main")
bad = [c for c in scan.classes
       if re.search(r"(font-|text-|sm:|md:|lg:|xl:|shadow|rounded|"
                    r"\b[mp][xytblr]?-\d|mx-auto|w-\d|flex|space-|"
                    r"bg-white|list-|items-|justify-|gap-|leading-)",
                    c or "")]
if bad:
    FAILS.append(f"utility classes still inside <main>: {bad[:4]}")

# --- images -----------------------------------------------------------------
# feature screenshots sit in a ~60vw column that tops out near 640px
# inside the 72rem shell — distinct from the 960px-wide overview hero
FEATURE_SIZES = ("(min-width: 72rem) 640px, (min-width: 56rem) 60vw, "
                 "calc(100vw - 2rem)")
EXPECTED = [
    ("notion-front-page-png-1920.webp", "1920", "1280"),
    ("notion-calendar-view-page-png-1920.webp", "1920", "1440"),
    ("lesson-plan-page-png-1920.webp", "1920", "1440"),
    ("notion-class-lesson-list-png-1920.webp", "1920", "1440"),
    ("notion-sharing-png-1920.webp", "1920", "1440"),
    ("customised-cover-pictures-png-1920.webp", "1920", "1440"),
]
if len(scan.imgs) != len(EXPECTED):
    FAILS.append(f"expected 6 main imgs, found {len(scan.imgs)}")
for i, ((base, w, h), a) in enumerate(zip(EXPECTED, scan.imgs)):
    if base not in a.get("src", ""):
        FAILS.append(f"img #{i}: src changed ({a.get('src', '')[:60]})")
        continue
    if a.get("width") != w or a.get("height") != h:
        FAILS.append(f"{base}: dims {a.get('width')}x{a.get('height')}")
    if not a.get("srcset") or "1280.webp 1280w" not in a["srcset"]:
        FAILS.append(f"{base}: srcset lost")
    if i == 0:
        if a.get("loading") != "eager" or \
                a.get("fetchpriority") != "high" or \
                a.get("decoding") != "async":
            FAILS.append("overview hero not eager/high/async")
        if a.get("sizes") != \
                "(max-width: 767px) calc(100vw - 2rem), 960px":
            FAILS.append("overview hero sizes changed")
        if 'id="template-preview"' not in html or \
                "syllabus-overview" not in html:
            FAILS.append("overview figure missing #template-preview")
    else:
        if a.get("loading") != "lazy" or a.get("decoding") != "async":
            FAILS.append(f"{base}: feature screenshot not lazy/async")
        if a.get("fetchpriority"):
            FAILS.append(f"{base}: unexpected fetchpriority")
        if a.get("sizes") != FEATURE_SIZES:
            FAILS.append(f"{base}: sizes {a.get('sizes')!r}")
    # alt must be a real description, not the old filename slug
    if re.fullmatch(r"[a-z0-9-]+", a.get("alt", "")):
        FAILS.append(f"{base}: alt is still a filename ({a.get('alt')})")

# --- gallery anchors ---------------------------------------------------------
# each screenshot is wrapped in a link to its preserved full-res
# original — the shared viewer intercepts the click when <dialog> works,
# otherwise the anchor still navigates natively
links = [a for a in scan.anchors
         if "syllabus-image-link" in a.get("class", "").split()]
if len(links) != len(EXPECTED):
    FAILS.append(f"expected {len(EXPECTED)} .syllabus-image-link "
                 f"anchors, got {len(links)}")
for (base, _, _), a, link in zip(EXPECTED, scan.imgs, links):
    original = re.sub(r"-\d+\.webp$", "", base)
    original = original.removesuffix("-png") + ".png"
    href = ("/resources/projects/teaching-syllabus-template/"
            + original)
    if link.get("href") != href:
        FAILS.append(f"{base}: image link href {link.get('href')!r}")
    if not (link.get("aria-label") or "").startswith("Enlarge"):
        FAILS.append(f"{base}: image link missing Enlarge aria-label")
    if "data-gallery-image" not in a:
        FAILS.append(f"{base}: img missing data-gallery-image")
    if a.get("data-full-src") != href:
        FAILS.append(f"{base}: data-full-src {a.get('data-full-src')!r}")
    # no invented caption attribute — the viewer captions the feature
    # shots from their section's aria-labelledby heading and the
    # overview from its existing figcaption
    if "data-gallery-caption" in a:
        FAILS.append(f"{base}: invented data-gallery-caption still "
                     "present")
    if not os.path.isfile(os.path.join(REPO, href.lstrip("/"))):
        FAILS.append(f"{base}: original file missing on disk {href}")

# --- Stripe widget frozen ----------------------------------------------------
STRIPE = ('buy-button-id="buy_btn_1N84o8I41yHwVfoxr37OISZv"',
          'publishable-key="pk_live_51MtLXgI41yHwVfoxoenCC4Y3iWAv4dwTMP'
          'FtBsuAWnJItf6KjcLgtClHE281ixQp5j7tQdmHt9JCtyVSvGaVOI4N00AXx'
          '9Bg3a"',
          'class="stripe-buy-button"')
for needle in STRIPE:
    if needle not in html:
        FAILS.append(f"stripe attribute changed: {needle[:50]}")
if "js.stripe.com/v3/buy-button.js" not in html:
    FAILS.append("stripe buy-button script missing")

# --- stylesheet contract ------------------------------------------------------
for needle in ("../../styles/site-typography.css",
               # shared typography identity — families, weights and
               # sizes all arrive as tokens, like the articles
               "var(--site-font-heading)", "var(--site-font-prose)",
               "var(--site-font-nav)",
               "var(--site-weight-heading)",
               "var(--site-weight-subheading)",
               "var(--site-text-page-title)",
               "var(--site-text-section-title)",
               "var(--site-text-card-title)",
               "var(--site-text-body)",
               "var(--site-text-lede)",
               "var(--site-text-caption)",
               "var(--site-text-summary)",
               "var(--site-leading-heading)",
               "var(--site-leading-body)",
               "min-height: 44px",
               ":focus-visible",
               "min-width: 0",
               # gallery links to the full-res originals
               ".syllabus-image-link", "cursor: zoom-in",
               "grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr)",
               # the reverse modifier flips the feature tracks — the
               # anchor, not the img, is the grid child now
               ".syllabus-feature--reverse",
               ".syllabus-feature--reverse .syllabus-image-link",
               "grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr)",
               "grid-column: 2", "grid-row: 1",
               # single centered purchase panel holding the Stripe widget
               "max-width: 30rem", "max-width: 22rem",
               "width: fit-content", "text-align: center",
               ".syllabus-purchase-panel > .stripe-buy-button",
               "padding: clamp(1rem, 2vw, 2rem)",
               # mobile feature grouping — one tinted surface per feature
               "@media (max-width: 55.999rem)",
               "color-mix(in srgb", "border-radius: 8px",
               # faq drawers — animated via grid-rows, never display/hidden
               ".syllabus-faq-toggle", ".syllabus-faq-chevron",
               ".syllabus-faq-panel", "grid-template-rows: 0fr",
               ".syllabus-faq-panel.is-open", "grid-template-rows: 1fr",
               ".syllabus-faq-panel-inner", "overflow: hidden",
               "prefers-reduced-motion: reduce",
               # screenshot reveal — only armed via the JS-enabled class
               ".syllabus-reveals-enabled .syllabus-screenshot",
               "translateY(16px)", "opacity 350ms", "transform 450ms",
               "--syllabus-ink", "--syllabus-accent",
               "--syllabus-copy", "--syllabus-rule",
               "@media (min-width: 56rem)",
               "max-width: 65ch", "max-width: 60ch"):
    if needle not in css:
        FAILS.append(f"stylesheet missing {needle}")
if re.search(r"font-size\s*:\s*[\d.]+(px|rem)", css):
    FAILS.append("stylesheet declares a hard font-size off the scale")
# every font-family is a shared token — no literal faces slip back in
for lit in ("Lato", "Baskervville", "Raleway"):
    if lit in css:
        FAILS.append(f"stylesheet hardcodes the {lit} family")

# title and section title share the heading family but split on weight —
# h1 matches .article-title, h2 the subheading role
if not re.search(r"\.syllabus-title\s*\{[^}]*"
                 r"font-weight:\s*var\(--site-weight-heading\)", css):
    FAILS.append("syllabus title weight not the heading token")
if not re.search(r"\.syllabus-section-title\s*\{[^}]*"
                 r"font-weight:\s*var\(--site-weight-subheading\)", css):
    FAILS.append("section title weight not the subheading token")
# lede steps up in size and reads in ink for contrast
if not re.search(r"\.syllabus-lede\s*\{[^}]*"
                 r"font-size:\s*var\(--site-text-lede\)[^}]*"
                 r"color:\s*var\(--syllabus-ink\)", css):
    FAILS.append("lede not using the lede size + ink color")

# the reduced-motion block must neutralise an armed reveal state too —
# the JS teardown is the primary path, but CSS must not rely on it alone
reduce_block = css.split("prefers-reduced-motion: reduce", 1)[-1]
if "syllabus-reveals-enabled" not in reduce_block or \
        "opacity: 1" not in reduce_block or \
        "transform: none" not in reduce_block:
    FAILS.append("reduce block lacks enabled-screenshot fallback")


def media_block(css_text, needle):
    """Return the balanced-brace body of the first @media block whose
    header contains `needle` ("" when absent)."""
    i = css_text.find(needle)
    if i < 0:
        return ""
    j = css_text.find("{", i)
    depth = 0
    for k in range(j, len(css_text)):
        depth += css_text[k] == "{"
        depth -= css_text[k] == "}"
        if depth == 0:
            return css_text[j:k]
    return ""


# the hidden reveal rule only exists inside a no-preference media block —
# ungated it would outrank the reduce fallback by specificity
HIDDEN_RULE = ".syllabus-reveals-enabled .syllabus-screenshot:not(.is-visible)"
np_block = media_block(css, "@media (prefers-reduced-motion: no-preference)")
if css.count(HIDDEN_RULE) != 1 or HIDDEN_RULE not in np_block:
    FAILS.append("hidden reveal rule not gated to no-preference")
reduce_body = media_block(css, "@media (prefers-reduced-motion: reduce)")
if HIDDEN_RULE in reduce_body:
    FAILS.append("hidden reveal rule leaked into the reduce block")

# faq questions read at regular weight — toggle AND no-JS h3 fallback
for sel in (r"\.syllabus-faq-toggle\s*\{[^}]*font-weight:\s*400",
            r"\.syllabus-faq-question\s*\{[^}]*font-weight:\s*400",
            r"\.syllabus-faq-question\s*\{[^}]*font-size:\s*"
            r"var\(--site-text-card-title\)"):
    if not re.search(sel, css):
        FAILS.append(f"faq question styling missing {sel[:50]}")

# cross-link: named anchors, same tab (no target=_blank)
cross = re.search(r'syllabus-crosslink.*?</section>', html, re.S)
if cross:
    cb = cross.group(0)
    if 'href="/travel-rizz.html"' not in cb or 'href="/pacey"' not in cb:
        FAILS.append("cross-link missing travel/pacey anchors")
    if "Travel-Rizz, a travel itinerary planner" not in cb or \
            "Pacey, a race-training companion" not in cb:
        FAILS.append("cross-link anchor text not descriptive")
    if 'target="_blank"' in cb:
        FAILS.append("cross-link should open in the same tab")

# brace/paren balance
d = mn = pa = 0
for c in css:
    d += c == "{"
    d -= c == "}"
    mn = min(mn, d)
    pa += c == "("
    pa -= c == ")"
if d or mn < 0 or pa:
    FAILS.append(f"stylesheet unbalanced (depth {d}, min {mn}, parens {pa})")

if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("ALL PASS")
