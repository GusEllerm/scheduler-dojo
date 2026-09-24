---
tags: [concept]
---
# Scoring

## In one line

Every level is scored 0..1000 from a weighted blend of metrics, normalized against the level's
FIFO *baseline* (~300) and *reference kata* (~800) so bars are comparable across levels.

## Raw metrics (from `sim.scoring.metrics_from_run`)

- **utilization** = busy node-seconds / available node-seconds (higher better). The scheduler
  supplies `node_seconds_busy` incrementally and `node_seconds_total = num_nodes * (end - t0)`.
- **bounded_slowdown** = mean of `max(wait+run, 10)/max(run, 10)` (lower better), measured over all
  submitted jobs at the run horizon (a never-started job is pure wait; a still-running job is open
  turnaround). The 10 s floor stops sub-10 s jobs from dominating. `wait_p95` is likewise over all
  submitted jobs at the horizon, so starving a job inflates it (an idle run cannot win).
- **fairness** = Jain's index of delivered/entitled node-seconds across users (higher better),
  skipping zero-entitled users; 1.0 when there is no discrimination to measure.
- **sla** = fraction of SLA-bearing jobs that started within their `sla`; only present when the
  caller passes `jobs` (`JobResult` carries no `sla`).

## Normalization → 0..1000 (`sim.scoring.score`)

Each metric maps linearly so its *baseline* value → 0 and *reference* value → 1 (inverted for
lower-better metrics); the mapped values are blended with the level's weights (normalized to sum
to 1 over present metrics) and mapped to `300 + 500 * blend`, clamped to [0,1000] and rounded. So
FIFO → ~300 and the reference kata → ~800 by construction. `pass`/`gold` bars (Stage 3) are
generated from these, never hand-typed — see `scripts/calibrate_levels.py`.

## Determinism note

Every metric sums in job-id or sorted-user order; percentile and Jain use fixed tie order, so the
score is identical in CPython and Pyodide ([[Determinism]]).

## Energy / transfer metrics

Declared in the schema but only populated by levels that model power price or multi-site transfer
(Stage 8); absent from the blend otherwise.
