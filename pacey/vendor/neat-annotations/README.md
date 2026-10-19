# Vendored: neat-annotations

Hand-drawn CSS annotations (arrows + handwritten labels) by Maxim Syabro.

- Upstream: [neat-annotations](https://github.com/syabro/neat-annotations)
- Pinned at commit `12fabf0f5b2e13b9ce884f5b0d9442c1c75a594e` (main, fetched 19 October 2026)
- License: MIT (see `LICENSE` in this directory)
- Files are vendored unmodified. Usage on the landing page: mobile
  `.landing-feature-caption` elements carry `ann ann-no-mark` plus a
  mixed direction (`ann-nw`, `ann-ne`, `ann-n` — deliberate per-caption
  variety) and a `landing-caption--*` modifier for small width/tilt
  offsets; the site adaptations live in `pacey/pacey-landing.css` inside
  the `max-width: 46rem` block (arrows flipped to a side gutter beside
  the label or the top gap for centered notes, generated
  `attr(data-note)` label disabled — the real figcaption text is the
  accessible label).
