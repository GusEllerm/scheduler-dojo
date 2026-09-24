---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 1 — Simulator core (headless)

## Goal

A deterministic, integer-clock discrete-event simulator of whole-node batch scheduling, with FIFO
first-fit and shortest-first built-in policies, scoring (raw metrics + a 0..1000 normalized score),
seeded synthetic trace generators, a fixture level, and `dojo run`.

## Interfaces (the contract builders build against)

- `scheduler_dojo.sim.jobs.Job` / `JobState` / `JobResult` — one record per job; fields listed in
  the `jobs` module note. `id` is a stable string for deterministic sorting.
- `scheduler_dojo.sim.cluster.Cluster` / `Partition` / `Node` / `Allocation` — whole-node model: a
  node hosts at most one running job across `[start,end)`; reservations are future `Allocation`s so
  backfill/`earliest_fit` are expressible later without a model change.
- `scheduler_dojo.sim.scheduler.RunResult` — completed run: `jobs: list[JobResult]`,
  `node_seconds_total`, `node_seconds_busy`, `end_time`, `n_jobs`. Consumed by scoring and goldens.
- Policy interface: `policy(ctx) -> None`, where `ctx` exposes `now`, `queued` (list, engine order),
  `running`, `free_nodes()`, and `place(job)` / `place(job, node_ids)`. Invalid actions raise
  `scheduler_dojo.sim.errors.PolicyError`. Built-ins `fifo` and `shortest_first` mirror the future
  Kata `order`+`place` slots.
- `scheduler_dojo.sim.trace` generators return an ordered `list[Job]` (submit times set); the
  scheduler consumes them via `Arrive` events.

## What was done / split

- **Orchestrator owns the coherence-critical core** (a deliberate deviation from the brief's
  "builder (a) = events+cluster+jobs"): `jobs.py`, `cluster.py`, `events.py`, `errors.py`,
  `scheduler.py`. Rationale in the Decision Log — determinism and coherence of the event loop are
  worth more than parallelizing them; a shared-vocabulary mismatch would cost more than the speedup.
- **Builder (b):** `sim/scoring.py` (metrics + `score()` normalization) against `RunResult`.
- **Builder (c):** `sim/trace.py` (Poisson arrivals, size/walltime distributions, user mix; a stub
  for sacct CSV import) against `Job`.
- Orchestrator integrates, writes `dojo run`, fixture level, golden-trajectory tests.

## Decisions

Whole-node allocation; event tie-break order; policy-as-callback — see [[Decision Log]].

## Review

- **Correctness reviewer**: flagged cluster build-order and trace monotonicity as determinism
  hazards. Both were already safe (nodes sorted by id; trace clamps + sorts) — the fuzz and the new
  `tests/test_determinism_invariants.py` prove it. Kept the regression tests anyway.
- **Adversarial reviewer**: found real defects, all now fixed + regression-tested in
  `tests/test_hardening.py`:
  1. built-in policies ignored `deps` → `PolicyError` escaped `run()` (P0);
  2. `place(job,[n0,n0])` double-booked a node → `utilization=2.0` (P0);
  3. completed-only slowdown/wait let an idle run outscore a working one (P0 scoring exploit);
  4. `until`/`max_events` ignored on the first batch;
  5. policy rescan was O(n²) on an over-subscribed load (perf — see Decision Log);
  6. duplicate job/node ids silently dropped work; 7. trace `OverflowError`/NaN on degenerate specs;
  8. Scheduler was silently reusable over mutable state (now a `DeterminismError`).

## Acceptance (met)

- Golden-trajectory tests: 3 seeds × 2 policies on the fixture level — ✅ (`scripts/gen_goldens.py`).
- Scoring unit tests vs hand-computed cases — ✅.
- 10,000-job run < 5 s natively — ✅ (~0.6 s provisioned; `test_10k_jobs_under_5s`).
- Full suite green (74 tests), `dojo run` works, goldens script-generated and unchanged by the fixes.
