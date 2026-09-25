# Scheduler Dojo

**Be the scheduler. Then automate yourself out of the job.**

A small game about batch scheduling. Each level is a fixed, deterministic cluster plus a stream of
jobs; your job is to keep the lanes busy and the waits short. You start by placing jobs by hand, then
write a *kata* — a few lines of a tiny policy language — and when the kata is good you no longer need
to touch the mouse. That is the lesson: a scheduler is a policy, and a policy you can write beats one
you cannot.

**Play here →** <https://gusellerm.github.io/scheduler-dojo/> (GitHub Pages — no install, no account).

## What it teaches

Intuition for the trade-offs a real batch scheduler (Slurm/PBS-flavoured) makes every second:
backfill versus starvation, utilization versus slowdown, estimates versus reality, fairness versus
throughput, partitions and tags, preempting the wrong job, and data locality across sites. Every run
is scored 0–1000 off those metrics, so "my policy is better" is a claim you can check, not a feeling.

## How it works

- **One deterministic engine, two hosts.** The simulator (`src/scheduler_dojo/sim/`) is pure Python on
  an integer clock, so a run has a `trajectory_hash`. It is built as a pure `py3-none-any` wheel, which
  Pyodide installs with micropip; every browser call crosses one JSON boundary
  (`src/scheduler_dojo/bridge.py`). The page and `dojo run` produce the same hash.
- **The kata language** (`src/scheduler_dojo/kata/`) is parsed to an AST and interpreted at each
  scheduling decision under a per-decision step budget, with builtins gated by the tiers you own. A
  broken or non-terminating kata falls back to FIFO rather than hanging the cluster.
- **Tamper-evident share cards** (`src/scheduler_dojo/share/`) embed the level, seed, policy/kata and the
  run's hash in a `?c=…` link plus a Canvas PNG. Opening the card re-runs it in the visitor's browser and
  prints **verified ✓** or **card tampered / hash mismatch ✗**; `dojo verify-card` does the same headless.

## Play

Open <https://gusellerm.github.io/scheduler-dojo/> and pick a level.

- **Watch (auto)** replays the level under its default policy and its reference kata — the bar to beat.
- **Play by hand** (levels 1–2) makes *you* the scheduler: pick a queued job, pick a node lane, confirm.
- **Write a kata** (levels 3–9) is the real game: edit, Check, Run, Step. Runs earn credits, credits buy
  upgrades (Reservations, Sensors, Fairness, Preemption, Routing), and each upgrade unlocks the kata
  builtins the later levels need. Belts track *lifetime* credits, so spending never demotes you.

Progress is saved in your browser (localStorage); share links are the portable form of it.

## The levels

| # | Level | The lesson |
|---|---|---|
| 1 | Warm-up: four nodes, one big job | Place jobs by hand and see that a big job needs all four nodes free at once. |
| 2 | You cannot keep up by hand | Jobs arrive faster than you can click; one line of policy is the difference. |
| 3 | The big job that never starts | Backfill: fill the gaps without starving the job that needs the whole node. |
| 4 | Trust, but verify | Padded walltimes and hard limits — schedule on estimates, not wishes. |
| 5 | Everyone at the table | Fairness: one talkative user must not tilt the whole queue. |
| 6 | The special machines | Partitions and tags: don't park ordinary jobs on the GPU nodes. |
| 7 | The urgent file | Preemption: whom you cut off, and what a lost checkpoint costs. |
| 8 | Data does not travel | Multi-site routing: colocate with the data or pay the transfer. |
| 9 | The whole board | Everything at once — the capstone mixed cluster. |

Each level is a fixed-seed puzzle whose `baseline_policy` scores exactly **300** and whose
`reference_kata` scores exactly **800** (pass bar 350–360, gold 720). The gold is *earned*: only metrics
where the reference is at least as good as the baseline are scored, so clearing it means genuinely
matching the reference's improvements — see `scripts/calibrate_levels.py`.

## Run it locally

```bash
uv sync                                       # Python 3.12, no runtime dependencies
uv run dojo run --level levels/level3.json    # headless run: metrics, score, trajectory_hash
bash scripts/build_wheel.sh                   # stage the pure wheel the browser installs
cd web && npm ci && npm run dev               # http://127.0.0.1:5173
```

Other CLI entry points: `uv run dojo kata check|format|run <file>`,
`uv run dojo import-trace <sacct.csv> --out <level.json>` (turn a real Slurm export into a playable
level), and `uv run dojo verify-card '<#c=…>'`.

## Development

```bash
uv run pytest                                 # 230 tests: sim, kata, levels, bridge, progression, share
uv run python scripts/calibrate_levels.py     # report baseline/reference scores (add --write to re-bar)
node scripts/node_smoke.mjs                   # the browser's compute path vs. the pytest goldens, in Node
bash scripts/build_wheel.sh                   # must stay py3-none-any or Pyodide cannot import it
cd web && npm run typecheck                   # tsc --noEmit
```

The Node smoke test is the important one: it loads the *real* wheel under Pyodide and asserts the
browser's answer equals the golden hash, so the game cannot quietly ship a different engine.
GitHub Pages deploys from `.github/workflows/pages.yml`.

## Notes

- Long-term memory and reasoning live in the vault: [`docs/vault/Home.md`](docs/vault/Home.md). Start with
  [`docs/vault/Concepts/Determinism.md`](docs/vault/Concepts/Determinism.md), then
  [`docs/vault/Concepts/`](docs/vault/Concepts/) — including
  [`docs/vault/Concepts/Accessibility.md`](docs/vault/Concepts/Accessibility.md) for the keyboard and
  screen-reader support (skip link, landmarks, labelled dialogs, live regions, visible focus,
  reduced motion).
- The web tier is plain TypeScript + Canvas, no framework: `web/src/main.ts` is the shell,
  `web/src/bridge.ts` the worker protocol, `web/src/render/timeline.ts` the Canvas timeline.
