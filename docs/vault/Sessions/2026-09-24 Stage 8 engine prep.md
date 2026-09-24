---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 8 (engine prep) — preemption + trace import

Built ahead of the Stage 8 UI/levels while the Stage 6 editor ran in parallel (engine-only files, no
`web/` collision). Both land as separate commits.

## Preemption (was a stub)

`Scheduler.preempt(job, t)` releases the running job's nodes, returns it to `QUEUED` with **no
checkpoint** (a re-run costs full runtime), and bumps `run_epoch`/`preempt_count`. Each `FINISH` event
is keyed `id#epoch`; the handler ignores any event whose epoch ≠ the job's current `run_epoch`, so a
preempted placement's stale `FINISH` can never finish a re-run job early. The kata `preempt` builtin
now calls it once the `preempt` tier unlocks (`not_running` for a bad target). Trajectory-neutral: the
epoch change and FINISH-key reformat leave every existing golden hash identical. Tests: `test_preempt.py`.

## Trace mode

`import_sacct_csv` maps a Slurm sacct CSV (JobID/User/Submit/Elapsed/NNodes/ReqTimelimit; durations
`DD-HH:MM:SS` and ISO timestamps; anchored at t=0) to an id-ordered job list; `level_from_jobs` wraps
it in a playable level with an **explicit `jobs` list** (no generator). `validate_level`/`load_jobs`
now accept a `generator` *or* explicit `jobs`. New CLI: `dojo import-trace <csv> [--out …]`. A sample
anonymized trace + `test_trace_import.py` cover column mapping, t=0 anchoring, determinism, runnability.

## Still pending for Stage 8

Multi-site `route`/`transfer_cost` (still stubs) and the level 6–9 JSONs that exercise tags/partitions,
DAG, preemption, and two-site routing, plus the endless/drift mode. See [[Levels]] and [[Kata]].
