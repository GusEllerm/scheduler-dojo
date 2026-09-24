---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 5 — Hand placement

## Goal

Make levels 1–2 *playable by hand*: the player drags/clicks jobs onto nodes while the engine validates
every move, with live gauges and localStorage persistence. The first genuinely interactive stage.

## Engine piece (committed with the Stage 7/9 engine batch)

`bridge.hand_start/place/tick/result` run the `Scheduler` under a **no-op manual policy** — nothing
auto-places, the engine still validates each `hand_place`, and `hand_tick` advances to the next
arrival/finish. `_suggestions` answers "what would FIFO do" with a **read-only** `first_fit` (never
mutates — asserted). Hand placement completes deterministically to the same trajectory hash as an
equivalent auto run.

## UI piece (builder)

`web/src/hand.ts` (`HandGame`, click-to-place + confirm; drag optional), `gauges.ts` (live util +
queue), `persistence.ts` (versioned localStorage), wired into `main.ts` via a Watch/Play-by-hand mode
switch. `tsc --noEmit` clean.

## Verification (screenshots)

Hand mode renders chips + node lanes + gauges; selecting a chip and clicking a lane stages
"place jN → nX" with a Place/cancel confirm; confirming flips running→1; Finish shows the scorecard
(score 440 > pass 350) and the painted timeline (green done-bar on the placed node), and localStorage
shows "saved best 440 · 1 seed played".

## Notes

The UI builder twice returned mid-verification (turn budget), so the orchestrator finished the
screenshot pass directly. Belongs to [[Levels]] (warm-up/hand levels) and [[Pyodide Bridge]] (all
actions go through the bridge). Engine tests: `tests/test_bridge.py` hand section.
