---
livedocs: snapshot
tags: [session, phase-two]
---
# 2026-10-01 Phase 2 Art 0 — audit & housekeeping

Phase two = the campus (`PROMPT-ART.md`). This note is the audit of the phase-one presentation, the
ranked change list, and the housekeeping record. Code facts below were verified against the tree at
`a757737`; visual facts come from `docs/screenshots/audit/` (captured from a local dev server).

## What each screen shows today

| Screen | Shows | Fails to show | Where the eye goes first |
|---|---|---|---|
| Load / shell | title, level picker (1–9), mode switch, policy toggles, HUD chip | any world or metaphor — it is an admin console | the big level button row |
| Watch mode | a policy button, then a **post-run** Gantt canvas + numeric scorecard | any present-tense state; jobs are id-bars, not entities; no user identity anywhere | the timeline canvas once painted |
| Queue (hand mode) | grey chips with ids; node lanes as empty rows | who owns a job, what it asked for, whether a bay can take it (fit feedback is post-hoc via an engine error toast) | the chip strip |
| Hand placement | chip→lane→Place confirm bar | *why* a placement will fail (adjacency, wrong lot); no spatial grouping of nodes | the highlighted lane |
| Kata mode | CodeMirror editor, library, Check/Run/Step | that these are "rules the booth runs"; no link from a decision to the line that made it | the editor pane |
| Shop dialog | 5 upgrade cards, cost, gates | anything spatial; upgrades never appear in the world; credits-as-price hides the rhythm | the BUY button of the first affordable card |
| Review (scorecard+timeline) | metrics, bars, trajectory hash, Share | per-user story, idle-cell map, requested-vs-actual, the why of any decision | the big score number |

Confirmed against code:

- `bridge._jobs_json` ships `nodes: j.nodes_req` (a **count**); `render/timeline.ts` admits its lanes
  are a "first-fit replay … the specific node ids for multi-node jobs may differ" — the picture is an
  approximation. The live `_snapshot.running` does carry `placed_nodes`, so the truth exists mid-run
  but dies in `step_result`.
- No decision trace exists anywhere: on fallback, `KataPolicy.last_fallback` keeps only a code.
- The queue a player sees is a DOM chip strip ordered by the *client*, not the active policy's ranking.
- There is no engine notion of day/week, per-user pressure, or run-ending overflow.

## Where a new player is not told anything

Nothing explains: what a job is, why nodes are rows, what utilization means, that ordering is the
lesson, what a kata is for, why the shop exists, or how to win. City 1 as shipped (level 1, idle
baseline) is literally "drop chips on rows" with no rings, no story text on screen, and no next step.

## Ranked: the ten most valuable phase-two changes

1. **True placements in the run record** — `bridge.run`/`step_result` carry node-ids (+site) per job,
   and the strip draws them. Everything else that "shows" depends on this being honest. (§5.1)
2. **Present-tense campus view** — neighbourhoods, vehicles on a road (queue), lots/bays, driving from
   the snapshot at a fixed tick. Replaces the admin console. (§2.1, §5.4)
3. **Decision trace + booth why-panel** — pausing shows *why*: ranked queue, order keys, chosen job,
   gap chosen, fallbacks pinned to kata lines. (§5.2, §2.3)
4. **Per-user patience rings in the engine** (+ overflow ends the run; deterministic) — bounded
   slowdown felt live, starvation watchable. (§5.3)
5. **The booth: rule cards → one-line edit → full editor** — the graded kata on-ramp; cards are
   canonical katas, so card library ≡ kata library. (§2.3, §4)
6. **Fit feedback in hand placement** — snap, adjacency/wrong-lot reasons, shake on misfit; the engine
   answers "why not" before the player commits. (§7)
7. **Weeks + weekly two-offer upgrades as buildings** — the rhythm that replaces the credit shop;
   offers a deterministic function of (save, city, week) so share cards replay the path. (§2.5, §5.6, §5.8)
8. **Reservation/preemption/transfer events in the snapshot + requested-vs-actual** — the buildings
   become animated, legible machines instead of icons. (§5.4, §5.5)
9. **City board + strip review done right** — thumbnails/belts/locks; review with idle-cell heat,
   longest-waits, per-user shares; the pair the player actually lives in. (§2.6, §7)
10. **Tutorial-as-data + help drawer** — every feature introduced after the pain that wants it;
    unlocked-concepts list with "show me". (§4)

## Housekeeping done

- `screenshots/` is gitignored; a curated 8-shot subset of phase-one verification shots now lives at
  `docs/screenshots/phase-one/`; the rest were transient and removed.
- `PROMPT-ART.md` tracked. Audit captures under `docs/screenshots/audit/` (this commit).

## Visual pass (22 shots, `docs/screenshots/audit/NOTES.md`)

Every screenshot lands on a *finished or scrubbed replay*; the first thing players see is a green wall
of done-bars and a big score number — the opposite of a present-tense control panel. Job blocks are
uniform grey/green by state; **no screen anywhere colors by user**, so the fairness city is visually
identical to any other. The share card renders abstract placeholder art, not the run. At 390px the
kata editor and library overflow with no scroll cue.

Flagged items, dispositioned:

- `Utilization 100% · 0 busy now` (hand gauge): *not* an engine bug — cumulative util over a run where
  one job filled its node wall-to-wall, with nothing running at this instant. Correct but reads as a
  contradiction; the gauge is superseded by the Art 7 review screen. No action.
- Hand clock starts at `t=2m01s`: level 1's first arrival genuinely submits at 121 s. Correct, odd-looking.
- Kata editor overflows at 1280/390 and Run's timeline falls below the fold: real, but the editor
  screen is rebuilt inside the booth (Art 5); fixed there, not patched here.
