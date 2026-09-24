"""Tests for the canonical Kata formatter and static checker (formatter.py / check.py)."""

from __future__ import annotations

import pytest

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.check import Report, canonical_equal, check, format_report
from scheduler_dojo.kata.formatter import format, format_expr, format_program

try:  # the parser is built concurrently; round-trip tests skip if it is absent
    from scheduler_dojo.kata.parser import parse

    HAVE_PARSER = True
except ImportError:  # pragma: no cover
    HAVE_PARSER = None

needs_parse = pytest.mark.skipif(not HAVE_PARSER, reason="kata parser not available yet")


# --- hand-built ASTs ---------------------------------------------------------


def _sample_program() -> ast.Program:
    # modules listed in canonical slot order so the parse(round-trip) equals this AST
    # (Program equality compares the modules tuple positionally; only *text* is canonicalized)
    return ast.Program(
        modules=(
            ast.Module(
                "order",
                "shortest_first",
                (
                    ast.Assign(
                        "key",
                        ast.Tuple(
                            (
                                ast.Attribute(ast.Name("job"), "walltime_req"),
                                ast.Attribute(ast.Name("job"), "submit_time"),
                            )
                        ),
                        1,
                    ),
                ),
            ),
            ast.Module(
                "place",
                "backfill",
                (
                    ast.Assign(
                        "head",
                        ast.Call("first", (ast.Call("queue", (), ()),), ()),
                        2,
                    ),
                    ast.If(
                        ast.BinOp("!=", ast.Name("head"), ast.Nil()),
                        (
                            ast.ExprStmt(
                                ast.Call(
                                    "reserve",
                                    (
                                        ast.Name("head"),
                                        ast.Call("earliest_fit", (ast.Name("head"),), ()),
                                    ),
                                    (),
                                ),
                                4,
                            ),
                        ),
                        (),
                        (),
                        3,
                    ),
                ),
            ),
        ),
        defs=(
            ast.Def(
                "rest2",
                ("xs",),
                (ast.Return(ast.Call("rest", (ast.Name("xs"),), ()), 1),),
            ),
        ),
    )


SAMPLE_SRC = """\
def bonus(j):
    return j.priority * 2

place by backfill:
    head = first(queue())
    if head != nil and fits_now(head):
        reserve(head, earliest_fit(head))
    for j in rest(queue()):
        if fits_now(j) and end_if_started_now(j) <= reservation_start(head):
            place(j)

order by shortest_first:
    key = (job.walltime_req, job.submit_time)

preempt by never:
    pass
"""


# --- format_program: exact canonical output ----------------------------------


def test_format_program_exact():
    expected = (
        "def rest2(xs):\n"
        "    return rest(xs)\n"
        "\n"
        "order by shortest_first:\n"
        "    key = (job.walltime_req, job.submit_time)\n"
        "\n"
        "place by backfill:\n"
        "    head = first(queue())\n"
        "    if head != nil:\n"
        "        reserve(head, earliest_fit(head))\n"
    )
    assert format_program(_sample_program()) == expected


def test_canonical_ordering_defs_then_slot_order():
    prog = ast.Program(
        modules=(
            ast.Module("place", "p", (ast.Pass(),)),
            ast.Module("order", "o", (ast.Pass(),)),
        ),
        defs=(
            ast.Def("zed", (), (ast.Pass(),)),
            ast.Def("abe", (), (ast.Pass(),)),
        ),
    )
    expected = (
        "def abe():\n"
        "    pass\n"
        "\n"
        "def zed():\n"
        "    pass\n"
        "\n"
        "order by o:\n"
        "    pass\n"
        "\n"
        "place by p:\n"
        "    pass\n"
    )
    assert format_program(prog) == expected


def test_trailing_newline_and_no_trailing_whitespace():
    text = format_program(_sample_program())
    assert text.endswith("\n")
    assert all(line == line.rstrip() for line in text.splitlines())


# --- expression printing / precedence ----------------------------------------


def _n(s: str) -> ast.Name:
    return ast.Name(s)


def test_precedence_minimal_parens():
    assert format_expr(ast.BinOp("+", _n("a"), ast.BinOp("*", _n("b"), _n("c")))) == "a + b * c"
    assert format_expr(ast.BinOp("*", ast.BinOp("+", _n("a"), _n("b")), _n("c"))) == "(a + b) * c"


