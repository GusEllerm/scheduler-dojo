"""Tests for the Kata lexer/parser: assert the produced AST shape, not just 'no raise'."""

from __future__ import annotations

import pathlib
import sys
import types

import pytest

import scheduler_dojo  # parent package is trivial; safe with or without siblings

try:  # normal path: works once the whole kata package (check/formatter/policy) exists
    import scheduler_dojo.kata
except ModuleNotFoundError:
    # Concurrent builders own check.py/formatter.py/policy.py; register the package
    # path without executing its eager-importing __init__ so my modules import.
    _m = types.ModuleType("scheduler_dojo.kata")
    _m.__path__ = [str(pathlib.Path(scheduler_dojo.__file__).parent / "kata")]
    sys.modules["scheduler_dojo.kata"] = _m

from scheduler_dojo.kata import ast  # noqa: E402
from scheduler_dojo.kata.errors import KataSyntaxError  # noqa: E402
from scheduler_dojo.kata.lexer import KEYWORDS, TOKEN_TYPES, Token, tokenize  # noqa: E402
from scheduler_dojo.kata.parser import parse  # noqa: E402


def src_of(body: str) -> str:
    """Wrap an expression/assignment in a minimal module so we can parse a fragment."""
    return "place by t:\n    " + body + "\n"


def expr_of(source: str) -> ast.Expr:
    prog = parse(src_of(source))
    stmt = prog.modules[0].body[0]
    assert isinstance(stmt, ast.Assign)
    return stmt.value


def top_expr(source: str) -> ast.Expr:
    prog = parse(src_of("x = " + source))
    stmt = prog.modules[0].body[0]
    assert isinstance(stmt, ast.Assign)
    return stmt.value


# -- spec example --------------------------------------------------------------

SPEC_EXAMPLE = '''order by shortest_first:
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
'''


def test_spec_three_module_example():
    prog = parse(SPEC_EXAMPLE)
    assert isinstance(prog, ast.Program)
    assert len(prog.modules) == 3 and prog.defs == ()
    by_slot = prog.slots()
    assert set(by_slot) == {"order", "place", "preempt"}

    order = by_slot["order"]
    assert (order.slot, order.name) == ("order", "shortest_first")
    assert isinstance(order.body[0], ast.Assign) and len(order.body) == 1
    assert order.body[0].target == "key"
    assert order.body[0].value == ast.Tuple(
        (ast.Attribute(ast.Name("job"), "walltime_req"),
         ast.Attribute(ast.Name("job"), "submit_time"))
    )

    place = by_slot["place"]
    assert (place.slot, place.name) == ("place", "backfill")
    assert len(place.body) == 3
    head = place.body[0]
    assert isinstance(head, ast.Assign) and head.target == "head"
    assert head.value == ast.Call("first", (ast.Call("queue", (), ()),), ())
    guard = place.body[1]
    assert isinstance(guard, ast.If)
    assert guard.test == ast.BoolOp(
        "and",
        (ast.BinOp("!=", ast.Name("head"), ast.Nil()),
         ast.Call("fits_now", (ast.Name("head"),), ())),
    )
    assert guard.body == (
        ast.ExprStmt(
            ast.Call(
                "reserve",
                (ast.Name("head"), ast.Call("earliest_fit", (ast.Name("head"),), ())),
                (),
            ),
            guard.body[0].line,
        ),
    )
    loop = place.body[2]
    assert isinstance(loop, ast.For) and loop.target == "j"
    assert loop.iter == ast.Call("rest", (ast.Call("queue", (), ()),), ())
    (inner_if,) = loop.body
    assert isinstance(inner_if, ast.If)
    assert inner_if.test == ast.BoolOp(
        "and",
        (ast.Call("fits_now", (ast.Name("j"),), ()),
         ast.BinOp(
             "<=",
             ast.Call("end_if_started_now", (ast.Name("j"),), ()),
             ast.Call("reservation_start", (ast.Name("head"),), ()),
         )),
    )
    (place_call,) = inner_if.body
    assert isinstance(place_call, ast.ExprStmt)
    assert place_call.value == ast.Call("place", (ast.Name("j"),), ())

    preempt = by_slot["preempt"]
    assert (preempt.slot, preempt.name) == ("preempt", "never")
    assert preempt.body == (ast.Pass(),)


