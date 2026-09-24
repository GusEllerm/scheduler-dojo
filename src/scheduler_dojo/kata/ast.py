"""Kata AST — the shared data model produced by the parser and consumed by the interpreter and
formatter. Keep this the single source of node shapes; the spec (`spec.md`) is the surface syntax.

Design: expression-oriented, indentation-blocked. Statements are a small set; expressions share one
tree. All nodes are frozen dataclasses so a `Program` can be compared/printed deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass, field

def _line():
    """Parse-line for error carets; excluded from equality so AST round-trips compare."""
    return field(default=0, compare=False, repr=False)
from typing import Union

# --- expressions -------------------------------------------------------------


@dataclass(frozen=True)
class Int:
    value: int


@dataclass(frozen=True)
class Float:
    value: float


@dataclass(frozen=True)
class Bool:
    value: bool


@dataclass(frozen=True)
class Nil:
    pass


@dataclass(frozen=True)
class Str:
    """A name literal; only legal on the RHS of == / != against a name-typed field (spec §4)."""
    value: str


@dataclass(frozen=True)
class Name:
    id: str


@dataclass(frozen=True)
class Attribute:
    value: "Expr"
    attr: str


@dataclass(frozen=True)
class Tuple:
    elts: tuple  # tuple[Expr, ...]


@dataclass(frozen=True)
class ListLit:
    elts: tuple  # tuple[Expr, ...]


@dataclass(frozen=True)
class Call:
    func: str                    # builtin or user-def name (no first-class functions in v1)
    args: tuple                  # tuple[Expr, ...]
    kwargs: tuple                # tuple[tuple[str, Expr], ...]


@dataclass(frozen=True)
class BinOp:
    op: str                      # + - * / // % | or a comparison: < <= > >= == !=
    left: "Expr"
    right: "Expr"


@dataclass(frozen=True)
class UnaryOp:
    op: str                      # - not
    operand: "Expr"


@dataclass(frozen=True)
class BoolOp:
    op: str                      # and or
    values: tuple                # tuple[Expr, ...] (>=2)


@dataclass(frozen=True)
class Ternary:
    """if(cond, a, b) is a builtin, so no dedicated node; kept for potential future sugar."""
    cond: "Expr"
    then: "Expr"
    otherwise: "Expr"


Expr = Union[Int, Float, Bool, Nil, Str, Name, Attribute, Tuple, ListLit, Call,
             BinOp, UnaryOp, BoolOp, Ternary]


# --- statements --------------------------------------------------------------


@dataclass(frozen=True)
class Assign:
    target: str                  # local name only (field writes are rejected at parse time)
    value: Expr
    line: int = _line()


@dataclass(frozen=True)
class Remember:
    target: str
    value: Expr
    line: int = _line()


@dataclass(frozen=True)
class If:
    test: Expr
    body: tuple                  # tuple[Stmt, ...]
    elifs: tuple                 # tuple[tuple[Expr, tuple[Stmt, ...]], ...]
    els: tuple                   # tuple[Stmt, ...] or ()
    line: int = _line()


@dataclass(frozen=True)
class For:
    target: str
    iter: Expr
    body: tuple
    line: int = _line()


@dataclass(frozen=True)
class While:
    test: Expr
    body: tuple
    line: int = _line()


@dataclass(frozen=True)
class Return:
    value: Expr | None
    line: int = _line()


@dataclass(frozen=True)
class Pass:
    pass


@dataclass(frozen=True)
class ExprStmt:
    """A bare expression statement (allowed only for calls with side effects, e.g. place(j))."""
    value: Expr
    line: int = _line()


Stmt = Union[Assign, Remember, If, For, While, Return, Pass, ExprStmt]


# --- top level ---------------------------------------------------------------


@dataclass(frozen=True)
class Def:
    name: str
    params: tuple                # tuple[str, ...]
    body: tuple                  # tuple[Stmt, ...]


@dataclass(frozen=True)
class Module:
    slot: str                    # order | place | preempt | route
    name: str                    # label (shown on the share card)
    body: tuple                  # tuple[Stmt, ...]


SLOTS = ("order", "place", "preempt", "route")


@dataclass(frozen=True)
class Program:
    modules: tuple               # tuple[Module, ...]
    defs: tuple                  # tuple[Def, ...]

    def slots(self) -> dict[str, Module]:
        return {m.slot: m for m in self.modules}


@dataclass
class SourcePos:
    """Optional position attached during parse for error reporting; not part of equality."""
    line: int = 0
    col: int = 0
