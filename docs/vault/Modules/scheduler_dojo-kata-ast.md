# scheduler_dojo/kata/ast.py

> [!abstract] Role
> The frozen node dataclasses shared by the parser, interpreter, and formatter — the single source
> of node shapes (the surface syntax lives in `spec.md`).

## What it does

Expression nodes (`Int`, `Float`, `Bool`, `Nil`, `Str`, `Name`, `Attribute`, `Tuple`, `ListLit`,
`Call`, `BinOp`, `UnaryOp`, `BoolOp`, `Ternary`) and statement nodes (`Assign`, `Remember`, `If`,
`For`, `While`, `Return`, `Pass`, `ExprStmt`), plus top-level `Def`, `Module`, and `Program`.

## How it works

- All nodes are **frozen dataclasses** so a `Program` compares/prints deterministically — that is what
  makes the formatter's round-trip property test (`parse∘format == id`) meaningful.
- Statement nodes carry a `line` field declared `compare=False, repr=False`: it exists for error
  carets but is *excluded from equality* so an AST round-trip compares equal regardless of line
  numbers. See `_line()`.
- `Program.slots()` maps each `SLOTS` name to its module; at most one module per slot.

## Depends on / used by

No dependencies. Used by every other `kata.*` module.
