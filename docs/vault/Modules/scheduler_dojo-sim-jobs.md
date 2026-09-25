# scheduler_dojo/sim/jobs.py

> [!abstract] Role
> The job record: what a job is, its lifecycle states, and the immutable per-job result a
> finished run carries to the scorer.

## What it does

Defines `Job` (the mutable simulation entity), `JobState` (`QUEUED`/`RUNNING`/`COMPLETED`/
`TIMEOUT`), and `JobResult` (the immutable scoring record built by `JobResult.from_job`, which also
carries the phase-two `placed_nodes` (real node ids) and `run_site` — trailing defaulted fields, so
`trajectory_str` and every existing hash are untouched). A job
is whole-node: it occupies `nodes_req` whole nodes for `runtime_used` seconds.

## How it works

- `Job.actual_runtime` is the *truth* the engine always knows; `walltime_req` is the request that
  may lie. A job is `TIMEOUT` when `actual_runtime > walltime_req` (killed at the walltime it
  asked for). `wait_time`/`runtime_used` are derived properties (`None` until the job has run).
- `Job.id` is a stable string and the deterministic sort tiebreaker everywhere downstream — it is
  assigned by the trace generator after sorting by `(submit_time, index)`.
- Fields `state`/`start_time`/`end_time`/`placed_nodes` are runtime state the scheduler mutates;
  `run_epoch` (bumped on every place/preempt, to invalidate stale `FINISH` events) and `preempt_count`
  (a livelock-guard signal) are likewise scheduler-owned. `home_site`/`data_mb` are multi-site inputs;
  `run_site` (set by `Scheduler.route`) records the site a job is routed to. The rest are immutable inputs.

## Depends on / used by

Used by `sim.scheduler`, `sim.trace`, `sim.scoring`. No engine dependencies of its own.
