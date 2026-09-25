---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 7 — Progression HUD + upgrade shop

## Goal

Surface the (already-built) progression engine in the game: belts, credits, an upgrade shop, offline
drift, and save persistence — so spending/earning credits is a real game loop.

## Built (builder, TypeScript only)

- `progression.ts` — `get/setProgression` over `persistence` (a `progression` sub-object of the Store
  doc) + `view/complete/buy/drift` wrappers that call the bridge and write back the returned state.
- `hud.ts` — belt chip (colour per belt), credits, "→ next belt in N", an Upgrades button.
- `shop.ts` — the 5 upgrades as cards (cost, tier unlocked, prerequisite, owned/buyable/locked).
- `main.ts` — mount HUD at boot; **drift on load** (welcome-back toast); on any finish
  (watch/hand/kata) call `progression.complete(levelId, score, seed)`; kata modes pass
  `level.unlocks ∪ progression.unlocked` so owned upgrades really enable those tiers.

## Verification (screenshots)

HUD shows WHITE belt, credits, "→ Yellow in N" (drift granted credits on load). Shop: Reservations
BUYABLE, Sensors "NEED 15 MORE", Fairness/Preemption "NEEDS RESERVE", Routing "NEEDS FAIRNESS" — the
prerequisite tree is faithfully rendered. Buying Reservations took 105→45 cr and flipped it to owned;
**reload restored 45 cr** (localStorage). `tsc --noEmit` clean. Engine side (`progression.py`, bridge
`progression_*`) was built earlier; see [[scheduler_dojo-progression]] and [[Concepts/Progression]].
