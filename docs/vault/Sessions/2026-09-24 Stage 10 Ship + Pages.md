---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 10 — Polish, a11y, GitHub Pages ship

## Goal

Make the game genuinely shippable: accessible, documented, and deployed to a public URL.

## Deploy (the deferred Stage 10 item)

- `vite.config.ts` → `base: "./"` so built asset URLs are relative and the site works under the
  GitHub-Pages **subpath** (`/scheduler-dojo/`). `WHEEL_URL` is now derived from the **worker's own**
  `import.meta.url` (`wheelUrlFor`) instead of `location.origin`, which is what makes micropip's install
  resolve correctly under a subpath in both dev (`/src/worker.ts` → `../../wheels`) and build
  (`assets/worker-*.js` → `../wheels`).
- `web/scripts/copy-levels.mjs` (prebuild) copies repo `levels/` → `public/levels` (dev served it via
  middleware; Pages needs them static). `.github/workflows/pages.yml` builds the wheel → `npm ci && npm run
  build` → `upload-pages-artifact`/`deploy-pages`. Pages set to `build_type=workflow`.
- Verified end-to-end on the LIVE URL: engine + all 9 levels + HUD + share; reference kata → **800**.

## a11y + docs

Landmarks, `aria-live` status/scorecard, labelled modal dialogs with focus-trap + Escape, a skip-to-
timeline link, `:focus-visible` rings, `prefers-reduced-motion` (autoplay off), AA contrast. Top-level
README (what/how/play/levels/dev). See [[Accessibility]].

## Close-out

All stages 0–10 tagged and CI-green (`test` + `smoke` + `pages`). 240 tests. The plan in [[Home]] is
complete. What is genuinely simplified/honest: whole-node allocation; preemption is no-checkpoint;
transfer is a flat per-job delay; fairness lesson is quiet below util 1; a real reservation/backfill
engine is not modelled (gap-fill via `fits_later`). These are deliberate teaching simplifications,
logged in the [[Decision Log]].