# -- targeted spec §top snippet ------------------------------------------------

def test_order_module_key_tuple_and_line():
    prog = parse("order by shortest_first:\n    key = (job.walltime_req, job.submit_time)")
    assert len(prog.modules) == 1 and prog.defs == ()
    mod = prog.modules[0]
    assert mod.slot == "order" and mod.name == "shortest_first"
    (stmt,) = mod.body
    assert isinstance(stmt, ast.Assign)
    assert stmt.target == "key"
    assert stmt.value == ast.Tuple(
        (ast.Attribute(ast.Name("job"), "walltime_req"),
         ast.Attribute(ast.Name("job"), "submit_time"))
    )
    assert stmt.line == 2


# -- operator precedence ---------------------------------------------------------

def test_precedence_add_mul():
    assert top_expr("a + b * c") == ast.BinOp(
        "+", ast.Name("a"), ast.BinOp("*", ast.Name("b"), ast.Name("c"))
    )


def test_precedence_bool():
    assert top_expr("x or y and z") == ast.BoolOp(
        "or", (ast.Name("x"), ast.BoolOp("and", (ast.Name("y"), ast.Name("z"))))
    )


def test_precedence_not_binds_looser_than_comparison():
    # `not` applies to the whole comparison, not just `a`.
    assert top_expr("not a == b") == ast.UnaryOp(
        "not", ast.BinOp("==", ast.Name("a"), ast.Name("b"))
    )


def test_pipe_is_list_concat_at_additive_level():
    assert top_expr("xs | ys") == ast.BinOp("|", ast.Name("xs"), ast.Name("ys"))
    assert top_expr("a | b + c") == ast.BinOp(
        "+", ast.BinOp("|", ast.Name("a"), ast.Name("b")), ast.Name("c")
    )


def test_precedence_floor_and_mod():
    assert top_expr("a // b % c") == ast.BinOp(
        "%", ast.BinOp("//", ast.Name("a"), ast.Name("b")), ast.Name("c")
    )
    assert top_expr("a * b / c") == ast.BinOp(
        "/", ast.BinOp("*", ast.Name("a"), ast.Name("b")), ast.Name("c")
    )


def test_unary_minus_and_literals():
    assert top_expr("-1") == ast.Int(-1)
    assert top_expr("- x") == ast.UnaryOp("-", ast.Name("x"))
    assert top_expr("1_000") == ast.Int(1000)
    assert top_expr("2.5") == ast.Float(2.5)
    assert top_expr("true") == ast.Bool(True)
    assert top_expr("nil") == ast.Nil()


# -- atoms, tuples, lists, calls ---------------------------------------------------

def test_grouping_vs_tuple_vs_one_element_tuple():
    assert top_expr("(a)") == ast.Name("a")
    assert top_expr("(a, b)") == ast.Tuple((ast.Name("a"), ast.Name("b")))
    assert top_expr("(a,)") == ast.Tuple((ast.Name("a"),))
    assert top_expr("(a, b,)") == ast.Tuple((ast.Name("a"), ast.Name("b")))
    assert top_expr("((a, b), c)") == ast.Tuple(
        (ast.Tuple((ast.Name("a"), ast.Name("b"))), ast.Name("c"))
    )


def test_list_literal():
    assert top_expr("[]") == ast.ListLit(())
    assert top_expr("[a, b, c]") == ast.ListLit(
        (ast.Name("a"), ast.Name("b"), ast.Name("c"))
    )


