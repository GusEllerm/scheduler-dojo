# scheduler_dojo/kata/formatter.py

> [!abstract] Role
> Canonical Kata text from an AST, so two identical katas produce byte-identical text — the basis for
> comparing share-card payloads without a server.

## What it does

`format_program(program) -> str` and `format_expr(expr) -> str` (the AST path, no parser needed);
`format(src) -> str` parses then prints. Used by `dojo kata format` and share-card canonicalization.

## How it works

- **Canonical ordering**: `def`s first (alphabetical), then modules in slot order
  `order, place, preempt, route`; 4-space indent; blank line between sections; a single trailing
  newline; empty blocks print `pass` so output always re-parses.
- **Parenthesization**: precedence `or < and < not < cmp < + - | < * / // % < unary- < atoms`; a child
  gets parens iff its precedence is below the position's minimum (left = `prec(op)`, right =
  `prec(op)+1` since binary ops are left-assoc ⇒ `a - (b - c)` keeps parens). Single-element tuples
  print `(a,)`.
- **Idempotent** (`format(format(src)) == format(src)`) and **round-trips** (`parse(format(src)) ==
  parse(src)` — AST equality ignores the `line` field, see [[scheduler_dojo-kata-ast]]).

## Depends on / used by

Consumes `kata.ast` (and `kata.parser` only for `format(src)`). Used by `kata.check.canonical_equal`,
`dojo kata format`, and Stage-9 share cards.
