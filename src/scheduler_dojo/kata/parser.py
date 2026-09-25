"""Kata parser — recursive descent over the lexer's token stream, producing ``ast.Program``.

Implements spec.md §2 exactly. Deterministic and pure: reads only the passed string (or a token
list), no IO, no clock, no randomness. Every statement carries its 1-based source ``line`` so the
interpreter and UI can point at it; every failure raises ``KataSyntaxError`` with a code from §9
(`syntax`, `bad_indent`, `tab`, `unterminated_block`, `field_write`, `shadow_builtin`).

INDENT/DEDENT handling: a ``:`` line must be followed by NEWLINE* INDENT; the body runs until its
matching DEDENT (which is consumed there). ``elif``/``else`` sit at the ``if``'s own indentation,
so their DEDENT arrives *before* the keyword token — the if-chain consumes it while looking for a
continuation, always re-checking for another DEDENT before treating a consumed one as "the close".
"""

from __future__ import annotations

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.ast import Program
import sys
from scheduler_dojo.kata.errors import KataSyntaxError
from scheduler_dojo.kata.lexer import KEYWORDS, Token, tokenize

__all__ = ["parse", "parse_program", "BUILTINS", "SLOT_NAMES"]

#: The builtin names from spec.md §6 (all tiers) — static errors reference these.
BUILTINS: frozenset[str] = frozenset(
    {
        "queue", "running", "now", "nodes", "free_nodes", "fits_now", "place",
        "end_if_started_now", "first", "rest", "len", "min", "max", "sum",
        "sorted", "any", "all", "abs",
        "earliest_fit", "reserve", "reservation_start",
        "user_usage", "user_share",
        "est_runtime",
        "preempt",
        "route", "transfer_cost", "sites", "current_site",
        "recall",
    }
)

SLOT_NAMES: frozenset[str] = frozenset(ast.SLOTS)

_RESERVED_TARGETS = BUILTINS | SLOT_NAMES | KEYWORDS

_COMPARISONS = {"LT": "<", "LE": "<=", "GT": ">", "GE": ">=", "EQ": "==", "NEQ": "!="}


def parse(src: str) -> Program:
    """Parse Kata source into an AST. Raises KataSyntaxError on any violation (including a
    runaway nesting depth that would otherwise overflow the Python recursion limit)."""
    prev = sys.getrecursionlimit()
    sys.setrecursionlimit(max(prev, 20000))  # headroom so we *detect* depth, not crash
    try:
        return parse_program(tokenize(src))
    except RecursionError as exc:
        raise KataSyntaxError("expression nests too deeply", code="max_depth") from exc
    finally:
        sys.setrecursionlimit(prev)


