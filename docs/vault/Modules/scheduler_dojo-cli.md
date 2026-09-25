# scheduler_dojo/cli.py

> [!abstract] Role
> The `dojo` command-line skin over the engine. Stage 1 ships `dojo run`; more subcommands land
> with their stages.

## What it does

`main(argv)` builds an argparse parser with a `--version` flag, a `run` subcommand
(`--level <json> | --level-json`, `--seed`, `--policy fifo|shortest_first`, `--kata <file>`) —
pressure/ring levels tick and can end early in the CLI exactly as in the browser (one engine, one
calendar, no trace unless asked) — and a
`kata` subcommand (`check | format | run` over a kata file or `-` for stdin). `run` prints a JSON
summary: `n_jobs`, `end_time`, `node_seconds_busy`, `metrics`, `trajectory_hash`, and — when the
level declares them — a normalized `score`. `_cmd_run` and `_cmd_kata` are the handlers; `kata check`
prints a caret report and exits 2 on an unreadable file rather than a traceback. Two Stage-8/9
subcommands: `import-trace <csv>` (sacct export → an explicit-jobs level, `dojo import-trace`), and
`verify-card <payload>` (decode + `replay_card`, exit 1 if the trajectory hash disagrees).

## How it works

It imports `sim.scoring`, `sim.level`, and `sim.trajectory` lazily so `--version` works before the
engine imports exist. It adds no logic of its own; every number is whatever `run_level`/
`metrics_from_run`/`score`/`trajectory_hash` return, so the CLI and the goldens can never disagree.

## Depends on / used by

Uses `scheduler_dojo.sim` (level, scoring, trajectory) and `scheduler_dojo.kata` (parse/format/check,
KataPolicy). The entry point `dojo = scheduler_dojo.cli:main` is declared in `pyproject.toml`.