def test_attribute_access():
    assert top_expr("job.tags") == ast.Attribute(ast.Name("job"), "tags")
    assert top_expr("a.b.c") == ast.Attribute(ast.Attribute(ast.Name("a"), "b"), "c")


def test_call_with_kwargs():
    assert top_expr("sorted(xs, key=f)") == ast.Call(
        "sorted", (ast.Name("xs"),), (("key", ast.Name("f")),)
    )


def test_call_with_list_of_names():
    assert top_expr("place(job, [n0, n1])") == ast.Call(
        "place", (ast.Name("job"), ast.ListLit((ast.Name("n0"), ast.Name("n1")))), ()
    )


def test_string_atom_and_comparison():
    # Strings parse fine here; semantic rejection is the interpreter's job (spec §4).
    e = top_expr('job.partition == "gpu"')
    assert e == ast.BinOp(
        "==", ast.Attribute(ast.Name("job"), "partition"), ast.Str("gpu")
    )


# -- statements / blocks -----------------------------------------------------------

def test_nested_if_for_blocks():
    prog = parse(
        "place by b:\n"
        "    for j in queue():\n"
        "        if fits_now(j):\n"
        "            place(j)\n"
        "        else:\n"
        "            pass\n"
    )
    (loop,) = prog.modules[0].body
    assert isinstance(loop, ast.For) and loop.target == "j"
    assert loop.line == 2
    (branch,) = loop.body
    assert isinstance(branch, ast.If) and branch.line == 3
    (call_stmt,) = branch.body
    assert isinstance(call_stmt, ast.ExprStmt)
    assert call_stmt.value == ast.Call("place", (ast.Name("j"),), ())
    assert branch.els == (ast.Pass(),)


def test_elif_chain():
    prog = parse(
        "place by b:\n"
        "    if a:\n"
        "        pass\n"
        "    elif c:\n"
        "        pass\n"
        "    else:\n"
        "        pass\n"
    )
    (branch,) = prog.modules[0].body
    assert isinstance(branch, ast.If)
    assert len(branch.elifs) == 1
    cond, ebody = branch.elifs[0]
    assert cond == ast.Name("c") and ebody == (ast.Pass(),)
    assert branch.els == (ast.Pass(),)


def test_else_binds_to_outer_if_by_column():
    prog = parse(
        "place by b:\n"
        "    if a:\n"
        "        if z:\n"
        "            pass\n"
        "    else:\n"
        "        pass\n"
    )
    (outer,) = prog.modules[0].body
    assert isinstance(outer, ast.If) and outer.els == (ast.Pass(),)
    (inner,) = outer.body
    assert isinstance(inner, ast.If) and inner.els == () and inner.elifs == ()


def test_def_and_return_and_while_and_remember():
    prog = parse(
        "def twice(n):\n"
        "    return n * 2\n"
        "\n"
        "place by b:\n"
        "    remember seen = 0\n"
        "    while seen < 3:\n"
        "        seen = seen + 1\n"
    )
    (fn,) = prog.defs
    assert fn.name == "twice" and fn.params == ("n",)
    (ret,) = fn.body
    assert isinstance(ret, ast.Return) and ret.line == 2
    assert ret.value == ast.BinOp("*", ast.Name("n"), ast.Int(2))
    mod = prog.modules[0]
    mem, loop = mod.body
    assert isinstance(mem, ast.Remember) and mem.target == "seen" and mem.line == 5
    assert mem.value == ast.Int(0)
    assert isinstance(loop, ast.While) and loop.line == 6
    assert loop.test == ast.BinOp("<", ast.Name("seen"), ast.Int(3))
    (assign,) = loop.body
    assert isinstance(assign, ast.Assign) and assign.line == 7


def test_bare_call_is_expr_stmt():
    prog = parse("place by b:\n    queue()\n")
    (stmt,) = prog.modules[0].body
    assert isinstance(stmt, ast.ExprStmt) and stmt.line == 2
    assert stmt.value == ast.Call("queue", (), ())


