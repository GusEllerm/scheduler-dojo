# scheduler_dojo/kata/check.py

> [!abstract] Role
> A never-raising syntax checker that returns a structured `Report` with a caret — the editor's red
> squiggle and `dojo kata check`.

## What it does

`check(src) -> Report` (`Report{ok, errors:[{code,message,line,col}]}`) parses and reports syntax
errors, then runs cheap AST scans (`_static_errors`) for `field_write`/`shadow_builtin`.
`format_report(report, source)` renders each error as `line N: code: msg` + the source line + a `^`
caret. `canonical_equal(a, b)` is `format(a) == format(b)`.

## How it works

- It **catches** `KataSyntaxError` and never propagates it, so a broken kata produces a teaching
  message, never a crash (spec §9). The parse-time codes (`syntax`, `bad_indent`, `tab`,
  `unterminated_block`, `field_write`, `shadow_builtin`) all come through `kata.parser`.
- Deliberately *not* here: `undefined_name`, scope/tier/runtime errors — those need the engine and are
  the interpreter's job (see [[scheduler_dojo-kata-interp]]).
- Lives on the `kata.check` submodule rather than the `kata` package namespace: a package-level `check`
  *function* would be shadowed by this *module* of the same name on import (a deliberate naming note).

## Depends on / used by

Uses `kata.parser.parse`, `kata.formatter.format`, `kata.errors`. Used by `dojo kata check` and the
Stage-6 editor.
