"""Kata — the Scheduler Dojo policy language.

Public API (lazily imported so the package works while submodules are under construction):
`parse(src) -> Program`, `format(src) -> str`, `format_program(program)`, and `KataPolicy`.
The checker (`check`, `Report`) lives on the `scheduler_dojo.kata.check` submodule — importing it
here as a name would be shadowed by the `check` submodule itself. See `spec.md`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

__all__ = [
    "parse",
    "format",
    "format_program",
    "KataPolicy",
    "KataSyntaxError",
    "Program",
    "Module",
]


def __getattr__(name: str):
    import importlib
    if name in ("Program", "Module"):
        return getattr(importlib.import_module("scheduler_dojo.kata.ast"), name)
    if name == "KataSyntaxError":
        return importlib.import_module("scheduler_dojo.kata.errors").KataSyntaxError
    if name == "KataPolicy":
        return importlib.import_module("scheduler_dojo.kata.policy").KataPolicy
    if name in ("format", "format_program"):
        return getattr(importlib.import_module("scheduler_dojo.kata.formatter"), name)
    if name == "parse":
        return importlib.import_module("scheduler_dojo.kata.parser").parse
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if TYPE_CHECKING:  # for type checkers / static imports
    from scheduler_dojo.kata.ast import Module, Program
    from scheduler_dojo.kata.errors import KataSyntaxError
    from scheduler_dojo.kata.formatter import format, format_program
    from scheduler_dojo.kata.parser import parse
    from scheduler_dojo.kata.policy import KataPolicy
