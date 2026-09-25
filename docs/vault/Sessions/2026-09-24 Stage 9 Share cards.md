---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 9 — Share cards (UI) + levels 6–9 wiring

## Goal

Make share cards playable in the browser: mint a replayable, tamper-evident card from any run, render a
PNG, and open a card URL that replays + verifies. Also expose the newly-authored levels 6–9.

## Built (builder, TypeScript only)

- `share.ts` / `share-card.ts` — a Share button after every run calls bridge `share_encode` (the engine
  re-runs and embeds the trajectory hash) → a `?c=<base64url>` URL (clipboard) + a Canvas PNG card
  (title, seed, score, belt, key metrics, a timeline strip, hash tag). On boot a `?c=`/`#c=` payload is
  base64-decoded for metadata, then `share_replay` verifies it and the run re-plays for the timeline,
  with a **"verified ✓"** or **"tampered / hash mismatch ✗ (got … ≠ …)"** banner.
- `main.ts` — `LEVELS` = 1–9; `KATA_LEVELS` = 3–9; kata play mounts on
  `unlocks = ["core"] ∪ (ownedTiers ∩ level.unlocks)` with a "Preemption is locked — buy it in Upgrades"
  notice; a card embeds its run's unlocks and **forces them on replay** (a replay reproduces the promised
  run regardless of the viewer's shop state).
- Engine reality the UI works around: `share_encode` mints **inline** cards only (a `level_id`-only card
  has no `result` to hash), so the UI sends the fetched level dict (adding a no-op `generator:{}` for the
  explicit-`jobs` levels 7/8 — `load_jobs` prefers `jobs`, so hashes are unchanged).

## Verification (screenshots)

Share card modal + copied URL; opening the URL → full replay + "verified ✓ (hash 46d8a83bdfb6…)";
one-char tamper → "card tampered / hash mismatch ✗ (got 46d8a83b ≠ 46d8a8M3)"; level selector shows 1–9;
level 7/8 kata shows the locked-tier notice on a fresh save. `tsc --noEmit` clean. See
[[scheduler_dojo-share-card]] and [[Concepts/Pyodide Bridge]].
