# Kata — the Scheduler Dojo policy language (spec v1)

Kata teaches the *patterns* of scheduling, not a Python subset. It is small enough to fit on a
share card, safe to run untrusted (no IO, no imports, bounded steps), and deterministic.

A **kata** is a set of **modules**, each filling an engine **slot** consulted at a decision point.
Missing slots use the level default (FIFO `order`, first-fit `place`, no `preempt`, `local`-only
`route`).

```
order by shortest_first:
    key = (job.walltime_req, job.submit_time)

place by backfill:
    head = first(queue())
    if head != nil and fits_now(head):
        reserve(head, earliest_fit(head))
    for j in rest(queue()):
        if fits_now(j) and end_if_started_now(j) <= reservation_start(head):
            place(j)

preempt by never:
    pass
```

---

## 1. Lexical structure

- **Indentation-constructed blocks.** A `:` line opens a block; the following lines at greater,
  consistent indentation are its body; a dedent closes it. Indent units are spaces (tab is a token
  error). The amount is the first child's indent (Python-style), and all siblings must align.
- **Comments**: `#` to end of line. No block comments.
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`. Case-sensitive.
- **Literals**: integers (non-negative, `_` separators), floats, `true`/`false`, `nil`. No strings
  except bare **names** used only for equality against `partition`/tag/user fields — see §4.
- **No** semicolons (newline separates statements), no trailing commas requirement, no line joins.

## 2. Grammar (EBNF)

```
program     := module*
module      := slot "by" name ":" INDENT stmt* DEDENT
            | slot "by" "never" ":" INDENT "pass" DEDENT
slot        := "order" | "place" | "preempt" | "route"
name        := IDENT                       # module label, cosmetic (shown on the card)

def         := "def" IDENT "(" params? ")" ":" INDENT stmt+ DEDENT
params      := IDENT ("," IDENT)*

stmt        := "if" expr ":" INDENT stmt+ DEDENT elif* else?
            | "for" IDENT "in" expr ":" INDENT stmt+ DEDENT
            | "while" expr ":" INDENT stmt+ DEDENT
            | "return" expr?
            | "pass"
            | "remember" IDENT "=" expr
            | target "=" expr               # assignment
elif        := "elif" expr ":" INDENT stmt+ DEDENT
else        := "else" ":" INDENT stmt+ DEDENT

target      := IDENT attr*                   # rebinding or field write is rejected (see §5)

expr        := or_expr
or_expr     := and_expr ("or" and_expr)*
and_expr    := not_expr ("and" not_expr)*
not_expr    := "not" not_expr | comparison
comparison  := adder (("<" | "<=" | ">" | ">=" | "==" | "!=") adder)?
adder       := mul (("+" | "-" | "|") mul)*  # "|" = list concat
mul         := unary (("*" | "/" | "//" | "%") unary)*
unary       := ("-" )? atom
atom        := INT | FLOAT | "true" | "false" | "nil" | IDENT attr*
            | IDENT "(" args? ")"            # call (builtin or user def)
            | "(" inner ")"                  # tuple (1 element needs trailing comma), or grouping
            | "[" (expr ("," expr)*)? "]"     # list literal
inner       := expr ("," expr)+ | expr ","    # >=2 elements, or 1 element w/ trailing comma → tuple
attr        := "." IDENT                      # field access on a record
args        := arg ("," arg)* ("," IDENT "=" expr)*   # positional then keyword
```

Operator precedence (loosest first): `or`, `and`, `not`, comparison, `+ - |`, `* / // %`, unary `-`,
attribute access / call. `in` is only used by `for`, not as an operator (v1).

## 3. Statements

- `target = expr` — **local** binding only. Writing to a record field (`job.x = …`) is a static error
  `field_write`. Rebinding a slot builtin name (`place`, `queue`, …) is a static error `shadow_builtin`.
- `if/elif/else`, `for x in xs`, `while cond` (bounded by the step budget). `for` iterates lists and
  ordered lists of records in a defined order (§7).
- `return [expr]` — exits the current function/module body with a value (or `nil`). In an `order`
  module, the yielded key may also just be the last expression's binding named `key`.
- `pass` — no-op (lets `preempt by never:` be explicit).
- `remember name = expr` — store in the kata's bounded per-run memory (unlocked by `remember` in a
  level's `unlocks`). `recall(name)` reads it; absent → `nil`.

The **`order` slot contract**: its body must bind `key` (or `return key`) to the sort key. The
engine sorts `queue()` by that key (stable, tie → job id).

## 4. Values and records

- **Scalars**: int (arbitrary precision), float, bool, `nil`. Division `/` is float; `//` floor; `%`
  modulo. Mixing int/float promotes to float.
- **Tuples** `(a, b, ...)` and **lists** `[a, b, ...]`. Tuples are hashable-ish keys for sorting;
  lists support `|` concat, indexing `xs[i]`, `len(xs)`. No dicts in v1.