def test_precedence_more_cases():
    E = ast
    assert format_expr(E.BinOp("-", _n("a"), E.BinOp("-", _n("b"), _n("c")))) == "a - (b - c)"
    assert format_expr(E.BinOp("-", E.BinOp("-", _n("a"), _n("b")), _n("c"))) == "a - b - c"
    assert format_expr(E.BinOp("*", _n("a"), E.BinOp("/", _n("b"), _n("c")))) == "a * (b / c)"
    assert format_expr(E.UnaryOp("-", E.UnaryOp("-", _n("a")))) == "-(-a)"
    assert format_expr(E.UnaryOp("not", E.BinOp("==", _n("a"), _n("b")))) == "not a == b"
    assert format_expr(E.BoolOp("or", (_n("a"), E.BoolOp("and", (_n("b"), _n("c")))))) == (
        "a or b and c"
    )
    assert format_expr(E.BoolOp("and", (_n("a"), E.BoolOp("or", (_n("b"), _n("c")))))) == (
        "a and (b or c)"
    )


def test_atoms_and_containers():
    E = ast
    assert format_expr(E.Tuple((_n("a"),))) == "(a,)"
    assert format_expr(E.Tuple((_n("a"), _n("b")))) == "(a, b)"
    assert format_expr(E.ListLit(())) == "[]"
    assert format_expr(E.ListLit((_n("a"), E.Int(2)))) == "[a, 2]"
    assert format_expr(E.Call("sorted", (_n("xs"),), (("key", _n("f")),))) == "sorted(xs, key=f)"
    assert format_expr(E.Attribute(_n("job"), "id")) == "job.id"
    assert format_expr(E.Bool(True)) == "true"
    assert format_expr(E.Nil()) == "nil"
    assert format_expr(E.Str("gpu")) == '"gpu"'
    assert format_expr(E.UnaryOp("-", E.Attribute(_n("a"), "b"))) == "-a.b"


# --- statement shapes ---------------------------------------------------------


def test_statement_shapes():
    prog = ast.Program(
        modules=(
            ast.Module(
                "route",
                "everywhere",
                (
                    ast.Remember("seen", ast.Int(0)),
                    ast.For("j", ast.Call("queue", (), ()), (ast.Pass(),)),
                    ast.While(ast.Bool(False), (ast.Pass(),)),
                    ast.ExprStmt(ast.Call("place", (ast.Name("j"),), ())),
                    ast.If(
                        _n("c"),
                        (ast.Return(None),),
                        ((ast.Bool(True), (ast.Pass(),)),),
                        (ast.Pass(),),
                    ),
                ),
            ),
        ),
        defs=(),
    )
    expected = (
        "route by everywhere:\n"
        "    remember seen = 0\n"
        "    for j in queue():\n"
        "        pass\n"
        "    while false:\n"
        "        pass\n"
        "    place(j)\n"
        "    if c:\n"
        "        return\n"
        "    elif true:\n"
        "        pass\n"
        "    else:\n"
        "        pass\n"
    )
    assert format_program(prog) == expected


# --- round-trip (needs parser) ------------------------------------------------


@needs_parse
def test_format_program_roundtrip_idempotent():
    prog = _sample_program()
    assert parse(format_program(prog)) == prog


@needs_parse
def test_format_idempotent_on_source():
    assert format(format(SAMPLE_SRC)) == format(SAMPLE_SRC)


@needs_parse
def test_canonical_equal_ignores_ordering():
    a = "order by f:\n    key = job.priority\n\ndef z(x):\n    return x\n"
    b = "def z(x):\n    return x\n\norder by f:\n    key = job.priority\n"
    assert canonical_equal(a, b)
    assert not canonical_equal(a, "order by f:\n    key = ((")


# --- check --------------------------------------------------------------------


@needs_parse
def test_check_good_source():
    report = check("order by fifo:\n    key = job.priority\n")
    assert isinstance(report, Report)
    assert report.ok and report.errors == []
    assert format_report(report, "order by fifo:\n    key = job.priority\n") == "ok"


@needs_parse
def test_check_bad_source_has_code_and_caret():
    src = "order by fifo:\n    key = (job.priority\n"
    report = check(src)
    assert not report.ok
    err = report.errors[0]
    assert set(err) == {"code", "message", "line", "col"}
    assert err["code"]
    rendered = format_report(report, src)
    assert "^" in rendered
    assert err["code"] in rendered


@needs_parse
def test_check_shadow_builtin():
    src = "order by fifo:\n    queue = 1\n"
    report = check(src)
    assert not report.ok
    assert report.errors[0]["code"] == "shadow_builtin"
