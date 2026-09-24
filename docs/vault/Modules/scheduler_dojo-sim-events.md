# scheduler_dojo/sim/events.py

> [!abstract] Role
> A deterministic discrete-event queue: a min-heap with a *total* ordering so run order never
> depends on set/dict iteration.

## What it does

`EventKind` is an `IntEnum` whose value is the tie-break precedence:
`FINISH < ARRIVE < PREEMPT < TICK < DRIFT`. `EventQueue.add(time, kind, key, payload)` pushes an
`Event` with `sort_key = (time, kind, key, seq)`; `pop_batch()` drains every event at the earliest
time in that total order; `peek_time()` peeks.

## How it works

- Finishes are handled before arrivals at the same instant so freed capacity is available before
  new demand is offered; a monotonic `seq` breaks any remaining tie by insertion order.
- The loop calls `pop_batch()` once per decision point — all same-instant events are handled, then
  the policy runs exactly once.

## Depends on / used by

Used by `sim.scheduler` only.
