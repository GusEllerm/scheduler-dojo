---
livedocs: code
tags: [concept, phase-two]
---
# Campus

> [!abstract] The metaphor
> The scheduler is a **campus**: neighbourhoods (users) emit **vehicles** (jobs) onto a **road**
> (the queue) that park in **bays** (nodes) grouped into **lots** (partitions); a second campus
> across a **motorway** is a site; the **dispatch booth** at the lots' entrance runs the rules —
> the kata. The picture is a rendering *of* the engine snapshot; **nothing that decides lives in
> the renderer** (see [[Pyodide Bridge]]). The two views — campus (play) and strip (review) —
> share colors, shapes and state treatments ([[Art Direction]]).

## Every mapping (the contract)

| Picture | Engine fact | Source |
|---|---|---|
| neighbourhood (shape + label + color) | one per job `user` | snapshot `jobs[].user` |
| patience ring on a neighbourhood | that user's bounded-slowdown pressure, capped at overflow | engine `pressure` per user (§5.3) |
| vehicle = a job on the road | queued job, drawn in **policy-rank order** | engine-ranked queue (trace), not client sort |
| vehicle **width** | nodes requested | `JobSpec.nodes_req` |
| vehicle **length** | walltime requested | `JobSpec.walltime_req` (sensor upgrade reveals *actual* length, §5.5) |
| bay | one node | `Cluster.nodes` |
| lot (material) | one partition | `Cluster.partitions` |
| second campus + motorway | a site + transfer delay | `route`/`transfer_secs` (§2.4 of the brief) |
| dark bay | idle node-seconds | snapshot gaps |
| vehicle parked across k bays | whole-node allocation, k adjacent nodes | `placed_nodes` (§5.1 — must be real ids) |
| jam = road grows | queue length under the active policy | snapshot `queue` |
| one color flooding the road | one user dominating the queue | `user` on ranked queue |
| reservation cone + countdown | a `reserve` **intent**, or a viewer hand hint (Art 5b, below) | snapshot `reserved` (`job -> intended start`) — never guessed bays |
| why-panel line | one decision-trace record | `Scheduler._trace_event` / the `KataPolicy` tracer, via `start(trace=N)` (§5.2) |
| staged bay set | the player's own pick, client-side | `hand_place` is the truth; the ghost is a preview |
| tow-truck pull-out + spilled work | preemption, progress lost (no checkpoint) | `preempt_count`/`run_epoch` |
| rings overflowing ends the run | level-declared rule | engine overflow check (§5.3) |

## The calendar `[agent decision]`

**One sim-day = 86,400 sim-seconds; one week = 7 days** — and **a city's horizon spans exactly one
week**: day *d* of the week is `floor((t - t0) / (duration / 7))`. Weeks for endless use the literal
86,400 s day. The day-night tint maps position-within-day, so short levels still show a full arc.
Alternatives rejected: literal 24 h days (levels are 8–33 h horizons → less than two days per city,
no weekly rhythm) and a fixed compressed-day constant (drifted out of sync with week ends at long
horizons). One function, in the **engine** (bridge exposes day/week), so CLI and browser agree on
when a week ends (§5.6). See [[Decision Log]].

## Patience rings

