# scheduler_dojo/kata/errors.py

> [!abstract] Role
> The syntax-error shape with a caret, layered on the engine's structured errors.

## What it does

`KataSyntaxError(message, *, code, line, col)` subclasses `sim.errors.EngineError` (re-exported here
alongside `PolicyError`/`StepBudgetError`) and adds `.col` and `caret(source_lines)` rendering
`line N: code: msg` plus the offending line with a `^` under the column.

## How it works

- Reuses the single `EngineError` base so the whole engine surfaces errors the same way; the base now
  stores `self.message` so `caret()` (and the UI) can read it (fixed during Stage 2).
- Every `code` maps to a spec §9 catalogue entry — a one-line teaching message, never a stack trace.

## Depends on / used by

Extends `sim.errors`. Used by `kata.lexer`, `kata.parser`, `kata.check`.