- **Strings**: v1 has no general string type. It admits **double-quoted string literals** *only* on
  the right side of `==`/`!=` against a record's name-typed field (`job.user`, `*.partition`,
  `*.tags` membership via `has_tag`). They may not be stored in lists/tuples, used in arithmetic,
  compared to a non-name field, or printed — a `type` error otherwise. Example: `job.partition ==
  "gpu"`. This keeps a competitive kata compact (comparing a partition/user) without a string machine.
- **Records** — opaque, read-only, with dotted fields:
  - `job`: `id`, `user`, `submit_time`, `nodes_req`, `walltime_req`, `priority`, `state`,
    `partition`, `tags`, `sla`, plus sensor fields gated by unlocks: `actual_runtime`, `est_runtime`.
  - `node`: `id`, `name`, `cpus`, `mem`, `gpus`, `partition`, `tags`, `free` (bool at `now`).
  - `user`: `name`, plus via builtins only (`user_usage`, `user_share`).
  - `site`: `id`, `name`.
  Accessing a hidden field raises `sensor_locked`. Accessing an unknown field raises `no_such_field`.

## 5. Safety (static + runtime)

- No IO, no imports, no `eval`, no wall clock, no randomness.
- No attribute **assignment** (`obj.field = x`) — static `field_write`.
- No global mutation across decisions except `remember`/`recall` (bounded, per-run).
- Per-decision **step budget** (default 20,000 interpreter steps). Exhausting it raises
  `StepBudgetError` naming the line; the engine falls back to the level default for that decision.
- Recursion (`def` calling itself) is allowed but bounded by the same budget and a fixed depth cap
  (default 200 frames).

## 6. Builtins (by tier; the level file lists enabled names)

- **core** (always): `queue()`, `running()`, `now()`, `nodes()`, `free_nodes()`,
  `fits_now(job)`, `fits_later(job)`, `place(job)`, `place(job, nodes)`, `end_if_started_now(job)`,
  `first(xs)`, `rest(xs)`, `len(xs)`, `min(xs|…)`, `max(xs|…)`, `sum(xs)`, `sorted(xs, key=…)`,
  `any(xs)`, `all(xs)`, `abs(x)`, `if(cond, a, b)`.
- **reserve** (levels 3+): `earliest_fit(job)`, `reserve(job, t)`, `reservation_start(job)`.
- **fairness** (levels 5+): `user_usage(user)`, `user_share(user)`.
- **sensor** (level 4+): `est_runtime(job)`.
- **preempt** (level 7+): `preempt(job)`.
- **route** (level 8+): `route(job, site)`, `transfer_cost(job, site)`, `sites()`, `current_site()`.

A builtin not in the level's `unlocks` raises `slot_locked` when called (the level file, not the
katas, is the authority on availability).

## 7. Determinism

- Iteration order over `queue()`, `running()`, `nodes()`, `free_nodes()`, `sorted(...)` output is
  defined: records are ordered by the documented key with a stable tie → `id`. Sets are not exposed.
- `sorted` is a stable merge into a total order; the comparator falls back to `id`.
- Floats are IEEE doubles; `sorted`/`sum` iterate in the defined list order (never a set/dict).
- `now()` and all timings are integer seconds; no wall clock.

## 8. Slots and the driver

At a decision the engine calls, in order: `order` module (produce the sort key applied to `queue()`),
then `place` module (may call `place`/`reserve`), then `preempt` (optional), then `route` (multi-site).
An absent module uses the default. If any module raises `StepBudgetError`, the engine logs a fallback
and applies the default for that decision (shown in the UI as "fell back"). A `PolicyError` (e.g.
`place` of an unplaceable job) aborts the *kata* for that decision and uses the default; the UI shows
the offending line.

## 9. Error catalogue (each has a code, a one-line explanation, and a concept pointer)

| code | meaning | line shown |
|---|---|---|
| `syntax` | token/grammar violation | yes (+caret) |
| `bad_indent` | inconsistent block indentation | yes |
| `tab` | tab in indentation | yes |
| `unterminated_block` | block never closed / unexpected dedent | yes |
| `field_write` | assigning to a record field | yes |
| `shadow_builtin` | rebinding a builtin/slot name | yes |
| `undefined_name` | name not bound | yes |
| `no_such_field` | unknown field on a record | yes |
| `sensor_locked` | field gated off by the level | yes |
| `slot_locked` | builtin/slot not unlocked | yes |
| `type` | wrong type for an operator/arg | yes |
| `arity` | wrong number of args to a call | yes |
| `no_such_builtin` | call to an unknown builtin | yes |
| `step_budget` | ran out of breath | yes |
| `max_depth` | recursion too deep | yes |
| runtime `place`/`preempt`/`route` failures map to `sim.errors` codes |

Errors are **teaching moments**: every message is one line, points at the concept note, and never a
stack trace.