# -- indentation and static errors -------------------------------------------------

def test_tab_in_indentation_raises():
    with pytest.raises(KataSyntaxError) as ei:
        parse("place by b:\n\tplace(job)\n")
    assert ei.value.code == "tab"
    assert ei.value.line == 2


def test_inconsistent_dedent_raises():
    with pytest.raises(KataSyntaxError) as ei:
        parse("place by b:\n    if a:\n            pass\n        y = 2\n")
    assert ei.value.code == "bad_indent"


def test_top_level_indentation_raises_bad_indent():
    with pytest.raises(KataSyntaxError) as ei:
        parse("    place(job)\n")
    assert ei.value.code == "bad_indent"


def test_field_write_raises():
    with pytest.raises(KataSyntaxError) as ei:
        parse("place by b:\n    job.x = 1\n")
    assert ei.value.code == "field_write"
    assert ei.value.line == 2


def test_shadow_builtin_raises():
    with pytest.raises(KataSyntaxError) as ei:
        parse("place by b:\n    place = 3\n")
    assert ei.value.code == "shadow_builtin"
    assert ei.value.line == 2


def test_if_without_body_raises_syntax_with_line():
    with pytest.raises(KataSyntaxError) as ei:
        parse("place by b:\n    if a:\n    pass\n")
    assert ei.value.code == "syntax"
    assert ei.value.line == 2


def test_trailing_over_indent_raises_bad_indent():
    with pytest.raises(KataSyntaxError) as ei:
        parse("def f(n):\n    return n\n        x = 1\n")
    assert ei.value.code == "bad_indent"


# -- degenerate inputs -------------------------------------------------------------

def test_empty_file():
    prog = parse("")
    assert prog == ast.Program((), ())


def test_comment_only_file():
    prog = parse("# nothing here\n# and more\n")
    assert prog == ast.Program((), ())


# -- lexer surface used by the UI ----------------------------------------------------

def test_tokenize_token_shape():
    toks = tokenize('x = 1 // 2.5 == "hi" | y\n')
    got = [(t.type, t.value) for t in toks]
    assert got == [
        ("NAME", "x"), ("ASSIGN", "="), ("INT", "1"),
        ("DOUBLESLASH", "//"), ("FLOAT", "2.5"), ("EQ", "=="), ("STRING", "hi"),
        ("PIPE", "|"), ("NAME", "y"), ("NEWLINE", ""), ("EOF", None),
    ]
    assert all(isinstance(t, Token) for t in toks)
    assert toks[0].line == 1 and toks[0].col == 0


def test_tokenize_indent_dedent_events():
    toks = tokenize("place by b:\n    if a:\n        pass\n")
    types = [t.type for t in toks]
    assert types[:3] == ["NAME", "NAME", "NAME"]
    assert types.count("INDENT") == 2
    assert types[-4:] == ["NEWLINE", "DEDENT", "DEDENT", "EOF"]


def test_keyword_and_token_type_exports():
    assert isinstance(KEYWORDS, frozenset)
    assert {"order", "place", "preempt", "route", "by", "def", "if", "elif", "else",
            "for", "in", "while", "return", "pass", "remember", "not", "and", "or",
            "true", "false", "nil"} == set(KEYWORDS)
    assert "never" not in KEYWORDS
    assert isinstance(TOKEN_TYPES, tuple) and len(set(TOKEN_TYPES)) == len(TOKEN_TYPES)
    for required in ("INT", "FLOAT", "STRING", "NAME", "NEWLINE", "INDENT", "DEDENT",
                     "EOF", "LPAREN", "RPAREN", "LBRACKET", "RBRACKET", "COMMA",
                     "ASSIGN", "DOT", "COLON", "PLUS", "MINUS", "STAR", "SLASH",
                     "DOUBLESLASH", "PERCENT", "PIPE", "LT", "LE", "GT", "GE", "EQ", "NEQ"):
        assert required in TOKEN_TYPES
