# scheduler_dojo/sim/scheduler.py

> [!abstract] Role
> The discrete-event scheduling loop and the two built-in policies. This is the engine every
> policy (built-in or kata) drives.

## What it does

`Scheduler(cluster, jobs, policy)` seeds one `ARRIVE` per job, advances an integer clock, and at
each decision point calls `policy(ctx)`. `PolicyContext` exposes `now`, `queued`, `running`,
`free_nodes()`, `fits_now(job)`, `fits_later(job)` (a time-agnostic capacity ceiling via
`Cluster.can_host`, so backfill katas hold room for a job that cannot fit *now*), and
`place(job[, nodes])`. `run(until=None)` returns a `RunResult`. `fifo`, `shortest_first`, and `idle`
(place-nothing, the calibration/hand baseline) are plain-Python policies registered in `POLICIES`.

## How it works

- **Whole-node placement:** `place` allocates each chosen node for `[t, t + runtime_used)`
  where `runtime_used = max(1, min(actual_runtime, walltime_req))`, marks the job `RUNNING`,
  and schedules a `FINISH`. Nodes free themselves by interval expiry (no explicit free step),
  so `first_fit`/backfill see future frees.
- **Validation → `PolicyError`:** `place` raises a structured `PolicyError` with a stable `code`
  (`UNKNOWN_JOB`, `ALREADY_RUNNING`, `DEPS_UNMET`, `NO_NODES`, `MISMATCH`) instead of crashing.
  Deps are enforced by the *engine* even if a policy ignores them.
- **Event loop:** a single loop advances to the earliest event time, handles the whole batch
  (`EventQueue.pop_batch`), then runs one decision. `until` (the level horizon) is checked for
  *every* batch including the first; `max_events` is a hard `DeterminismError` loop guard. A
  `Scheduler` is single-use — calling `run` twice on the same mutable `Job`/`Cluster` raises.
- **Free fast-path:** `busy_node_slots` (running `nodes_req` total) lets a place-only policy skip
  its whole scan via `ctx.has_free_node()` when the cluster is saturated.
- **Deps:** the engine enforces `deps` in `place` (raises `DEPS_UNMET`), and the built-in policies
  *skip* dep-blocked jobs via `ctx._deps_done` so a normal run never raises. `place` also rejects
  duplicate node lists and `nodes_req < 1` (whole-node double-booking guard).
- **Accounting:** `_node_seconds_busy` and `_max_end` accrue incrementally at `place`; finished
  allocations are pruned via `Node.release`, so `_result` is O(1). `_t0` anchors the utilization
  window; duplicate job ids raise `DeterminismError`.
- **Determinism:** `queued`/`running` are exposed sorted by id; ties broken by `(submit_time, id)`
  and `(walltime_req, submit_time, id)`.
- `_safe_policy` is the seam where the Stage-2 kata driver will catch `StepBudgetError` and fall
  back to the default for that one decision.

## Depends on / used by

Uses `sim.cluster`, `sim.events`, `sim.jobs`, `sim.errors`. Used by `sim.level`, `sim.scoring`,
`sim.trajectory`, `cli`.
