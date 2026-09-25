"""Canonical Kata printer: AST -> deterministic text (spec.md §1/§2 surface syntax).

Two katas that mean the same thing print byte-identically: this is what makes share-payload
equality (`canonical_equal`) work. Pure string/AST transforms — no IO, no time, no randomness.

Canonicalization rules (`format_program`):
  * ``def`` blocks first, sorted by name (alphabetical);
  * then modules in fixed slot order ``order, place, preempt, route`` (spec §2 `SLOTS`);
  * one blank line between top-level sections; every section ends with a newline;
  * 4-space indent per nesting level; no trailing whitespace on any line.

Parenthesization rule (`format_expr`) — minimal parens from spec §2 precedence, loosest first:
``or`` (1) < ``and`` (2) < ``not`` (3) < comparison (4) < ``+ - |`` (5) < ``* / // %`` (6) <
unary ``-`` (7) < atoms / attribute access / calls (9). A child is parenthesized iff its
precedence is *below* the minimum its position demands:
  * binary/boolop children: left position needs ``prec(op)``, right position needs
    ``prec(op) + 1`` (all binary operators are left-associative, so a right child with equal
    precedence is parenthesized: ``a - (b - c)``, ``a * (b / c)``);
  * ``not`` operand minimum is 3 (so ``not not x`` and ``not a == b`` stay bare — the grammar
    binds ``not`` looser than comparison);
  * unary ``-`` operand minimum is 8: the grammar allows ``-`` only directly before an atom,
    so ``-(-a)`` and ``-(a * b)`` keep their parens;
  * an ``Attribute`` base must be an atom (minimum 9).
"""

from __future__ import annotations

from scheduler_dojo.kata import ast

__all__ = ["format_program", "format_expr", "format"]

INDENT = "    "

# expression node -> precedence (higher binds tighter); see docstring
_BIN_PREC = {
    "+": 5, "-": 5, "|": 5,
    "*": 6, "/": 6, "//": 6, "%": 6,
    "<": 4, "<=": 4, ">": 4, ">=": 4, "==": 4, "!=": 4,
}
_BOOL_PREC = {"or": 1, "and": 2}
_CMP_OPS = ("<", "<=", ">", ">=", "==", "!=")


# --- expressions -------------------------------------------------------------


def _prec(e: ast.Expr) -> int:
    if isinstance(e, (ast.BinOp,)):
        return _BIN_PREC[e.op]
    if isinstance(e, ast.BoolOp):
        return _BOOL_PREC[e.op]
    if isinstance(e, ast.UnaryOp):
        return 3 if e.op == "not" else 7
    return 9  # Int/Float/Bool/Nil/Str/Name/Attribute/Tuple/ListLit/Call/Ternary are atoms


def _p(e: ast.Expr, minimum: int) -> str:
    """Print ``e``, parenthesized iff it binds looser than ``minimum``."""
    text = format_expr(e)
    return text if _prec(e) >= minimum else f"({text})"


def format_expr(e: ast.Expr) -> str:
    if isinstance(e, ast.Int):
        return str(e.value)
    if isinstance(e, ast.Float):
        # repr switches to exponent form (1e-05 / 1e+18) which the lexer (no exponent
        # token) cannot re-read; fall back to a fixed-point form that round-trips.
        r = repr(e.value)
        return r if not any(c in r for c in 'eE') else '{:.17f}'.format(e.value)
    if isinstance(e, ast.Bool):
        return "true" if e.value else "false"
    if isinstance(e, ast.Nil):
        return "nil"
    if isinstance(e, ast.Str):
        # Re-escape backslash and quote so the literal re-parses (lexer: \X -> X).
        esc = str(e.value).replace(chr(92), chr(92)*2).replace('"', chr(92) + '"')
        return '"' + esc + '"'
    if isinstance(e, ast.Name):
        return e.id
    if isinstance(e, ast.Attribute):
        return f"{_p(e.value, 9)}.{e.attr}"
    if isinstance(e, ast.Tuple):
        elts = [_p(x, 0) for x in e.elts]
        if len(elts) == 1:
            return f"({elts[0]},)"
        return "(" + ", ".join(elts) + ")"
    if isinstance(e, ast.ListLit):
        return "[" + ", ".join(_p(x, 0) for x in e.elts) + "]"
    if isinstance(e, ast.Call):
        parts = [_p(a, 0) for a in e.args]
        parts += [f"{k}={_p(v, 0)}" for k, v in e.kwargs]
        return f"{e.func}(" + ", ".join(parts) + ")"
    if isinstance(e, ast.BinOp):
        if e.op in _CMP_OPS:  # non-associative: single comparison, both sides at adder level
            return f"{_p(e.left, 5)} {e.op} {_p(e.right, 5)}"
        p = _BIN_PREC[e.op]
        return f"{_p(e.left, p)} {e.op} {_p(e.right, p + 1)}"
    if isinstance(e, ast.UnaryOp):
        if e.op == "not":
            return f"not {_p(e.operand, 3)}"
        return f"-{_p(e.operand, 8)}"
    if isinstance(e, ast.BoolOp):
        p = _BOOL_PREC[e.op]
        return f" {e.op} ".join(_p(v, p) for v in e.values)
    if isinstance(e, ast.Ternary):  # printed via the core if(cond, a, b) builtin (spec §6)
        return f"if({_p(e.cond, 0)}, {_p(e.then, 0)}, {_p(e.otherwise, 0)})"
    raise TypeError(f"cannot format expression node: {e!r}")


