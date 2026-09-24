"""Kata lexer — deterministic tokenizer for the indentation-structured Kata surface syntax.

Emits a flat list of ``Token`` (type, value, line, col) with ``line`` 1-based and ``col`` 0-based.
Blocks are structured like Python's tokenize: ``NEWLINE`` ends a statement, ``INDENT``/``DEDENT``
open/close an indentation block. An INDENT token's value is the new indent width (column); a DEDENT
value is "". (The parser only cares about the events; positions carry the diagnostics.)

Rules (spec.md §1):
- Comments (``#`` to EOL) are skipped; blank/comment-only lines emit no ``NEWLINE``.
- Indent units are spaces only — a tab in leading whitespace raises code="tab".
- A dedent that does not match an open block raises code="bad_indent". An INDENT seen where no
  block can belong (top level) is rejected by the parser, also as code="bad_indent".
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from scheduler_dojo.kata.errors import KataSyntaxError

__all__ = ["Token", "KEYWORDS", "TOKEN_TYPES", "tokenize"]

#: Reserved words. Every one of these is emitted as a NAME token whose value is the keyword
#: text — the parser distinguishes them by value. (`never` is deliberately NOT a keyword; it
#: is only a conventional module label, e.g. `preempt by never:`.)
KEYWORDS: frozenset[str] = frozenset(
    {
        "order", "place", "preempt", "route",
        "by", "def",
        "if", "elif", "else",
        "for", "in", "while",
        "return", "pass", "remember",
        "not", "and", "or",
        "true", "false", "nil",
    }
)

#: Canonical token type order — the UI syntax-highlighting mode is generated from this tuple.
TOKEN_TYPES: tuple[str, ...] = (
    "INT", "FLOAT", "STRING", "NAME",
    "NEWLINE", "INDENT", "DEDENT", "EOF",
    "LPAREN", "RPAREN", "LBRACKET", "RBRACKET", "COMMA",
    "ASSIGN", "DOT", "COLON",
    "PLUS", "MINUS", "STAR", "SLASH", "DOUBLESLASH", "PERCENT", "PIPE",
    "LT", "LE", "GT", "GE", "EQ", "NEQ",
)


@dataclass(frozen=True)
class Token:
    type: str
    value: object
    line: int   # 1-based
    col: int    # 0-based


_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER_RE = re.compile(r"\d[\d_]*(?:\.[\d_]+)?")
_SPACES_RE = re.compile(r" *")

# Longest operators first: the two-character members must precede their prefixes
# ("==" before "=", "<=" before "<", "//" before "/") so greedy matching works.
_OPS: tuple[tuple[str, str], ...] = (
    ("//", "DOUBLESLASH"),
    ("==", "EQ"),
    ("!=", "NEQ"),
    ("<=", "LE"),
    (">=", "GE"),
    ("(", "LPAREN"),
    (")", "RPAREN"),
    ("[", "LBRACKET"),
    ("]", "RBRACKET"),
    (",", "COMMA"),
    ("=", "ASSIGN"),
    (".", "DOT"),
    (":", "COLON"),
    ("+", "PLUS"),
    ("-", "MINUS"),
    ("*", "STAR"),
    ("/", "SLASH"),
    ("%", "PERCENT"),
    ("|", "PIPE"),
    ("<", "LT"),
    (">", "GT"),
)


def _error(line: int, col: int, message: str, code: str = "syntax") -> KataSyntaxError:
    return KataSyntaxError(message, code=code, line=line, col=col)


def tokenize(src: str) -> list[Token]:
    """Tokenize Kata source. Raises KataSyntaxError (code tab/bad_indent/syntax)."""
    out: list[Token] = []
    indents: list[int] = [0]
    line_no = 1
    saw_content = False  # any content token since the last emitted NEWLINE?

    def emit(ttype: str, value: object, line: int, col: int) -> None:
        nonlocal saw_content
        out.append(Token(ttype, value, line, col))
        saw_content = ttype != "NEWLINE"

    for raw in src.splitlines():
        # Trailing "\r" (a lone "\r" was its own line via splitlines) is line content.
        content = raw[:-1] if raw.endswith("\r") else raw

        i = 0
        length = len(content)
        while i < length:
            spaces = _SPACES_RE.match(content, i)
            i = spaces.end()
            if i >= length:
                break  # rest of the line is whitespace: blank or comment-only
            ch = content[i]
            if ch == "#":
                break  # comment runs to EOL; the line emits no NEWLINE if it had no tokens
            if ch == "\t":
                if not saw_content:
                    raise _error(line_no, i, "tab in indentation", "tab")
                raise _error(line_no, i, "unexpected tab")
            if not saw_content:
                # First token of the line: resolve its indentation against open blocks.
                if i > indents[-1]:
                    indents.append(i)
                    emit("INDENT", i, line_no, 0)
                else:
                    while i < indents[-1]:
                        indents.pop()
                        emit("DEDENT", "", line_no, i)
                    if i != indents[-1]:
                        raise _error(
                            line_no, i, "inconsistent dedent", "bad_indent"
                        )
            if ch == '"':
                i = _scan_string(content, i, line_no, emit)
                continue
            if ch == "\n":
                break  # defensive: splitlines removes line terminators
            m = _IDENT_RE.match(content, i)
            if m:
                emit("NAME", m.group(), line_no, i)
                i = m.end()
                continue
            m = _NUMBER_RE.match(content, i)
            if m:
                text = m.group()
                emit("FLOAT" if "." in text else "INT", text, line_no, i)
                i = m.end()
                continue
            for op, ttype in _OPS:
                if content.startswith(op, i):
                    emit(ttype, op, line_no, i)
                    i += len(op)
                    break
            else:
                raise _error(line_no, i, f"unexpected character {ch!r}")
        if saw_content:
            # Only content lines end with NEWLINE; blank/comment-only lines emit nothing.
            emit("NEWLINE", "", line_no, len(content))
        line_no += 1

    if saw_content and (not out or out[-1].type != "NEWLINE"):
        # File ended without a newline after the last content line.
        out.append(Token("NEWLINE", "", max(line_no - 1, 1), 0))
        saw_content = True
    while len(indents) > 1:
        indents.pop()
        out.append(Token("DEDENT", "", line_no, 0))
    out.append(Token("EOF", None, line_no, 0))
    return out


def _scan_string(content: str, start: int, line_no: int, emit) -> int:
    """Scan a double-quoted string at ``start``; emit STRING and return the index past it."""
    i = start + 1
    parts: list[str] = []
    while i < len(content):
        ch = content[i]
        if ch == "\\":
            if i + 1 >= len(content):
                raise _error(line_no, start, "invalid escape at end of line")
            parts.append(content[i + 1])
            i += 2
            continue
        if ch == '"':
            emit("STRING", "".join(parts), line_no, start)
            return i + 1
        parts.append(ch)
        i += 1
    raise _error(line_no, start, "unterminated string")
