# scheduler_dojo/kata/interp.py

> [!abstract] Role
> A tree-walking evaluator that runs one slot module against an `Env`, under a step budget.

## What it does

`Interp(env, defs)` with `run_module(module, scope)` (module-level `run_module(module, env, defs,
scope)`) executes statements and returns a `ModuleResult(value, scope)`. It implements spec §3
semantics and the step budget (spec §5).

## How it works

- One **step** is counted per statement, per expression-node eval, and per builtin call, all through
  `env.step(line)`; over budget raises `StepBudgetError(code="step_budget", line=...)`. Budget counts
  nodes, not bytes, so `|` (list concat) is separately capped at `_MAX_LIST` (200k) — `xs = xs | xs`
  doubles per step and would OOM-kill the process; the cap turns it into a clean `policy` fallback.
- Raises the static/runtime codes from spec §9 as `EngineError`: `undefined_name`, `no_such_field`,
  `type`, `arity`, `no_such_builtin`, `max_depth` (recursion cap 200, converted from Python's own
  `RecursionError`), each carrying the offending statement's `line`.
- Booleans short-circuit; `/` yields float, `//` floor; STRING values are only legal in `==`/`!=`
  against a name-typed field, else `type` (see `spec.md` §4).
- For the `order` slot the body binds `key` (or `return key`); that key drives `Env.queue()` order for
  the same decision.
- Determinism comes from `Env` (see [[scheduler_dojo-kata-builtins]]) — no set/dict order leaks
  (see [[Determinism]]).

## Depends on / used by

Consumes `kata.ast`, calls into `kata.builtins.Env`, raises `sim.errors`. Used by `kata.policy`.
