---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 0 — Bootstrap

## Goal

Stand up the repo, package, CI, and vault exactly per `PROMPT.md` §3, and add the Stage 0 extras
(dev deps, `ci.yml`, a Determinism note) so CI is green on the remote.

## What was done

- `git init -b main`, `uv init --package` (Python 3.12), `.gitignore`, `init` commit.
- Public repo `GusEllerm/scheduler-dojo` created and pushed.
- `livedocs new-vault docs/vault --scaffold-modules`; activated `.githooks` via
  `git config core.hooksPath .githooks`; `vault` commit (all scaffold notes stamped).
- Renamed the console script to `dojo` → `scheduler_dojo.cli:main`; added `scheduler_dojo.cli`
  with a `--version` path and a `tests/test_smoke.py` (3 passing).
- `uv add --dev pytest pytest-cov`; added `[tool.pytest.ini_options]`.
- `.github/workflows/ci.yml`: uv + Python 3.12 + livedocs (git source) + `pytest` + `livedocs verify`.
- `Concepts/Determinism.md`, `Decision Log.md`, and a `Home.md` status/plan rewrite.

## Decisions

See [[Decision Log]] (console-script name, Python floor, CI livedocs source).

## Next

Stage 1 — simulator core, headless: parallel builders for `sim/{events,cluster,jobs}.py`,
`sim/scoring.py`, `sim/trace.py`, then integrate `sim/scheduler.py` with FIFO + shortest-first and
wire `dojo run`. Contracts (module signatures + a fixture level) first, then parallelize.
