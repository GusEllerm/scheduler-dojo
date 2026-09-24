---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 2 — Kata language

## Goal

A small, safe, deterministic policy language. A kata is a set of modules filling engine **slots**
(`order`, `place`, `preempt`, `route`); the engine runs them at decision points via a `KataPolicy`
that plugs into `Scheduler` like any other policy. Missing slots fall back to the Stage-1 built-ins.

## Interfaces (contract)

- `scheduler_dojo.kata` — `parse(src) -> Program`, `format(src) -> str`, `check(src) -> Report`.
- `scheduler_dojo.kata.interp.KataPolicy(program, builtins_enabled, step_budget=20000)` — a
  `Policy` callable; on a slot it runs the module or falls back to the default; on
  `StepBudgetError`/`PolicyError` it falls back to the default for that decision (never crashes).
- `scheduler_dojo.kata.builtins.Env` wraps a `PolicyContext` + cluster and exposes the tier-gated
  builtin functions/values to the interpreter.
- Error types reuse `sim.errors.StepBudgetError`/`PolicyError` + a new `kata.errors.KataSyntaxError`
  (line + caret).

## Split (builders, disjoint files)

- Spec + `ast.py` + `errors.py` + slot/`Program` data model: **orchestrator** (the contract).
- Builder A: `kata/lexer.py` + `kata/parser.py` (token list shared with the UI syntax mode).
- Builder B: `kata/interp.py` + `kata/builtins.py` (tree-walking eval, step budget, slot driver).
- Builder C: `kata/formatter.py` + `dojo kata check` wiring in `cli.py`.

## Decisions

Indentation-based, expression-oriented, no dicts/strings-beyond-equality, bounded steps — see
[[Decision Log]].

## Acceptance

- Reference katas for levels 2–5 parse, run, and beat FIFO on fixture levels.
- Every error-catalogue entry has a test.
- An infinite loop is stopped by the step budget within one decision (no crash; default used).
- The formatter is idempotent; format∘parse round-trips (property test).

## Outcome

Shipped. Three builders delivered the lexer/parser (31 tests), interp/builtins/policy (22 tests), and
formatter/check (13 tests) on disjoint files; the orchestrator owned `ast.py`/`errors.py`/`spec.md` and
wired the CLI (`dojo kata check|format|run`, `dojo run --kata`) and `run_level(kata=…)`. 17 acceptance
tests in `tests/test_kata.py` cover the four bars: reference katas beat FIFO on bounded slowdown (and
match the built-in shortest-first exactly), an infinite loop trips the per-decision step budget and
falls back to FIFO without crashing (`.last_fallback == "step_budget"`), each error-catalogue code
surfaces (`undefined_name`/`no_such_field`/`type`/`arity`/`sensor_locked`/`slot_locked`/`max_depth`),
and `check` reports `tab`/`syntax`/`field_write`/`shadow_builtin` with a caret. Adversarial review found
one real defect (CLI crash on a missing file — fixed + regression test) and one false positive
(formatter round-trip, verified fine). Whole suite: **158 passing**. Two orchestrator-integration bugs
fixed along the way (`EngineError.message`, kata source-vs-path detection). Notes: [[Kata]] + nine
`kata.*` module notes.
