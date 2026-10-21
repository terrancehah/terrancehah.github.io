# AGENTS.md — Project Guide for AI Agents

## Project Overview

This is a static HTML/CSS/vanilla JS personal website (terrancehah.com), deployed via Vercel. It is **not** a Next.js application, despite what `.windsurfrules` describes. The `.windsurfrules` file was written for a different project and does not apply to this codebase.

## Agent Model And Deployment Permissions

- Use SWE-2 as the implementation model for subagent code changes. Do not substitute another model that requires a fee or payment. If SWE-2 cannot be selected or confirmed, explain the limitation and ask the user before proceeding with delegated implementation.
- Never add a serverless function to the Vercel deployment without the user's explicit permission. The Vercel Hobby plan has a limited serverless-function allowance; this applies to new function entry points and configuration changes that create additional deployed functions.

## Tech Stack

- Static HTML pages (`index.html`, `articles.html`, `projects.html`, `playground.html`)
- Vanilla CSS in `styles/` (no Tailwind build pipeline — `output.css` is pre-generated)
- Vanilla JavaScript in `js/` (classic scripts, not ES modules)
- Python API in `api/` (Vercel serverless functions)
- No npm build step (`package.json` build script is `echo No build step`)

## Pacey product

Pacey lives in `pacey/` (served at `/pacey`; the old `/projects/pacey` path 301s to it) with APIs under `api/` (`coach-plan.py`, `radar.py`, `garmin-auth.py`, etc.).

**Product scope (source of truth):** `pacey/PRODUCT.md`

**Voice:** `pacey/pacey-writing-style.md`

**Design conventions:** `pacey/.impeccable.md`

Consensus: marathon pre-race companion. Diagnosis is six-area fitness vs the typed goal time. Plan is the full remaining block to race day (not one week). No in-run coaching. Do not treat unofficial Garmin email+password as the long-term auth path.

**"Last Garmin sync" means the watch, not us.** On the Today's Metrics card, that label is when the **watch last uploaded to Garmin** (from `get_device_last_used` → `lastUsedDeviceUploadTime`, surfaced as `synced_at`), never when Pacey fetched the data. Pacey's own fetch time (`fetched_at`) says nothing to the runner — if the watch has not synced, checking again returns the same numbers. Do not show `fetched_at` in the UI.

## Design

**Read `.impeccable.md` and `docs/site-design.md` before any UI change.** The former is the personal site's design context (Pacey's running-product conventions now live in `pacey/.impeccable.md`); the latter maps current implementation owners and verification commands. Do not treat Pacey's users, colours or dark theme as the whole site's design.

### Personal Site Shared Components

- `styles/site-typography.css` owns role-based type sizes; header and footer navigation use the same token.
- `styles/site-header.css` owns header layout, title and social controls; `styles/site-navigation.css` owns navigation interactions and radius. All standard headers use the semantic `.site-header*`, `.site-nav` and `.site-social-*` hooks, not copied breakpoint utilities.
- `js/footer.js` generates the footer and SVG back-to-top control; `styles/site-footer.css` owns their presentation. No page stylesheet may add competing footer spacing.
- `styles/site-motion.css` owns shared touch feedback and native page transitions. `js/article-reading.js` drives article-only reading progress; its presentation is in `articles/articles.css`.
- Keep head-linked fonts/shared sheets aligned with their fallback imports. Preserve eager root heroes, native below-fold lazy loading, intrinsic image dimensions and photographer credits.
- Use `scripts/optimize-site-images.py --write` for responsive derivatives and `--check` to validate them. Preserve originals, manifest mappings and gallery `data-full-src`; do not recompress sources in place or delete assets automatically.
- The public style-guide article is a visual specimen sheet. Reuse real shared component rules in previews; do not replace the showcase with long-form prose.
- Run the relevant offline checks listed in `docs/site-design.md`. Do not start a localhost server, install dependencies or access the network without the user's permission. Static tests do not establish rendered layout, Core Web Vitals or real-device behaviour.

### Project-Specific Design

Pacey's UI also follows the CSS design system already in place, which is the practical expression of that context:

- Every token lives in `pacey/pacey-tokens.css` — never hardcode a colour in a component style.
- The board's materials (cork, paper, post-its, pushpins, handwriting faces) live in `pacey/pinboard-theme.css`.
- Page-specific rules belong in the `pacey/pinboard-<page>.css` files; `pacey/pacey.css` holds only the shell and shared primitives.
- The board and the paper-context modals pin their own `--pacey-*` palette because those surfaces stay light in both themes. Buttons inside them are outside `#pacey-content`, so board rules scoped there do not reach them — apply the treatment explicitly.

## Conventions

- Files: kebab-case
- Variables/functions: camelCase
- CSS classes: semantic names reflecting purpose
- No new npm dependencies without explicit request
- Never delete existing working code or comments
- Keep changes minimal and clean
