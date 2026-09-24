# scheduler_dojo/sim/trajectory.py

> [!abstract] Role
> The canonical fingerprint of a run — the single source of truth for "two runs are identical".

## What it does

`trajectory_str(result)` renders one line per job, `id,start,end,state`, in job-id order (`-` for a
job that never started, state in `done`/`timeout`/`unfinished`). `trajectory_hash(result)` is its
sha256 hex digest.

## How it works

Because `RunResult.jobs` is already in id order, the encoding is deterministic and cheap. The CLI,
`scripts/gen_goldens.py`, `tests/test_golden.py`, and Stage-9 share verification all hash through
this one function, so a timing or outcome change flips one hash everywhere at once.

## Depends on / used by

Consumes `RunResult`. Used by `cli`, goldens, and share verification.