def parse_program(tokens: list[Token]) -> Program:
    return _Parser(tokens).program()


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self.toks = tokens
        self.pos = 0

    # -- token helpers -------------------------------------------------------

    def peek(self) -> Token:
        """Next significant token WITHOUT consuming (NEWLINEs are transparent here)."""
        return self.toks[self.peek_index()]

    def peek_index(self) -> int:
        j = self.pos
        while self.toks[j].type == "NEWLINE":
            j += 1
        return j

    def peek_raw(self) -> Token:
        return self.toks[self.pos]

    def advance(self) -> Token:
        """Consume the next significant token (skipping any NEWLINEs before it)."""
        while self.peek_raw().type == "NEWLINE":
            self.pos += 1
        tok = self.toks[self.pos]
        self.pos += 1
        return tok

    def at(self, ttype: str, value: object = ...) -> bool:
        tok = self.peek()
        return tok.type == ttype and (value is ... or tok.value == value)

    def check_newline_end(self) -> bool:
        """True when the statement is over: NEWLINE, DEDENT, or EOF follows."""
        ttype = self.peek_raw().type
        return ttype in ("NEWLINE", "DEDENT", "EOF")

    def expect(self, ttype: str, value: object = ...) -> Token:
        tok = self.peek()
        if tok.type != ttype or (value is not ... and tok.value != value):
            wanted = ttype if value is ... else f"{ttype} {value!r}"
            raise self._error(tok, f"expected {wanted}, got {self._describe(tok)}")
        return self.advance()

    def expect_name(self) -> Token:
        return self.expect("NAME")

    @staticmethod
    def _describe(tok: Token) -> str:
        if tok.type == "EOF":
            return "end of input"
        if tok.type == "NEWLINE":
            return "end of line"
        return f"{tok.value!r}"

    @staticmethod
    def _error(tok: Token, message: str, code: str = "syntax") -> KataSyntaxError:
        return KataSyntaxError(message, code=code, line=tok.line, col=tok.col)

    # -- top level -----------------------------------------------------------

    def program(self) -> Program:
        modules: list[ast.Module] = []
        defs: list[ast.Def] = []
        while True:
            if self.peek_raw().type == "DEDENT":
                raise self._error(self.peek_raw(), "unexpected dedent", "bad_indent")
            tok = self.peek()
            if tok.type == "INDENT":
                raise self._error(tok, "unexpected indent at top level", "bad_indent")
            if tok.type == "EOF":
                break
            if tok.type == "NAME" and tok.value == "def":
                defs.append(self.parse_def())
            elif tok.type == "NAME" and tok.value in SLOT_NAMES:
                modules.append(self.parse_module())
            else:
                raise self._error(tok, f"expected a module (`{tok.value} by name:`) or `def`")
            self.expect_newline_ok()
        return ast.Program(tuple(modules), tuple(defs))

    def expect_newline_ok(self) -> None:
        """A module/def must be followed by a line break (or EOF)."""
        while self.peek_raw().type == "NEWLINE":
            self.pos += 1

    def parse_module(self) -> ast.Module:
        slot = self.expect_name().value
        self.expect("NAME", "by")
        name = self.expect_name().value
        self.expect("COLON")
        after = self.peek_raw()
        self.expect_block_intro(after)
        body = self.block(f"{slot} module body")
        return ast.Module(slot, name, tuple(body))

    def parse_def(self) -> ast.Def:
        kw = self.advance()  # 'def'
        name_tok = self.expect_name()
        self._check_not_shadow(name_tok, what="function name")
        self.expect("LPAREN")
        params: list[str] = []
        if not self.at("RPAREN"):
            while True:
                ptok = self.expect_name()
                self._check_not_shadow(ptok, what="parameter")
                params.append(ptok.value)
                if self.at("COMMA"):
                    self.advance()
                    if self.at("RPAREN"):
                        break
                else:
                    break
        self.expect("RPAREN")
        colon = self.expect("COLON")
        self.expect_block_intro(colon)
        body = self.block("def body", at_least_one=True)
        return ast.Def(name_tok.value, tuple(params), tuple(body))

    # -- blocks and statements -----------------------------------------------

    def expect_block_intro(self, err_tok: Token, context: str = "block") -> None:
        """After a ':': NEWLINE* INDENT — or a §9 code error pinpointing the ':' line."""
        tok = self.peek()  # skips NEWLINEs
        if tok.type == "INDENT":
            return
        if tok.type in ("DEDENT", "EOF"):
            raise self._error(
                err_tok, f"expected an indented block for {context}", "unterminated_block"
            )
        raise self._error(err_tok, f"expected an indented block for {context}")

    def block(self, context: str = "block", at_least_one: bool = False) -> list[ast.Stmt]:
        """Parse INDENT stmt+ DEDENT (the INDENT must already have been checked)."""
        self.expect("INDENT")
        stmts: list[ast.Stmt] = []
        while True:
            tok = self.peek_raw()
            if tok.type == "NEWLINE":
                self.pos += 1
                continue
            if tok.type == "INDENT":
                raise self._error(
                    tok, "unexpected indent (previous statement did not open a block)",
                    "bad_indent",
                )
            if tok.type in ("DEDENT", "EOF"):
                break
            stmts.append(self.statement())
        if tok.type == "EOF":
            raise self._error(tok, f"unterminated block: {context}", "unterminated_block")
        self.advance()  # consume the block's DEDENT
        if not stmts and at_least_one:
            raise self._error(tok, f"empty {context}", "syntax")
        return stmts

    def statement(self) -> ast.Stmt:
        tok = self.peek()
        line = tok.line
        if tok.type == "NAME":
            kw = tok.value
            if kw == "pass":
                self.advance()
                self.finish_stmt()
                return ast.Pass()
            if kw == "return":
                self.advance()
                value = None if self.check_newline_end() else self.expression()
                self.finish_stmt()
                return ast.Return(value, line)
            if kw == "if":
                return self.if_stmt(line, tok.col)
            if kw == "while":
                self.advance()
                test = self.expression()
                self.expect("COLON")
                body = self.indented_block("while body", at_least_one=True)
                return ast.While(test, tuple(body), line)
            if kw == "for":
                self.advance()
                target = self.expect_name().value
                self.expect("NAME", "in")
                iter_expr = self.expression()
                self.expect("COLON")
                body = self.indented_block("for body", at_least_one=True)
                return ast.For(target, iter_expr, tuple(body), line)
            if kw == "remember":
                self.advance()
                name_tok = self.expect_name()
                self._check_target(name_tok)
                self.expect("ASSIGN")
                value = self.expression()
                self.finish_stmt()
                return ast.Remember(name_tok.value, value, line)
        # Assignment lookahead BEFORE parsing an expression: a reserved NAME in target
        # position must raise shadow_builtin, not the atom's keyword/syntax error.
        j = self.peek_index()
        if self.toks[j].type == "NAME" and self.toks[j + 1].type == "ASSIGN":
            name_tok = self.toks[j]
            self._check_target(name_tok)
            self.pos = j
            self.advance()  # target NAME
            self.advance()  # '='
            value = self.expression()
            self.finish_stmt()
            return ast.Assign(name_tok.value, value, name_tok.line)
        if self.toks[j].type == "NAME" and self.toks[j + 1].type == "DOT":
            k = j + 1
            while self.toks[k].type == "DOT" and self.toks[k + 1].type == "NAME":
                k += 2
            if self.toks[k].type == "ASSIGN":
                raise self._error(
                    self.toks[k], "cannot assign to a record field", "field_write"
                )
        expr = self.expression()
        if self.peek_raw().type == "ASSIGN":  # must be adjacent — no line-crossing assignment
            eq = self.advance()
            if isinstance(expr, ast.Attribute):
                raise self._error(eq, "cannot assign to a record field", "field_write")
            if not isinstance(expr, ast.Name):
                raise self._error(eq, "invalid assignment target")
            self._check_target(eq, name=expr.id)
            value = self.expression()
            self.finish_stmt()
            return ast.Assign(expr.id, value, line)
        self.finish_stmt()
        return ast.ExprStmt(expr, line)

    def _check_target(self, tok: Token, name: str | None = None) -> None:
        target = name if name is not None else tok.value
        if target in KEYWORDS:
            raise self._error(tok, f"cannot assign to reserved word {target!r}", "shadow_builtin")
        if target in _RESERVED_TARGETS:
            raise self._error(tok, f"{target!r} is a builtin/slot name", "shadow_builtin")

    def _check_not_shadow(self, tok: Token, what: str) -> None:
        if tok.value in KEYWORDS or tok.value in _RESERVED_TARGETS:
            raise self._error(tok, f"{what} {tok.value!r} shadows a builtin/slot", "shadow_builtin")

    def finish_stmt(self) -> None:
        ttype = self.peek_raw().type
        if ttype == "NEWLINE":
            self.pos += 1
        elif ttype == "INDENT":
            raise self._error(self.peek_raw(), "unexpected indent after statement", "bad_indent")
        elif ttype not in ("DEDENT", "EOF"):
            raise self._error(self.peek_raw(), f"unexpected {self._describe(self.peek_raw())} after statement")

    def indented_block(self, context: str, at_least_one: bool = False) -> list[ast.Stmt]:
        err_tok = self.peek_raw()
        self.expect_block_intro(err_tok, context)
        return self.block(context, at_least_one)

    def if_stmt(self, line: int, col: int) -> ast.If:
        self.advance()  # 'if'
        test = self.expression()
        self.expect("COLON")
        body = self.indented_block("if body", at_least_one=True)
        elifs: list[tuple[ast.Expr, tuple]] = []
        els: tuple = ()
        # elif/else align with the `if` (column-checked so an outer if's clause never binds
        # here). Their line's DEDENT(s) may precede the keyword token; when one is consumed
        # only to find a non-continuation, it is rewound for the enclosing block to consume.
        while True:
            mark = None
            if self.peek_raw().type == "DEDENT":
                mark = self.pos
                self.pos += 1
            tok = self.peek()
            if (
                tok.type == "NAME"
                and tok.col == col
                and not els
                and ((tok.value == "elif") or (tok.value == "else"))
            ):
                self.advance()
                if tok.value == "elif":
                    cond = self.expression()
                    self.expect("COLON")
                    eb = self.indented_block("elif body", at_least_one=True)
                    elifs.append((cond, tuple(eb)))
                else:
                    self.expect("COLON")
                    els = tuple(self.indented_block("else body", at_least_one=True))
                continue
            if mark is not None:
                self.pos = mark  # DEDENT belongs to an enclosing block
            break
        return ast.If(test, tuple(body), tuple(elifs), tuple(els), line)

    # -- expressions (spec §2 precedence, loosest first) -----------------------

    def expression(self) -> ast.Expr:
        return self.or_expr()

    def or_expr(self) -> ast.Expr:
        values = [self.and_expr()]
        while self.at("NAME", "or"):
            self.advance()
            values.append(self.and_expr())
        return values[0] if len(values) == 1 else ast.BoolOp("or", tuple(values))

    def and_expr(self) -> ast.Expr:
        values = [self.not_expr()]
        while self.at("NAME", "and"):
            self.advance()
            values.append(self.not_expr())
        return values[0] if len(values) == 1 else ast.BoolOp("and", tuple(values))

    def not_expr(self) -> ast.Expr:
        if self.at("NAME", "not"):
            self.advance()
            return ast.UnaryOp("not", self.not_expr())
        return self.comparison()

    def comparison(self) -> ast.Expr:
        left = self.adder()
        ttype = self.peek().type
        if ttype in _COMPARISONS:
            op = _COMPARISONS[ttype]
            self.advance()
            return ast.BinOp(op, left, self.adder())
        return left

    def adder(self) -> ast.Expr:
        left = self.multiplicative()
        while True:
            tok = self.peek()
            if tok.type in ("PLUS", "MINUS", "PIPE"):
                self.advance()
                left = ast.BinOp(tok.value, left, self.multiplicative())
            else:
                return left

    def multiplicative(self) -> ast.Expr:
        left = self.unary()
        while True:
            tok = self.peek()
            if tok.type in ("STAR", "SLASH", "DOUBLESLASH", "PERCENT"):
                self.advance()
                left = ast.BinOp(tok.value, left, self.unary())
            else:
                return left

    def unary(self) -> ast.Expr:
        if self.at("MINUS"):
            self.advance()
            operand = self.unary()
            if isinstance(operand, ast.Int):
                return ast.Int(-operand.value)
            if isinstance(operand, ast.Float):
                return ast.Float(-operand.value)
            return ast.UnaryOp("-", operand)
        return self.atom()

    def atom(self) -> ast.Expr:
        tok = self.peek()
        if tok.type == "INT":
            self.advance()
            return ast.Int(int(str(tok.value).replace("_", ""), 10))
        if tok.type == "FLOAT":
            self.advance()
            return ast.Float(float(str(tok.value).replace("_", "")))
        if tok.type == "STRING":
            self.advance()
            return ast.Str(tok.value)
        if tok.type == "LPAREN":
            return self.paren()
        if tok.type == "LBRACKET":
            return self.list_lit()
        if tok.type != "NAME":
            raise self._error(tok, f"expected an expression, got {self._describe(tok)}")
        self.advance()
        name = tok.value
        if name == "nil":
            return ast.Nil()
        if name == "true":
            return ast.Bool(True)
        if name == "false":
            return ast.Bool(False)
        if self.at("LPAREN"):
            return self.call(tok, name)
        if self.at("DOT"):
            value: ast.Expr = ast.Name(name)
            while self.at("DOT"):
                self.advance()
                attr_tok = self.expect_name()
                value = ast.Attribute(value, attr_tok.value)
            return value
        if name in KEYWORDS:
            raise self._error(tok, f"unexpected keyword {name!r} in expression")
        return ast.Name(name)

    def call(self, name_tok: Token, name: str) -> ast.Call:
        self.expect("LPAREN")
        args: list[ast.Expr] = []
        kwargs: list[tuple[str, ast.Expr]] = []
        if not self.at("RPAREN"):
            while True:
                j = self.peek_index()
                if self.toks[j].type == "NAME" and self.toks[j + 1].type == "ASSIGN":
                    key = self.advance().value
                    if key in KEYWORDS:
                        raise self._error(self.toks[j],
                                          f"invalid keyword argument {key!r}")
                    self.expect("ASSIGN")
                    kwargs.append((key, self.expression()))
                else:
                    if kwargs:
                        raise self._error(self.peek(), "positional argument after keyword argument")
                    args.append(self.expression())
                if self.at("COMMA"):
                    self.advance()
                    if self.at("RPAREN"):
                        break
                else:
                    break
        self.expect("RPAREN")
        return ast.Call(name, tuple(args), tuple(kwargs))

    def paren(self) -> ast.Expr:
        self.expect("LPAREN")
        if self.at("RPAREN"):
            raise self._error(self.peek(), "empty () is not a value")
        elts = [self.expression()]
        while self.at("COMMA"):
            self.advance()
            if self.at("RPAREN"):
                self.advance()
                return ast.Tuple(tuple(elts))  # trailing comma: (a,) or (a, b,)
            elts.append(self.expression())
        self.expect("RPAREN")
        if len(elts) == 1:
            return elts[0]  # grouping
        return ast.Tuple(tuple(elts))

    def list_lit(self) -> ast.ListLit:
        self.expect("LBRACKET")
        elts: list[ast.Expr] = []
        if not self.at("RBRACKET"):
            while True:
                elts.append(self.expression())
                if self.at("COMMA"):
                    self.advance()
                    if self.at("RBRACKET"):
                        break
                else:
                    break
        self.expect("RBRACKET")
        return ast.ListLit(tuple(elts))
