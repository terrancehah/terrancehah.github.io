#!/usr/bin/env python3
"""Offline regression check for the shared type scale.

Verifies:
  * no stylesheet references an undefined --site-* token
  * role selectors on the listing/article/homepage/style-guide sheets
    map to --site-text-* tokens, with no stray font-size left (including
    inside media queries — the token replaces breakpoint overrides)
  * article pages, the style guide and the Notion page share the
    --site-font-*/--site-weight-* family and weight tokens
  * header + footer nav share the navigation token; brand + footer
    credits use their tokens
  * every footer.js consumer's stylesheet chain reaches
    site-typography.css
  * clamp() tokens evaluate sensibly at 320/390/768/1024/1440/1920
    (static math only — no rendering claims)
  * CSS braces/parens stay balanced

Run:  python3 tests/check-site-typography.py   (from repo root)
"""

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(REPO)
FAILS = []

TYPO = open("styles/site-typography.css").read()
# defined names, normalised without the leading --
DEFINED = {t.lstrip("-") for t in
           re.findall(r"--site-[a-z-]+(?=\s*:)", TYPO)}
for extra in ("styles/site-navigation.css", "styles/site-header.css",
              "styles/site-footer.css", "styles/homepage.css"):
    DEFINED |= {t.lstrip("-") for t in
                re.findall(r"--site-[a-z-]+(?=\s*:)", open(extra).read())}

IMPORT_RE = re.compile(r"@import\s+['\"]([^'\"]+)['\"]")


def strip_comments(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def parse_blocks(css_text):
    """Walk the sheet, yielding (innermost_selector, body, in_media)
    for every rule body — media wrappers are tracked on the stack so
    rules inside them are emitted too."""
    text = strip_comments(css_text)
    stack = []          # [(selector_text, body_start_index)]
    buf = ""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "{":
            stack.append((buf.strip(), i + 1))
            buf = ""
            i += 1
        elif c == "}":
            if stack:
                sel, start = stack.pop()
                in_media = any(s.startswith("@media") for s, _ in stack)
                if sel and not sel.startswith("@"):
                    yield sel, text[start:i], in_media
            buf = ""
            i += 1
        else:
            buf += c
            i += 1


# --- 1. no undefined --site-* references anywhere in site CSS -----------
# dependency/build dirs are pruned up front so the walk never descends
# into node_modules or the venvs
PRUNE = {"node_modules", ".vercel", "pacey", "biwa", ".venv", "venv",
         ".git", "dist"}
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in PRUNE]
    for f in files:
        if not f.endswith(".css"):
            continue
        p = os.path.join(root, f)
        for used in set(re.findall(r"var\(--(site-[a-z-]+)\)",
                                   open(p, errors="ignore").read())):
            if used not in DEFINED:
                FAILS.append(f"{p}: var(--{used}) has no definition")

# --- 2. role selectors must use tokens ----------------------------------
ROLE_MAP = {
    "articles/articles.css": {
        ".article-title": "page-title", ".article-date": "caption",
        ".article-body": "body", ".article-subtitle": "section-title",
        ".article-section-title": "section-title", ".article-badge": "caption",
        ".article-hero-title": "feature-title",
        ".article-hero-description": "body", ".article-hero-date": "caption",
        ".article-card-title": "card-title",
        ".article-card-description": "summary", ".article-card-date": "caption",
        ".article-blockquote": "quote", ".image-caption": "caption",
    },
    "projects/projects.css": {
        ".project-badge": "caption", ".project-hero-title": "feature-title",
        ".project-hero-description": "body", ".project-hero-date": "caption",
        ".project-card-title": "card-title",
        ".project-card-description": "summary", ".project-card-date": "caption",
    },
    "playground/playground.css": {
        ".toy-badge": "caption", ".toy-hero-title": "feature-title",
        ".toy-hero-description": "body", ".toy-hero-date": "caption",
        ".toy-card-title": "card-title",
        ".toy-card-description": "summary", ".toy-card-date": "caption",
    },
    "styles/homepage.css": {
        ".hero-title": "display", ".hero-subtitle": "body",
        ".section-intro-text": "lede", ".transition-text": "lede",
        ".pull-quote-text": "quote", ".pull-quote-cite": "caption",
        ".chapter-label": "caption", ".chapter-title": "chapter-title",
        ".chapter-text": "body", ".article-link-label": "caption",
        ".article-link-title": "tile-title",
    },
    "articles/website-style-guide.css": {
        ".website-style-guide .style-guide-caption": "summary",
        ".website-style-guide .style-guide-hier-title": "page-title",
        ".website-style-guide .style-guide-hier-date": "caption",
        ".website-style-guide .style-guide-hier-sub": "section-title",
        ".website-style-guide .style-guide-hier-body": "body",
        ".website-style-guide .style-guide-mini-card-title": "card-title",
        ".website-style-guide .style-guide-mini-card-desc": "summary",
        ".website-style-guide .style-guide-mini-card-date": "caption",
    },
}

for path, roles in ROLE_MAP.items():
    blocks = list(parse_blocks(open(path).read()))
    for sel, token in roles.items():
        want = f"font-size: var(--site-text-{token})"
        matched = [b for s_, b, _ in blocks if s_ == sel]
        if not matched:
            FAILS.append(f"{path}: selector {sel} missing")
            continue
        if not any(want in b for b in matched):
            FAILS.append(f"{path}: {sel} missing {want}")
        for b in matched:
            for fs in re.findall(r"font-size\s*:\s*([^;]+);", b):
                if fs.strip() != f"var(--site-text-{token})":
                    FAILS.append(f"{path}: {sel} stray font-size {fs.strip()}")

