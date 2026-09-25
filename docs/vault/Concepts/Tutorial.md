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
  `upgrade_placed:NAME` …) | `first_time` (`pressure_moved`, `timeout`, `fallback`,
  `backfill_placed`) — evaluated at the engine tick.
- `do`: `callout` (anchored text), `highlight` (scene id; `pulseAnchor`), `lock` (`none|hand|place|booth`),
  `swap_card` (open the booth pulsing a slot; fires the `card_swapped` atom) and `edit_line`
  (one-line mode on a named card; fires `line_edited`) — both booth modes via `web/src/booth.ts`,
  whose arrangement serializes to the run's kata and persists under the `boothKata` pref,
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

## The runner (`web/src/tutorial.ts`, Art 4)

`TutorialRunner.start(city, campus)` executes one script against a live **hand** campus
(`CampusPlay.create({ mode: "hand" })`, wired inside the campus stage — not a 5th top-level mode;
a "Tutorial: city 1" chip shows while the belt is Orange or below, and `?city=1` boots straight in).
The script loads over HTTP from `levels/tutorials/<city>.json` first (Pyodide cannot see repo
files; `tutorial_load` remains the CLI/Node path), and `cityLevel()` editions the canonical level
client-side with the same whitelisted `story`/`duration`/`generator` merge `sim/tutorial.py`
enforces — the merge feeds data to Python, which still validates and decides everything.

- **Triggers read engine facts only**: the runner keeps a small ledger from the snapshots
  `CampusPlay.onStep` exposes — sim time, day/week (`placed_total`/`week` fields when present,
  else `finished + running` and `7 x watch_plan.stride` fallbacks), queue contents and submit
  times seen in `unseen`, pressure moves, overflow, `done`. `behind` (sticky) = queue ≥ 3, or a
  ring ≥ 0.75, or a vehicle waiting > 900 s, or 60 % of the horizon gone — so city 1 reveals the
  booth before week end even against perfect play. No wall clock enters any predicate.
- **`do`**: `lock` (disable the named control), `callout` (focus-trapped popover anchored via
  `CampusPlay.anchorPoint`: `road` / `bays` / `booth` / `offers` / `ring:USER` / `bay:ID` /
  `vehicle:ID` / `vehicle:last_placed`), `reveal {booth}` (`revealBooth`, which also unlocks the
  booth card dialog) and `reveal {building}` (`revealBuilding` — Art 5b: `reserve` announces the cone
  control and nudges the lots; sprites for the other four buildings land with Art 6), `set_mode` (a
  chip; `booth:cards`/`booth:line` open the panel, and Art 5b's `step` hands the clock to the campus
  Step button via `setStepMode`), `offer_upgrade`
  (the deterministic pair from `offers_list`, take-one).
- **Art 5b predicates, all read off facts, never off the script**: `owned` (the save's `upgrades`,
  which only `progression.buy` writes), `cone_placed` (a viewer cone exists — `viewerCones`), and
  `backfill_placed` (a vehicle actually parked into coned bays, from the snapshot's `running.nodes`).
  Taking an offer fires `upgrade_placed:<id>`, which is what city 3's cone beat waits on — so the
  beat cannot be satisfied by the save file alone, and the cone beat itself cannot complete without
  a real "Cone it" press.
- **`pressure_moved` has a documented fallback**: the engine computes rings only on levels that
  declare `pressure`, and no city's level data does yet, so when the snapshot carries **no** rings the
  runner fires `pressure_moved` from the same engine facts `behind` already reads (a jam, a 900-s
  wait, 60 % of the horizon). Same style as the `placed_total`/`week` derivations above. The reason it
  matters: an unparked hand campus has no FINISH events, so its clock stops at its **last arrival**
  (~13.4 ks on level 3) — a watchdog-only beat whose budget is larger than that is unreachable, not
  merely slow. Revisit when Art 6 puts `pressure` in the city levels.
- **Cards are katas**: `web/src/booth.ts` renders the booth dialog's rule cards by splitting a kata
  source into its non-empty `SLOTS` modules (`order, place, preempt, route` — line-splitting only,
  no parsing). Staffing during a hand run **records** the choice (there is no mid-run policy
  switch in the bridge — `hand_start` runs the manual policy): it fires the `booth_staffed`
  tutorial event and persists the kata so the next kata run preselects it
  (`KataPlayOptions.initialKata`). No invented engine behavior.
- **Never hangs**: an unknown `when`/`do`/`wait_for` keyword warns on the console and is treated as
  satisfied/skipped; every wait carries a sim-time stall watchdog of `max(2 x stride, 3600)` s;
  `or_then` accepts the next step's `when` as an alternative; `timeout_secs` auto-continues; and a
  permanent focusable "Skip tutorial" button ends the script and unlocks the campus.

## Help drawer

The drawer lists exactly the concepts/builtins the player has unlocked (from save state), each a
paragraph + "show me" (`highlight` reused). It reads the same step vocabulary — one language for
guided and unprompted teaching.
