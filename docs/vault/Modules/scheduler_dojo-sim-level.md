# scheduler_dojo/sim/level.py

> [!abstract] Role
> Build a runnable scenario (a `Cluster` and its arriving `Job`s) from a level dict, and run it
> headless. The single seam between "level as data" and "scenario as objects".

## What it does

`build_cluster(spec)` accepts either the full `sites` topology or a `nodes` shorthand (one implicit
site + partition). `load_jobs(level, seed)` delegates arrival generation to
`sim.trace.generate_jobs`. `run_level(level, seed=, policy=, kata=)` builds, schedules — with a named
policy from `sim.scheduler.POLICIES`, or a `KataPolicy` over the level's `unlocks` when `kata` is
passed — and runs to the level's `duration`. `load_level_file` reads JSON; `_kata_source` resolves a
kata argument to source text (a readable path vs literal source, guarding a multi-line program from
being stat'd as a filename).

## How it works

The full level schema (unlocks, sensors, weights, pass/gold bars) is Stage 3; this loader only
consumes `cluster`, `generator`, `duration`, and — when present — `score_weights`/`score_anchors`
for the CLI's score line. Keeping construction here means goldens, the CLI, and the browser bridge
build identical scenarios from identical JSON.

## Depends on / used by

Uses `sim.cluster`, `sim.jobs`, `sim.scheduler`, `sim.trace`. Used by `cli`, `scripts/gen_goldens.py`,
`tests/test_golden.py`.