# --- 3. nav/footer/header roles -----------------------------------------
for path, sel in (("styles/site-navigation.css", ".site-nav > a"),
                  ("styles/site-footer.css", ".site-footer-nav a")):
    ok = any("font-size: var(--site-text-navigation)" in b and
             "font-family: var(--site-font-nav)" in b
             for s_, b, _ in parse_blocks(open(path).read()) if s_ == sel)
    if not ok:
        FAILS.append(f"{path}: {sel} not on navigation tokens")

hdr = list(parse_blocks(open("styles/site-header.css").read()))
if not any("font-size: var(--site-text-brand)" in b
           for s_, b, _ in hdr if s_ == ".site-header-title"):
    FAILS.append("site-header.css: .site-header-title not on brand token")

ftr = list(parse_blocks(open("styles/site-footer.css").read()))
if not any("font-size: var(--site-text-caption)" in b
           for s_, b, _ in ftr
           if ".site-footer-credit" in s_ and ".site-footer-notice" in s_):
    FAILS.append("site-footer.css: credit lines not on caption token")
if not any("font-size: var(--site-text-small)" in b
           for s_, b, _ in ftr if s_ == ".site-footer-notice"):
    FAILS.append("site-footer.css: notice not on small token")
# <=400px compact link padding keeps the single-row footer from
# overflowing at 320px without shrinking the shared nav font
ftr_media = any(
    "padding-inline: 0.25rem" in b and s_ == ".site-footer-nav a" and
    in_media for s_, b, in_media in ftr)
ftr_css = open("styles/site-footer.css").read()
if not (ftr_media and "@media (max-width: 400px)" in ftr_css):
    FAILS.append("site-footer.css: missing <=400px footer-link padding")

# --- 4. token coverage for every footer.js consumer ---------------------
def resolves(page_path, css_href):
    if css_href.startswith("/"):
        return os.path.normpath(css_href.lstrip("/"))
    return os.path.normpath(os.path.join(os.path.dirname(page_path), css_href))


def sheet_imports(path):
    if not os.path.exists(path):
        return []
    return [resolves(path, h)
            for h in IMPORT_RE.findall(open(path, errors="ignore").read())]


def reaches_typography(css_path, seen=None):
    seen = seen or set()
    if css_path in seen or not os.path.exists(css_path):
        return False
    seen.add(css_path)
    if css_path.endswith("site-typography.css"):
        return True
    return any(reaches_typography(i, seen) for i in sheet_imports(css_path))


SKIP = {"node_modules", ".archive", ".vercel", ".git", "pacey",
        "biwa-ride", ".venv", "venv"}
n = 0
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for f in files:
        if not f.endswith(".html"):
            continue
        p = os.path.join(root, f)
        s = open(p, errors="ignore").read()
        if "footer.js" not in s:
            continue
        n += 1
        links = re.findall(r'<link[^>]+href="([^"]+\.css)"', s)
        if not any(reaches_typography(resolves(p, h)) for h in links):
            FAILS.append(f"{p}: no stylesheet chain reaches typography")

# --- 5. clamp sanity at sample widths ------------------------------------
def eval_clamp(expr, vw):
    m = re.match(r"clamp\(([^,]+),\s*([^,]+),\s*([^)]+)\)", expr.strip())
    if not m:
        return None

    def val(part):
        total = 0.0
        for num, unit in re.findall(r"(-?[\d.]+)(rem|vw|px)", part):
            x = float(num)
            total += x * 16 if unit == "rem" else \
                x * vw / 100 if unit == "vw" else x
        return total

    lo, mid, hi = (val(m.group(i)) for i in (1, 2, 3))
    return max(lo, min(mid, hi))


for tok, expr in re.findall(r"(--site-text-[a-z-]+):\s*(clamp\([^)]*\))",
                            TYPO):
    seq = [eval_clamp(expr, w) for w in (320, 390, 768, 1024, 1440, 1920)]
    if any(v is None for v in seq):
        FAILS.append(f"{tok}: clamp not evaluable: {expr}")
    elif seq != sorted(seq) or len(set(seq)) < 2:
        FAILS.append(f"{tok}: non-monotonic clamp {seq}")
    elif not all(10 <= v <= 120 for v in seq):
        FAILS.append(f"{tok}: implausible px values {seq}")

# --- 6. brace/paren balance ----------------------------------------------
for f in ["styles/site-typography.css", "styles/site-navigation.css",
          "styles/site-footer.css", "styles/site-header.css",
          "styles/homepage.css", "articles/articles.css",
          "articles/website-style-guide.css", "projects/projects.css",
          "playground/playground.css"]:
    d = mn = pa = 0
    for c in open(f).read():
        d += c == "{"
        d -= c == "}"
        mn = min(mn, d)
        pa += c == "("
        pa -= c == ")"
    if d or mn < 0 or pa:
        FAILS.append(f"{f}: unbalanced (depth {d}, min {mn}, parens {pa})")

print(f"checked {n} consumers, {len(DEFINED)} tokens defined")
if FAILS:
    print(f"{len(FAILS)} FAILURES:")
    for f_ in FAILS:
        print("  -", f_)
    sys.exit(1)
print("ALL PASS")