# --- statements --------------------------------------------------------------


def _stmt_lines(s: ast.Stmt, level: int) -> list[str]:
    pad = INDENT * level
    if isinstance(s, ast.Pass):
        return [pad + "pass"]
    if isinstance(s, ast.Assign):
        return [f"{pad}{s.target} = {format_expr(s.value)}"]
    if isinstance(s, ast.Remember):
        return [f"{pad}remember {s.target} = {format_expr(s.value)}"]
    if isinstance(s, ast.Return):
        if s.value is None:
            return [pad + "return"]
        return [f"{pad}return {format_expr(s.value)}"]
    if isinstance(s, ast.ExprStmt):
        return [pad + format_expr(s.value)]
    if isinstance(s, ast.For):
        return [f"{pad}for {s.target} in {format_expr(s.iter)}:"] + _body_lines(s.body, level + 1)
    if isinstance(s, ast.While):
        return [f"{pad}while {format_expr(s.test)}:"] + _body_lines(s.body, level + 1)
    if isinstance(s, ast.If):
        lines = [f"{pad}if {format_expr(s.test)}:"] + _body_lines(s.body, level + 1)
        for test, body in s.elifs:
            lines += [f"{pad}elif {format_expr(test)}:"] + _body_lines(body, level + 1)
        if s.els:
            lines += [pad + "else:"] + _body_lines(s.els, level + 1)
        return lines
    raise TypeError(f"cannot format statement node: {s!r}")


def _body_lines(body, level: int) -> list[str]:
    if not body:  # grammar forbids empty blocks; keep output re-parsable
        return [INDENT * level + "pass"]
    return [line for s in body for line in _stmt_lines(s, level)]


# --- top level ---------------------------------------------------------------


def format_program(program: ast.Program) -> str:
    """Canonical Kata text for ``program`` (see module docstring for the ordering rules)."""
    sections: list[str] = []
    for d in sorted(program.defs, key=lambda d: d.name):
        header = f"def {d.name}(" + ", ".join(d.params) + "):"
        sections.append("\n".join([header] + _body_lines(d.body, 1)))
    chosen: dict[str, ast.Module] = {}
    for m in program.modules:
        chosen[m.slot] = m  # LAST module per slot wins, matching ast.slots() (what executes)
    by_slot = [m for slot in ast.SLOTS for m in ([chosen[slot]] if slot in chosen else [])]
    for m in by_slot:
        sections.append("\n".join([f"{m.slot} by {m.name}:"] + _body_lines(m.body, 1)))
    if not sections:
        return ""
    return "\n\n".join(sections) + "\n"


def format(src: str) -> str:
    """Parse Kata source and return its canonical text. Raises the parser's KataSyntaxError."""
    try:
        from scheduler_dojo.kata.parser import parse
    except ImportError as exc:  # parser under construction; the AST path still works
        raise RuntimeError("kata parser unavailable: scheduler_dojo.kata.parser is missing") from exc
    return format_program(parse(src))