Per user, at every event/tick batch (`Scheduler._compute_pressure`): `ring = max over unfinished
jobs of clamp(wait / grace, 0, 1)` where `grace = (cap - 1) x est`, `est = walltime_req` (what the
job *claimed* — the same estimate the picture shows), and `cap` is the level's declared overflow
threshold (`pressure.cap`, default 2, so cap=2 means "a job that has waited as long as it said
it would run has popped its neighbour's patience"). Ring ≥ 1 ⇒ `overflow_user` is set; every city
and endless declare `end_on_overflow: true`, so the run stops there and unfinished jobs score as
unfinished. A user's ring relaxes only when their queue drains. Deterministic: integer tick, fixed
job-id order, one float division ([[Determinism]]). Levels without a `pressure` block never compute
rings and their hashes are byte-identical to phase one.

## Days, weeks, offers

At each week boundary the engine freezes (the run pauses at that sim time); the offer pair is
`deterministic_save_city_week_offers(save, city, week)` — the eligible, unowned, prereq-satisfied
upgrades sorted by id, seeded draw of two — **in the engine/progression module**, so a share card
replays the upgrade path (§5.8). Credits/belts stay lifetime record, not currency
([[Progression]], [[Decision Log]]).

## Scene vocabulary (renderer contract)

The TS scene layer owns *sprites and layout only*: `vehicle` (job + state: queued/chosen/reserved/
running/done/timeout/preempted/transferring), `bay`, `lot`, `neighbourhood`, `ring`, `booth`,
`building`, `road`, `motorway`. It builds from bridge snapshots, **interpolates** between ticks, and
derives no judgement. Hit-test targets: vehicle, bay, building, ring → detail cards. If the snapshot
lacks a fact (e.g. true placements), that is an engine bug to fix in [[scheduler_dojo-bridge]], not
a renderer workaround — the phase-one lane repack is the cautionary tale.

## Hand play on the campus (Art 4)

`CampusPlay.create({ mode: "hand" })` runs the same engine through `hand_start`/`hand_place`/
`hand_tick`/`hand_result` ([[scheduler_dojo-bridge]]): nothing auto-places, the engine still
validates every `hand_place` (a `PolicyError` is a red campus toast, never a crash), and parked
vehicles show as running in the same snapshot — the scene is built from step snapshots exactly like
the live view, and `chosen` is null while the booth is unstaffed (nothing was "picked"). Hand
additions to the scene model are optional fields (`selectedId`, `staged {bays, fits, user}`,
`booth.revealed`) so live frames are pixel-identical: a staged ghost is owner color at low alpha
edged `ok`/`overflow` (a client-side guess; `hand_place` is the truth), an unrevealed booth is
dimmed and refuses taps. Tap geometry: `vehicleBox` mirrors the renderer's `roadSlots` exactly, and
the road band paints **before** the queued vehicles (Art 3 painted it after, which hid the queue —
fixed in Art 4). A hand-mode canvas resize re-projects the scene (the live loop self-heals every
frame; the hand view has no frames). `hand_start` has already processed the first arrival batch, so
those jobs are in no `unseen` list: the viewer seeds its job union from a decide-nothing idle
`start` of the same level (arrival data is engine data, not a decision). See
`Sessions/2026-10-02 Phase 2 Art 4.md`.

## The booth's *why*, step mode, and cones (Art 5b)

**The why-panel** (`web/src/campus-play.ts` + `web/src/campus-why.ts`) is a collapsible `<details>`
in the campus stage over the engine's decision trace. A live campus run asks for it —
`bridge.start(..., trace=24)` (`start_run` → `_trace_event`), and every `step_n`/`step_until` result
carries the ring buffer (`_step_out`); `run`, `hand_start` and the CLI pay nothing. Rows are keyed by
the record's `seq`, appended only when new and dropped when they fall out of the ring, so the
`role="log"` region announces what happened rather than re-reading the panel. Phrasing is per
action: `place` ("j00004 parked on n0 n1 — shortest first", transfer noted when non-zero), `preempt`,
`route`, and `fallback` ("no fit — kept FIFO order (`no_nodes`)" — an unmapped code prints the
engine's own word). The **one inference** is naming an order key: the `order` record carries the
computed key per queued job, so the first key component is compared against that vehicle's own engine
facts (`est`, `submit`, `nodes` — an exact match, in a fixed candidate order) and "shortest / longest
/ biggest / smallest / oldest / newest first" is what the key *demonstrates*, else "an order key of
its own". No policy label is consulted; nothing is decided client-side. Owner color rides on a small
bar rather than the sentence, because palette tokens are tuned for the canvas, not 12 px text
([[Art Direction]], [[Accessibility]] rule 8).

**Step mode** is the campus control row's `Step ▸` (live runs only — a hand campus has no booth to
step, and its clock is `Time ▶`). Pressing it pauses the rAF loop; each press is
`bridge.step_n(handle, 1)`, i.e. **one EVENT batch** (`Scheduler.step_events` — every event at one
timestamp plus its one decision, which is exactly the unit trace records come from), then
`step_once` + a why-panel refresh + one settled frame. `Resume` re-bases the wall clock and the loop
restarts; the tutorial's `set_mode "step"` routes to `setStepMode(true)`.

**Cones** come in two kinds and the painter tells them apart by data, never by guessing:

- *Engine cones* — `reserved` in the snapshot is a **`reserve` intent** (`job -> intended start`) and
  carries no bays, so the cone hangs on the vehicle, never on a bay the engine did not name, and the
  countdown reads `t - now` in sim time.
- *Viewer hand cones* (`Cone.from` added so the countdown bar spans its own window instead of a
  guessed constant) — the "Cone it" button on the hand bar. It draws a `Cone` over the bays the
  ENGINE's own FIFO hint (`suggestions` from `hand_start`/`hand_tick`) would hand that vehicle — the
  player's staged bays win when they are the right size — and decays at the later of "those bays are
  free" and the vehicle's claimed length, pruned by sim time inside `step_once` (never a timer, so a
  paused campus holds its cones and a catch-up step drops expired ones). **It books nothing**: the
  bridge has no hand-mode `reserve`, so the button, the toast and the note all say it is a hint on
  the map. It fires the `cone_placed` tutorial event and is what city 3's guided cone beat completes
  on.

**Misfit feedback** (hand): a `hand_place` refusal maps its `PolicyError` code (`no_nodes`,
`mismatch`, `already_running`, `deps_unmet`, `unknown_job` from `scheduler_dojo.sim.errors`) to a
campus sentence with the code still visible, a red edge plus one short shake on the bar (reduced
motion: the edge only), and a reason line under the bar — see [[Accessibility]].

Keyboard play, the canvas's `tabindex`, and which live regions announce what: [[Accessibility]]. See
`Sessions/2026-10-02 Phase 2 Art 5.md`.
