"""Static Kata checking: parse + a few cheap AST scans, never raising for a bad program.

What `check` does:
  * full parse via `scheduler_dojo.kata.parser.parse` — every lexical/grammar/indent code of
    spec §9 (`syntax`, `bad_indent`, `tab`, `unterminated_block`, plus the parse-time static
    codes the parser already enforces: `field_write`, `shadow_builtin`) arrives as a
    `KataSyntaxError` and is converted to a `Report`, never raised;
  * after a clean parse, two cheap defensive scans over the AST (in case an AST reached `check`
    from another route): an `Assign`/`Remember` target containing `.` -> `field_write`; a target
    that rebinds a builtin or slot name -> `shadow_builtin`.

What `check` does NOT do (the interpreter's job, spec §5/§6): `undefined_name` (needs scopes:
def params, for targets, block order — deliberately not duplicated here), `sensor_locked`,
`slot_locked`, `type`, `arity`, `no_such_builtin`, `step_budget`, `max_depth`.

`canonical_equal(a, b)` is share-card kata equality: canonical text equality via the formatter.
Pure transforms; no IO, no randomness, no time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.errors import KataSyntaxError

__all__ = ["Report", "check", "format_report", "canonical_equal"]


@dataclass
class Report:
    ok: bool
    errors: list[dict] = field(default_factory=list)


def _parse(src: str):
    try:
        from scheduler_dojo.kata.parser import parse
    except ImportError as exc:  # parser under construction
        raise RuntimeError("kata parser unavailable: scheduler_dojo.kata.parser is missing") from exc
    return parse(src)


def _builtin_names() -> frozenset[str]:
    """Names an assignment target may not rebind (spec §3 shadow_builtin)."""
    try:
        from scheduler_dojo.kata.builtins import TIERS
        return frozenset(TIERS) | frozenset(ast.SLOTS)
    except Exception:  # pragma: no cover - builtins module heavy/absent
        return frozenset(ast.SLOTS)


def _stmts(body):
    for s in body or ():
        yield s
        if isinstance(s, ast.If):
            yield from _stmts(s.body)
            for _test, b in s.elifs:
                yield from _stmts(b)
            yield from _stmts(s.els)
        elif isinstance(s, (ast.For, ast.While)):
            yield from _stmts(s.body)


def _static_errors(program: ast.Program) -> list[dict]:
    """Cheap, scope-free static checks over a parsed program (see module docstring)."""
    builtins_ = _builtin_names()
    errors: list[dict] = []
    bodies = [d.body for d in program.defs] + [m.body for m in program.modules]
    for body in bodies:
        for s in _stmts(body):
            if isinstance(s, (ast.Assign, ast.Remember)):
                line = getattr(s, "line", 0)
                if "." in s.target:
                    errors.append({"code": "field_write", "line": line, "col": 0,
                                   "message": f"cannot assign to field {s.target}"})
                elif s.target in builtins_:
                    errors.append({"code": "shadow_builtin", "line": line, "col": 0,
                                   "message": f"cannot rebind builtin {s.target}"})
    return errors


def check(src: str) -> Report:
    """Parse `src` and run cheap static checks; always returns a Report, never raises a KataError."""
    try:
        program = _parse(src)
    except KataSyntaxError as exc:
        return Report(ok=False, errors=[{"code": exc.code, "message": str(exc),
                                         "line": exc.line, "col": exc.col}])
    errors = _static_errors(program)
    return Report(ok=not errors, errors=errors)


def _caret(err: dict, lines: list[str]) -> str:
    """Render 'line N: code: msg' plus the source line and a '^' caret.

    Mirrors KataSyntaxError.caret (that helper reads `self.message`, which the frozen
    EngineError base does not store, so we reimplement the identical rendering here).
    """
    line = int(err.get("line", 0))
    col = int(err.get("col", 0))
    text = lines[line - 1] if 1 <= line <= len(lines) else ""
    pointer = " " * col + "^"
    return f"line {line}: {err.get('code', 'syntax')}: {err.get('message', '')}\n  {text}\n  {pointer}"


def format_report(report: Report, source: str) -> str:
    """Render each error with a source caret; 'ok' when clean."""
    if report.ok and not report.errors:
        return "ok"
    lines = source.splitlines()
    return "\n\n".join(_caret(err, lines) for err in report.errors)


def canonical_equal(a: str, b: str) -> bool:
    """Share-card equality: both katas canonicalize to the same text (bad syntax != anything)."""
    from scheduler_dojo.kata.formatter import format as _format
    try:
        return _format(a) == _format(b)
    except KataSyntaxError:
        return False
