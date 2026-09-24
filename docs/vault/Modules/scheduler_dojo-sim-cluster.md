# scheduler_dojo/sim/cluster.py

> [!abstract] Role
> Cluster topology (Site → Partition → Node) and whole-node occupancy as time-sliced
> allocation intervals.

## What it does

`Cluster` holds flat id-indexed maps over `Site`/`Partition`/`Node`. `Node` keeps an
`allocations: list[Allocation]` timeline; `free_at(t)` / `free_for(t, duration)` /
`next_free_time(t)` answer occupancy; `allocate(start, end, job_id, is_reservation)` records a hold
and `release(job_id)` drops a finished job's hold. `Cluster.first_fit(count, t, duration, ...)`
returns the `count` lowest-id compatible nodes free across `[t, t+duration)` or `None`.
`Cluster.can_host(count, ...)` is the same compatibility test with the *time* window removed — a
capacity ceiling for `fits_later`/backfill (could `count` compatible nodes ever host this job?).

## How it works

- **Whole-node invariant:** at any instant a node hosts at most one *running* holder; intervals on
  a node never overlap. Reservations are just future-dated `Allocation`s (`is_reservation=True`), so
  a current-state flag, so earliest-fit/backfill/reservations are expressible without a model
  change. `release` keeps timelines bounded by active +
  future holders so `free_for` stays cheap over a long run.
- **Canonical iteration order** is `Cluster.nodes`, cached once at construction and sorted
  explicitly by `node.id`, so it never depends on site/partition/node input order (see
  [[Determinism]]). `_iter_compatible` yields lazily in that order so `first_fit` stops as soon as
  it has `count` free nodes. Duplicate node ids raise at construction.
- `compatible_nodes`/`_iter_compatible` filter by partition name + `meets(cpus, mem, gpus, tags)`;
  `free_compatible_nodes` adds `free_at`. `meets` uses `set(tags).issubset(node.tags)` —
  order-independent by construction.
- `node_seconds_available(start, end)` = `num_nodes * (end-start)` is the utilization denominator.

## Depends on / used by

Used by `sim.scheduler` (placement, result accounting) and `sim.level`. Pure data + queries, no
clock of its own.
