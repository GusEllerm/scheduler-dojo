# scheduler_dojo/kata/parser.py

> [!abstract] Role
> Recursive-descent parser producing the frozen `ast.Program` for a kata.

## What it does

`parse(src) -> Program` (via `parse_program(tokens)`). Implements the grammar in `spec.md` §2.
Statement nodes get their source `line` set for error carets.

## How it works

- A program is top-level `MODULE`s (`slot by name:` block) and `DEF`s interleaved. Statements:
  assignment, `remember`, `if/elif/else`, `for`, `while`, `return`, `pass`, and bare-call
  expression statements.
- Expression precedence per spec §2; `|` is list concat; comparisons are `BinOp`. Single `(a)` is
  grouping, `(a,)`/`(a, b)` are tuples.
- **Static errors raised at parse time**: assignment lookahead *before* expression parsing gives
  `shadow_builtin` (`place = 3`); a dotted assignment target gives `field_write` (`job.x = 1`);
  empty `if` body → `syntax`; plus the lexer's `tab`/`bad_indent`.
- The if-chain resolves `elif`/`else` with a column check against the `if` token so an outer `else`
  never misbinds to an inner `if`.

## Depends on / used by

Uses `kata.lexer.tokenize` and builds `kata.ast` nodes; raises `kata.errors.KataSyntaxError`. Used by
`kata.__init__.parse`, `kata.formatter`, `kata.check`, and `sim.level.run_level`.
