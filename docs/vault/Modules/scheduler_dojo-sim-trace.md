# scheduler_dojo/sim/trace.py

> [!abstract] Role
> Deterministic, seeded arrival generators that turn a level "generator spec" into an ordered
> `list[Job]`. The single source of demand for headless runs and the endless level.

## What it does

`generate_jobs(spec, seed, *, horizon=None) -> list[Job]`. Spec keys (all optional; defaults in the
docstring): `n_jobs`, `users[{name,weight}]`, `arrival` (`poisson` with `rate_per_hour`, or
`uniform` with `first`/`last`), `nodes` (`fixed`/`discrete`), `walltime` (`fixed`/`lognormal`),
`runtime_ratio` (`lognormal`/`fixed`), and the optional `requires` menu
(`[{weight, partition?, tags?}, ...]`) that gives each job a drawn placement constraint (Level 6's
partition/tag jobs). `poisson_jobs(...)` is a convenience wrapper.
`import_sacct_csv` reads a Slurm sacct CSV (JobID/User/Submit/Elapsed/NNodes/ReqTimelimit) into an
id-ordered job list anchored at t=0; `level_from_jobs` wraps it in an explicit-`jobs` playable level.

## How it works

- **One RNG, fixed draw order.** A single `random.Random(seed)`; per job the draws happen in a
  fixed sequence (arrival delta → user → nodes → walltime → ratio → — only when the spec carries
  `requires` — one weighted constraint pick), so the same seed yields the
  same jobs in both CPython and Pyodide ([[Determinism]]). `math.exp`/`E **` never read the clock.
  A spec *without* `requires` performs no extra draw, so pre-existing seeds stay byte-identical.
- **`actual_runtime` lies by design**: `round(walltime_req * ratio)` with a lognormal ratio, so
  Level 4's walltime-lies pain and bounded-slowdown pressure come for free.
- **Arrivals are monotonic**: Poisson deltas are clamped with `submit = max(prev, ...)`; the rows
  are sorted by submit before ids (`j{i:06d}`) are assigned, and the result is returned sorted by
  `(submit_time, id)`.
- **Guards** (from the adversarial review): `_finite` rejects NaN/inf inputs with a clear
  `ValueError`; `_walltime`/`_ratio` clamp the exponent to `MAX_LOG` so a huge finite `sigma` gives
  a huge (finite) value instead of `OverflowError`; `discrete` probabilities must be non-negative
  and sum to > 0.

## Depends on / used by

Uses `sim.jobs.Job`. Used by `sim.level` and the endless/offline drift (Stage 7).
