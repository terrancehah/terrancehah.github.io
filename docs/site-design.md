# Site design — implementation reference

Factual map of the personal site's shared UI systems as of
**16 October 2026**. Design intent lives in [`.impeccable.md`](../.impeccable.md);
this file records where each behavior is implemented and how to verify it.
For product-specific rules see [Pacey](../pacey/PRODUCT.md) and
[Biwa](../projects/biwa-ride/AGENTS.md) — those are separate products with
their own design systems and are out of scope here.

## Scope

The audience is unrestricted — anyone can visit. The site's character is
typography- and photography-led: a quiet editorial layout in navy and paper
tones where photos and handwriting accents carry the personality. This
document covers the shared header, footer, type scale, motion, image
pipeline, and the 25 pages that load `js/footer.js`. It does not cover
Pacey, Biwa, `.archive/` pages, or self-contained playground experiments,
which keep their own chrome.

## Component ownership

| System                           | Lives in                                                                      | Consumers                                            |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| Type scale (tokens only)         | `styles/site-typography.css`                                                  | imported by nav/footer/page sheets + linked in heads |
| Header layout                    | `styles/site-header.css`                                                      | 25 pages, semantic `.site-header` markup             |
| Navigation                       | `styles/site-navigation.css`                                                  | via `site-header.css`                                |
| Footer + back-to-top             | `js/footer.js`, `styles/site-footer.css`                                      | injected on the 25 footer.js pages                   |
| Motion (press, page transitions) | `styles/site-motion.css`                                                      | via `site-header.css`                                |
| Reading progress                 | `js/article-reading.js`                                                       | the 14 `articles/*.html` pages only                  |
| Listing styles                   | `articles/articles.css`, `projects/projects.css`, `playground/playground.css` | index + listing pages                                |
| Homepage                         | `styles/homepage.css`                                                         | `index.html`                                         |
| Image pipeline                   | `scripts/optimize-site-images.py`, `resources/optimized/` + `manifest.json`   | markup on the 25 pages                               |
| Public showcase                  | `articles/my-website-style-guide.html` + `articles/website-style-guide.css`   | linked from the articles page                        |

## Head loading

Each of the 25 pages links the same five shared sheets directly, in this
order (parallel download instead of an `@import` waterfall), then the
page's own utility/legacy/page stylesheets in whatever order that page
already used — a few legacy pages omit `styles/style.css` entirely and
`styles/output.css` (pre-generated utility CSS — no live Tailwind build)
is not universal either:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Baskervville:ital,wght@0,400;1,400&family=Caveat:wght@400;700&family=Lato:ital,wght@0,400;0,600;0,700;1,400&family=Raleway:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap"
  rel="stylesheet" />
