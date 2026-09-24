# Levels

> [!abstract] What a level is
> A level is *data*: a cluster topology, a job generator, a fixed `seed`, and the scoring rules that
> turn a run into a score with a **pass** bar and a **gold** bar. `scripts/calibrate_levels.py` makes
> the bars mean something. A level is a deterministic puzzle — the same for every player and replayable
> from a share card. See [[Determinism]] and [[Kata]].

## The schema (validated by `validate_level`)

| field | meaning |
|---|---|
| `id`, `title`, `teaches`, `story` | identity + the one pattern it drills |
| `seed` | the fixed puzzle seed (calibration picks a pedagogically clear one) |
| `cluster` | `sites` topology or a `nodes` shorthand |
| `generator` | arrivals/sizes (`sim.trace.generate_jobs`) |
| `unlocks`, `sensors` | which Kata tiers / sensor fields are live |
| `baseline_policy` | the naive reference run that scores **300** |
| `reference_kata` | the exemplar run that scores **800** |
| `primary_metric` | the lesson's headline metric |
| `score_weights`, `score_anchors` | the 0..1000 blend, written by calibration |
| `bars` | `pass_score` / `gold_score` |

## Calibration makes the bars real

Anchors are solved **per metric on the level's fixed seed** so `score(baseline)=300` and
`score(reference)=800` *exactly*. Only metrics the reference is at least as good as the baseline on are
scored (a Pareto filter on that seed), so clearing gold means genuinely matching the reference's
improvements — **the gold is earned, not baked into the anchor**. Re-running calibration is idempotent
(byte-identical files); the goldens (`tests/goldens/levels.json`) pin the hashes and the 300/800 scores
for cross-platform determinism.

## Why fairness is quiet at Stage 3

`fairness` is Jain's index of delivered-vs-entitled share; when every job completes (the normal case at
util < 1) delivered ≈ entitled for everyone and the index sits near 1 for *any* ordering — so a
share-aware order cannot move it. It is left unlocked and used (so the machinery is exercised) but is
rarely a scored metric yet; a real fairness lesson needs SLAs or guaranteed shares (later stages). This
is a known, honest limitation, not a bug. See [[Concepts/Scoring|Scoring]].

## Stage-3 ladder (levels 1–5)

1. **Warm-up** (`baseline=idle`) — drop jobs on nodes; placement. Reference proves doing *something* ≫
   doing nothing (util/slowdown).
2. **You cannot keep up by hand** — a firehose; a one-line `order` kata (shortest-first) crushes FIFO.
3. **The big job that never starts** — starvation; order short-first and **gap-fill** (via `fits_later`)
   so free nodes are never idle while a big job waits.
4. **Trust, but verify** — users pad walltime; schedule on the `est_runtime` **sensor**, not the request.
5. **Everyone at the table** — a flooding hog; a `user_share`-aware order keeps the queue responsive.

## Reading

`scripts/calibrate_levels.py` (the calibration contract), [[scheduler_dojo-sim-level]],
[[Concepts/Scoring]].
