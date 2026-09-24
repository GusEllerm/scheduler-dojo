# scheduler_dojo/sim/errors.py

> [!abstract] Role
> Structured engine errors so a bad policy action is a teaching moment, never a crash.

## What it does

`EngineError` base (with a stable `code` and optional kata `line`); subclasses `PolicyError`
(invalid action), `StepBudgetError` (kata ran out of breath — Stage 2), `DeterminismError`
(internal invariant violated, should never fire). Module-level code constants: `UNKNOWN_JOB`,
`ALREADY_RUNNING`, `DEPS_UNMET`, `NO_NODES`, `MISMATCH`, `PAST_TIME`.

## How it works

The UI and tests key off `code`, not the message text. `sim.scheduler.place` raises `PolicyError`
with these codes; the kata interpreter (Stage 2) will attach `line` so errors render against the
right kata line.

## Depends on / used by

Used by `sim.scheduler` (and later `kata`). No dependencies.