<link href="./styles/site-typography.css" rel="stylesheet" />
<link href="./styles/site-footer.css" rel="stylesheet" />
<link href="./styles/site-navigation.css" rel="stylesheet" />
<link href="./styles/site-motion.css" rel="stylesheet" />
<link href="./styles/site-header.css" rel="stylesheet" />
```

One Google Fonts request covers the four faces — Baskervville 400/400i,
Caveat 400/700, Lato 400/600/700 + 400 italic, Raleway 300–700 + 400
italic. Exception: the style-guide article adds a second request for the
specimen faces it shows (Fuzzy Bubbles, Momo Trust Display, Quattrocento
Sans). `styles/style.css` and `styles/site-typography.css` keep matching
`@import` font URLs as a fallback for pages that link those sheets
directly; `site-header.css` itself `@import`s `site-navigation.css` then
`site-motion.css` for the same standalone-link compatibility.

## Typography

`styles/site-typography.css` is a `:root` token sheet — it declares
custom properties and no component/element styling, and it does not
override the root font size, so browser zoom keeps working. Roles:

| Token                       | Role                            | Value                    |
| --------------------------- | ------------------------------- | ------------------------ |
| `--site-font-nav`           | navigation face                 | `'Raleway', sans-serif`  |
| `--site-text-navigation`    | header + footer nav links       | `1rem` at every viewport |
| `--site-text-caption`       | dates, captions, credits        | `0.875rem`               |
| `--site-text-small`         | legal/notice text               | `0.8125rem`              |
| `--site-text-body`          | article body, hero descriptions | `1.125rem`               |
| `--site-text-summary`       | card descriptions               | `1rem`                   |
| `--site-text-card-title`    | listing card titles             | clamp ≈ 1.25–1.5rem      |
| `--site-text-feature-title` | listing hero titles             | clamp ≈ 1.5–2.25rem      |
| `--site-text-page-title`    | article titles                  | clamp ≈ 1.875–2.5rem     |
| `--site-text-section-title` | subtitles, section titles       | clamp ≈ 1.5–2rem         |
| `--site-text-brand`         | site name in header             | clamp ≈ 1.5–1.875rem     |
| `--site-text-display`       | homepage hero                   | clamp ≈ 2.5–4.5rem       |
| `--site-text-quote`         | pull quotes                     | clamp ≈ 1.5–2.25rem      |
| `--site-text-chapter-title` | homepage chapter headings       | clamp ≈ 2–3.5rem         |
| `--site-text-lede`          | homepage intro/transition text  | clamp ≈ 1.25–1.5rem      |
| `--site-text-tile-title`    | homepage photo-tile titles      | `1.125rem`               |
| `--site-leading-body`       | article paragraphs/lists        | `1.7`                    |
| `--site-leading-heading`    | headings                        | `1.25`                   |
| `--site-leading-nav`        | nav links                       | `1.5`                    |

Navigation is `1rem` — the browser-default 16px, scaling with the user's
zoom/root-size setting — in header and footer at every viewport; there is
no larger-desktop or smaller-mobile nav size.

## Header

All 25 pages share one structure:

```html
<header class="site-header">
  <div class="site-header-inner">
    <div class="site-header-brand">
      <h1 class="site-header-title">…</h1>
    </div>
    <nav class="site-nav" …>…</nav>
    <div class="site-social-links">…</div>
  </div>
</header>
```

Mobile/tablet is a centered column; at `min-width: 1024px` the inner
container becomes a three-column grid `minmax(0, 1fr) auto minmax(0, 1fr)`
— brand left, nav centered, socials right. Social links are ≥44px tap
targets around 28px icons. The homepage keeps its green header as a skin
override; the layout itself is shared.

Listing grids go single-column at `max-width: 639px`: article and project
`size-*` card classes collapse to auto placement. Playground
`.toy-card.size-*` classes still use fixed `span 2` tracks at ≤639px.

## Footer + back-to-top

`js/footer.js` injects the footer nav (with `aria-current` on the current
page) and the back-to-top button. Footer nav links are 16px with a 36px
tap target; at `max-width: 400px` inline padding halves to `0.25rem` so
the single row still fits 320px screens — the font size is not reduced.
Back-to-top is a fixed 44px button (8px radius, inline arrow-to-line SVG)
shown once `scrollY > innerHeight`; updates are rAF-coalesced. Focus is
moved to the first header nav link in two cases: when the button hides
_while it still has focus_ (a hidden element must not keep focus), and on
keyboard/AT activation (`detail === 0`), before the smooth scroll — a
pointer click leaves focus alone. `prefers-reduced-motion` switches the
scroll to instant. The button is navy by default; the homepage reskins it
green (`body.home-page` → `#447f46`, matching hover/focus overrides).

## Reading progress (articles only)

`js/article-reading.js` is included with `defer` only on the 14 article
pages. It injects a decorative (`aria-hidden`) fixed 3px bar at the top —
a `.article-reading-progress-fill` child that is a bare `scaleX`
transform (no transition, no inertia; color via
`--article-reading-progress-color`, default steel blue `#457b9d`). It
measures the `.article-content` element's rect, not the document, so the
bar hits 100% exactly when the article's last pixel reaches the viewport
bottom — the footer never counts. One rect read + one transform write per
rAF; updates triggered by passive scroll/resize, `pageshow` (bfcache),
image `load`/`error` (capture, filtered to `IMG`), `document.fonts.ready`,
and a `ResizeObserver` on the article.

## Motion

`styles/site-motion.css` is shared by all 25 pages:

