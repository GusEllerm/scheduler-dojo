# scheduler_dojo/sim/level.py

> [!abstract] Role
> Build a runnable scenario (a `Cluster` and its arriving `Job`s) from a level dict, and run it
> headless. The single seam between "level as data" and "scenario as objects".

## What it does

`build_cluster(spec)` accepts either the full `sites` topology or a `nodes` shorthand (one implicit
site + partition). `load_jobs(level, seed)` delegates arrival generation to
`sim.trace.generate_jobs`. `validate_level(level)` is the single schema gate (raises `LevelError`
with a `level_schema`/`level_metric`/`level_bars` code). `run_level(level, seed=, policy=, kata=)`
validates, defaults `seed` to the level's fixed puzzle `seed` and `policy` to the level's
`default_policy`, schedules with a named policy from `sim.scheduler.POLICIES` or a `KataPolicy` over
the level's `unlocks` when `kata` is passed, and runs to `duration`. `load_level_file` reads JSON;
`_kata_source` resolves a kata argument to source text (a readable path vs literal source, guarding a
multi-line program from being stat'd as a filename). `KNOWN_METRICS`/`KNOWN_TIERS`/`KNOWN_SENSORS`
back the validator.

## How it works

The full level schema (see [[Levels]]) — `unlocks`, `sensors`, `score_weights`/`score_anchors`,
`bars`, `baseline_policy`, `primary_metric`, `seed` — is validated here and consumed by
`run_level`/the CLI so goldens, the CLI, and the browser bridge build identical scenarios from
identical JSON. `scripts/calibrate_levels.py` writes the anchors that make the pass/gold bars real.

## Depends on / used by

Uses `sim.cluster`, `sim.jobs`, `sim.scheduler`, `sim.trace`. Used by `cli`, `scripts/gen_goldens.py`,
`tests/test_golden.py`.
