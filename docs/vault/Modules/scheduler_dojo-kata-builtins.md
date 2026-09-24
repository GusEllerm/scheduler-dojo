# scheduler_dojo/kata/builtins.py

> [!abstract] Role
> The bridge between a running kata and the live scheduler: an `Env` wrapping a `PolicyContext` +
> cluster that exposes the tier-gated builtin functions and record fields as kata values.

## What it does

`Env(ctx, *, unlocked, step_budget, memory)` provides the spec §6 builtins (`bi_*` methods, dispatched
by `invoke`), record wrappers (`JobRec`, `NodeRec`, `UserRec`, `SiteRec`, `TupleRec`), and the
queue-order hook (`set_queue_order`, `queue_jobs`). `sortable(v)` coerces a kata value to a Python
sort key; `truth(x)`, `_plain(v)` normalize for operators.

## How it works

- **Tiers** (`TIERS`) gate builtins and gated fields: calling a locked builtin → `slot_locked`;
  reading a gated field like `job.actual_runtime` → `sensor_locked`. `check_builtin(name, nargs,
  line)` enforces arity (`ARITY`) and unlock before dispatch.
- **Determinism of the views**: `queue()` is a **stable** `sorted` of the id-ordered `ctx.queued`
  under the decision's `order_key` (installed from the `order` module), so ties keep job-id order;
  `nodes()`/`running()`/`free_nodes()` are in defined order. This is what makes a kata's decisions
  replayable (see [[Determinism]]).
- **`reserve(job, t)` is a simplification** — it validates `t >= now` and records the intent in a
  per-decision dict rather than writing a future-dated cluster allocation (the engine has no
  reservation→commit step yet); `reservation_start(job)` reads it back. `earliest_fit(job)` scans
  candidate times deterministically. Full reservations/backfill land in Stage 3.
- `memory` holds `remember`/`recall` state, shared across decisions within one run.

## Depends on / used by

Consumes `sim.scheduler.PolicyContext`, `sim.cluster`, `sim.jobs`, `sim.errors`. Used by `kata.interp`.
