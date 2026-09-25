# scheduler_dojo/sim/scoring.py

> [!abstract] Role
> Turn a `RunResult` into raw metrics and a 0..1000 normalized score.

## What it does

`metrics_from_run(run, jobs=None, cluster=None)` returns a dict of `utilization`,
`bounded_slowdown`, `wait_p95`, `fairness` (and `sla` only when `jobs` is passed, since
`JobResult` does not carry `sla`; its phase-two `placed_nodes`/`run_site` fields feed the campus,
not the metrics). `normalize(name, value, anchor)` and
`score(metrics, weights, anchors)` implement the level's 0..1000 blend.

## How it works

- **Normalization** (see [[Scoring]]): `score = 300 + 500 * blend`, where `blend` is the
  weight-normalized sum of `normalize(m)` over the metrics present, each linearly mapped so the
  level's *baseline* metric → 0 and *reference* → 1. Result clamped to [0,1000] and rounded to an
  int, so FIFO lands ~300 and the reference kata ~800 by construction.
- **utilization** prefers `run.node_seconds_busy / run.node_seconds_total` (the scheduler now
  populates the total). Fallback when the total is 0: numerator `sum(nodes_req*runtime)`,
  denominator `nodes * (end_time - min submit)` with `nodes` = cluster size, else distinct touched
  nodes, else peak concurrent demand — all valid upper bounds so util stays ≤ 1.
- **bounded_slowdown** = mean of `max(wait+run,10)/max(run,10)`; **wait_p95** is nearest-rank
  `ceil(0.95·N)-1` with a tiny epsilon. Both are measured over **all submitted jobs at the run
  horizon**, not just finished ones: a never-started job counts as pure wait, a still-running job
  as open turnaround. So a run where nothing finishes scores *worst* — an idle run can never
  outscore a run that did work (fixed after the adversarial review).
- **fairness** is Jain's index of delivered/entitled shares
  (`entitled = nodes_req·walltime_req`), skipping zero-entitled users, 1.0 when there is no
  discrimination to measure. Users are summed in sorted-name order.
- Every sum/iteration is in **job-id or sorted-user order** — no set/dict order leaks in
  (see [[Determinism]]).

## Depends on / used by

Consumes `RunResult`, `JobResult`, optionally `Job`/`Cluster`. Used by `cli` and (Stage 3) the
calibration script.
