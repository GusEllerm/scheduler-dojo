# scheduler_dojo/kata/lexer.py

> [!abstract] Role
> Turn Kata source text into a token stream with INDENT/DEDENT, for the parser and the UI syntax mode.

## What it does

`tokenize(src) -> list[Token]` emits `Token(type, value, line, col)` (line 1-based, col 0-based).
`KEYWORDS` (a frozenset) and `TOKEN_TYPES` (a tuple) are exported so the editor's syntax
highlighting is *generated from* the same source of truth as the grammar.

## How it works

- Python-tokenize style block structure: each content line ends with `NEWLINE`; a deeper indent emits
  `INDENT`, a dedent emits one `DEDENT` per popped level, EOF flushes the rest. Blank/comment-only
  lines emit nothing. Comments are `#` to EOL (spec §1).
- Tab in leading whitespace → `KataSyntaxError(code="tab")`; a dedent landing between open levels →
  `code="bad_indent"`. `never` is intentionally *not* a keyword so `preempt by never:` parses with
  label "never".
- Deterministic and pure: no IO beyond the input string, no clock (see [[Determinism]]).

## Depends on / used by

Uses `kata.errors.KataSyntaxError` and the grammar in `spec.md`. Used by `kata.parser`;
`KEYWORDS`/`TOKEN_TYPES` are consumed by the Stage-6 editor.
