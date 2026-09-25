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
| reservation cone + countdown | a `reserve` | snapshot reservations (§5.4) |
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

Per user, per tick: `ring = max_over_queued_jobs( min(slowdown, cap) / cap )` where `slowdown` is
the same bounded slowdown as [[Concepts/Scoring]] (`max(wait+run,10)/max(run,10)`) evaluated at the
current time with the *requested* runtime as the estimate, and `cap` is the level's declared
overflow threshold. Ring ≥ 1 ⇒ run ends (every city and endless declare this). A completed job
leaves the max — so a ring relaxes when a user's queue drains. Deterministic: integer tick, fixed
job-id order, no wall clock ([[Determinism]]).

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