- **Page transitions** — `@view-transition { navigation: auto }` inside
  `prefers-reduced-motion: no-preference`: cross-document same-origin
  navigations get an opacity-only root crossfade (`site-page-leave`
  120ms out, `site-page-enter` 180ms in, `mix-blend-mode: normal`). No
  translates, no named elements, no JS interception — this is not an SPA
  pattern; unsupported browsers simply ignore it. Under reduced motion
  `navigation: none` plus `::view-transition-group(*) { animation: none }`
  opt out explicitly.
- **Touch press** — under `(hover: none), (pointer: coarse)`,
  `:is(article, a).site-pressable:active` scales to `0.985` over 120ms.
  The `:is()` element raises specificity above the pages' `.card:active`
  rules. Every listing card/hero and homepage `.article-link` tile
  carries `site-pressable`. Reduced motion zeroes both properties.
- **Hover gating** — card lift/shadow/image-zoom rules in the four page
  sheets are wrapped in `(hover: hover) and (pointer: fine) and
(prefers-reduced-motion: no-preference)` so they never activate on
  touch or under reduced motion. Color-only hovers stay ungated.
- **Replays** — homepage scroll reveals (`.photo-fade`, typewriter)
  replay when scrolling back; that's an existing homepage choice, not a
  shared rule. Pacey's landing animations are one-shot by its own system.
- No loading skeletons are implemented — article text renders directly.

## Images

Markup policy (all 25 pages): the first hero image on each root listing
page is `loading="eager" fetchpriority="high" decoding="async"`; every
other main-content photo is `loading="lazy" decoding="async"`. Header
social icons and the `handwriting-crossout` ornament get optimized files
but no loading attributes. Local and explicitly-dimensioned external
images carry real `width`/`height` for aspect-ratio reservation; unknown
external dimensions are never guessed.

`scripts/optimize-site-images.py` (requires Pillow) generates
`resources/optimized/` webp derivatives and rewrites `<img>` markup —
originals are never modified and the tool never deletes files. Current
recipe (v3): candidates are local rasters ≥250KiB or longest edge >1920;
photo ladder 640/1280/1920 longest-edge with no upscale; `quality=72` for
JPEG/MPO sources, `85` for PNG sources, `method=6`; EXIF-transposed; ICC
converted to sRGB with original-profile fallback and the profile embedded
explicitly; PNG alpha and palette transparency preserved; MPO files are
treated as frame-0 stills (other multi-frame formats stay excluded).
Icons bypass the ladder — `site-social-icon` gets a single 128px variant,
other icon classes keep their source edge. A candidate is abandoned
entirely if its largest variant isn't smaller than the original.
`srcset` uses actual width descriptors; `sizes` is context-specific
(authoritative values in the script's `SIZES_*` constants). Gallery
viewers read `data-full-src` (the preserved original) before
`currentSrc`/`src`.

```bash
python3 scripts/optimize-site-images.py --check   # verify manifest + refs
python3 scripts/optimize-site-images.py --write   # regenerate + rewrite markup
```

## Verification

All checks are static/offline — no server, no Lighthouse, no rendering
claims:

```bash
python3 tests/check-site-images.py        # manifest integrity + markup refs
python3 tests/check-site-loading.py       # eager/lazy policy + transitions CSS
python3 tests/check-site-header.py        # shared header structure, 25 pages
python3 tests/check-site-typography.py    # token usage + coverage
python3 tests/check-article-reading.py    # progress-bar wiring + press classes
node tests/article-reading.test.js        # progress math, mocked DOM
```

## Analytics

Vercel Web Analytics (`/_vercel/insights/script.js`, `window.va`) remains.
Vercel Speed Insights (`/_vercel/speed-insights/`) was removed from all
tracked HTML. No Vercel dashboard or remote configuration was changed —
this is code-only.

## Remaining exceptions

Not everything on the site is normalized: older/legacy pages still carry
hardcoded sizes and utility-CSS headings, playground experiments keep
their own chrome, Pacey and Biwa follow their own product design systems,
and `.archive/` sits outside the shared scope. This document describes
the shared systems, not a claim of full-site compliance.
