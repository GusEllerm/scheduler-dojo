---
livedocs: code
tags: [concept, phase-two]
---
# Tutorial

> [!abstract] The rule
> No feature appears before the pain that wants it: **pain → tool → guided first use**, always. The
> sequence is **data**, not code — one JSON per city under `levels/tutorials/` — so it can be retuned
> without a build. Triggers and waits read only engine facts (calendar day, sim time, queue state),
> never wall clock, so a tutorial run is as deterministic as the run itself ([[Determinism]]).

## Schema (validated by `scripts/check_tutorials.py`)

```json
{
  "version": 1,
  "city": 1,
  "level": "level1",
  "level_patch": {"generator": {"users": [{"name": "alice", "weight": 1.0}]}},
  "steps": [
    {"id": "welcome",
     "when": {"after_days": 0, "once": true},
     "do": [{"callout": {"title": "…", "body": "…", "anchor": "bay:n0", "actions": ["got it"]}}],
     "then": [{"lock": "none"}, {"wait_for": {"placed_any": true}}]}
  ],
  "end": {"on": {"day": 3}}
}
```

- `when`: `after_days` | `after_sim_secs` | `on_event` (`week_end`, `first_place`, `first_preempt`,
  …) | `first_time` (`pressure_moved`, `timeout`, `fallback`) — evaluated at the engine tick.
- `do`: `callout` (anchored text), `highlight` (scene id), `lock` (`none|hand|place|booth`),
  `reveal` (`booth|ring:USER|building:NAME|cone`), `set_mode` (`hand|booth:cards|booth:line|
  booth:editor|step`), `offer_upgrade` (`reservations|sensors|fairness|preempt|route`).
- `then`: `wait_for` (`placed_any` | `sim_secs` | `booth_staffed` | `chosen` | `week_end` | `day`,
  with an optional `timeout_secs` that auto-continues), or `end`.
- `level_patch`: a deterministic **city edition** of the canonical level — patching does not change
  the shared calibrated level or its hash (calibration and share cards still refer to `level`);
  the tutorial variant is pinned by the tutorial golden. Whitelisted fields only (`generator`
  knobs, `duration`, `story`). `[agent decision]` — alternatives (recalibrating levels to the
  tutorial's pacing, or a separate tutorial level id) would fork the calibration story for no gain.

## Cities 1–3 (the scripts in `levels/tutorials/`)

- **city1 — "Four bays"** (`city1.json`): patch = one neighbourhood (alice), slow arrivals. Pure
  hand: tap vehicle, tap bays (guided `welcome` → `adjacency` when the first convoy needs all four
  bays). On **day 3** the patch's second neighbourhood is revealed via `reveal ring:bob`, arrivals
  step up (`accelerate`), and only when the player falls behind does `staff_booth` reveal the booth
  with three order rule-cards (oldest / shortest / biggest first). `end` at week end → the first
  two-offer choice.
- **city2 — "You cannot keep up"** (`city2.json`): booth staffed from the start; `swap_card` guided;
  mid-week `edit_line` opens the one-line editor on a card's `key` line with the full card text
  beside it — the player sees the card *is* the kata ([[Decision Log]] cards-are-katas).
- **city3 — "The convoy that never parks"** (`city3.json`): starvation. Reservations arrive as the
  week-end choice (offered first); guided hand-placement of one cone, then the `place` card with a
  second module (every booth `place` is a traced `Scheduler.place` — the why-panel shows which module
  parked what), then the full editor opens prefilled with the two cards rendered as text.

## Invariants the checker enforces

Every step is reachable (ordered, no gaps); every anchor/highlight target exists in the scene
vocabulary ([[Campus]]); every named upgrade ∈ the five buildings; every named builtin exists at
its declared tier; `level_patch` touches whitelisted fields; and city order never reveals a
`building`/builtin before the city that owns it.

## Help drawer

The drawer lists exactly the concepts/builtins the player has unlocked (from save state), each a
paragraph + "show me" (`highlight` reused). It reads the same step vocabulary — one language for
guided and unprompted teaching.
