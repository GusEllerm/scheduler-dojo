# scheduler_dojo/kata/policy.py

> [!abstract] Role
> `KataPolicy` — a `sim` `Policy` the `Scheduler` calls at each decision, driving the kata's slot
> modules and never crashing a run.

## What it does

`KataPolicy(program, *, unlocked, step_budget=20000)` is callable as `__call__(ctx)`. Per decision it
runs the `order` module (compute the queue key), then the `place` module (which may `place`/`reserve`),
skipping absent slots. It tracks `.fallbacks` and `.last_fallback` for the UI.

## How it works

- `_apply_order` runs the order body **once per queued job**, collects the `key` bindings into
  `order_key(job)`, and installs it via `env.set_queue_order`, so the `place` module sees `queue()`
  in the chosen order for that same decision. No order module ⇒ key `(submit_time, id)` = FIFO, which
  reduces the default placement to the engine's `fifo` exactly.
- **Safety**: any `EngineError` (incl. `StepBudgetError`), and finally any `Exception`, raised inside a
  module is caught; `.fallbacks` increments, `.last_fallback` records the code, and the decision is
  finished with FIFO first-fit. A `while true: pass` kata therefore completes identically to FIFO with
  `.last_fallback == "step_budget"`.
- The step budget is **per decision** and shared across the order pass and the place pass.

## Depends on / used by

Consumes `kata.ast`, `kata.interp`, `kata.builtins`, `sim.scheduler` (fallback). Used by
`sim.level.run_level` and the `dojo kata run` / `dojo run --kata` CLI paths.
