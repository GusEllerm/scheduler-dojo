# scheduler_dojo/sim/scheduler.py

> [!abstract] Role
> The discrete-event scheduling loop and the two built-in policies. This is the engine every
> policy (built-in or kata) drives.

## What it does

`Scheduler(cluster, jobs, policy)` seeds one `ARRIVE` per job, advances an integer clock, and at
each decision point calls `policy(ctx)`. `PolicyContext` exposes `now`, `queued`, `running`,
`free_nodes()`, `fits_now(job)`, `fits_later(job)` (a time-agnostic capacity ceiling via
`Cluster.can_host`, so backfill katas hold room for a job that cannot fit *now*), and
`place(job[, nodes])`. `fits_now` asks `first_fit` with the job's target site (`run_site or
home_site`) — the same restriction `place` enforces — so a site-pinned job never "fits" somewhere
it can never run (a default policy would otherwise attempt a placement that raises). `run(until=None)` returns a `RunResult`; `step_events(n)`/`run_until(t)` drive
the *same* event-loop body (`_advance`) so a stepped run is bit-for-bit a full run (the stepping API
for animated playback in the browser). `fifo`, `shortest_first`, and `idle`
(place-nothing, the calibration/hand baseline) are plain-Python policies registered in `POLICIES`.

## How it works

- **Whole-node placement:** `place` allocates each chosen node for `[t, t + runtime_used)`
  where `runtime_used = max(1, min(actual_runtime, walltime_req))`, marks the job `RUNNING`,
  bumps its `run_epoch`, and schedules a `FINISH` keyed `id#epoch`. Nodes free themselves by interval
  expiry (no explicit free step), so `first_fit`/backfill see future frees.
- **Preemption:** `preempt(job, t)` (the Stage-8 primitive; the kata `preempt` builtin calls it once
  the `preempt` tier is unlocked) releases the running job's nodes, returns it to `QUEUED` with no
  checkpoint (it re-runs in full), and bumps `run_epoch` and `preempt_count`. The `FINISH` handler
  ignores any event whose `#epoch` does not equal the job's current `run_epoch`, so a preempted
  placement's stale `FINISH` can never finish a re-run job early. A non-running target raises `NOT_RUNNING`.
- **Multi-site routing:** `route(job, site, t)` (Stage 8; the `route` builtin calls it once the tier
  unlocks) records the job's `run_site`. At `place`, if `run_site != home_site` the run is lengthened
  by `transfer_secs = ceil(data_mb / transfer_rate_mbs)` and `first_fit(..., site=run_site)` restricts
  placement to that site's nodes. Single-site (no `home_site`) adds nothing, so existing hashes are unchanged.
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
- **Patience rings (phase two):** constructed with `pressure={"cap", "end_on_overflow"}` (levels
  without the block never compute rings — hash-identical to phase one), `_compute_pressure` runs at
  every batch: per user, the max over unfinished jobs of `wait / ((cap-1) x est)` clamped to [0,1]
  (`est` = `walltime_req`, what the job claimed), stored in `pressure`; the first job at 1.0 sets
  `overflow_user`/`overflow_time`, and with `end_on_overflow` the run stops there (`is_stopped()`
  covers both endings). Ring levels tick (`tick≈duration/70` via `sim.level`/`bridge._tick_for`) so
  rings fill between events; TICK reschedules to the next boundary bounded by `horizon`, never by a
  step's `until`, so stepped and full runs agree.
- **Decision trace (phase two):** `trace=N` keeps a ring buffer of the last N records on `Scheduler.trace`
  (`place`/`preempt`/`route` emit from the engine; the kata adds `order` keys + `fallback` codes via
  its `tracer`); `trace=0` pays nothing. `reservations` mirrors `reserve()` intents for snapshots.
- `_safe_policy` is the seam where the Stage-2 kata driver will catch `StepBudgetError` and fall
  back to the default for that one decision.

## Depends on / used by

Uses `sim.cluster`, `sim.events`, `sim.jobs`, `sim.errors`. Used by `sim.level`, `sim.scoring`,
`sim.trajectory`, `cli`.
