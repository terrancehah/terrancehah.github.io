# AGENTS.md — Project Guide for AI Agents

## Project Overview

This is a static HTML/CSS/vanilla JS personal website (terrancehah.com), deployed via Vercel. It is **not** a Next.js application, despite what `.windsurfrules` describes. The `.windsurfrules` file was written for a different project and does not apply to this codebase.

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

Consensus: marathon pre-race companion. Diagnosis is six-area fitness vs the typed goal time. Plan is the full remaining block to race day (not one week). No in-run coaching. Do not treat unofficial Garmin email+password as the long-term auth path.

**"Last Garmin sync" means the watch, not us.** On the Today's Metrics card, that label is when the **watch last uploaded to Garmin** (from `get_device_last_used` → `lastUsedDeviceUploadTime`, surfaced as `synced_at`), never when Pacey fetched the data. Pacey's own fetch time (`fetched_at`) says nothing to the runner — if the watch has not synced, checking again returns the same numbers. Do not show `fetched_at` in the UI.

## Design

**Read `.impeccable.md` (repo root) before any UI change.** It is the design context: users, brand personality, aesthetic direction, design principles, colour system, dark mode, motion, spacing, accessibility, loading and empty states.

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
