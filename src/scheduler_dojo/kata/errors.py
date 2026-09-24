"""Kata-specific errors. Runtime policy/step errors reuse `sim.errors`; this adds the syntax-error
shape the editor formats with a caret. Every error carries a stable `code` from spec.md §9.
"""

from __future__ import annotations

from scheduler_dojo.sim.errors import EngineError, PolicyError, StepBudgetError  # re-exported

__all__ = ["KataSyntaxError", "EngineError", "PolicyError", "StepBudgetError"]


class KataSyntaxError(EngineError):
    """A parse/lex/static error with a line (1-based) and column (0-based) for a caret."""

    def __init__(self, message: str, *, code: str = "syntax", line: int = 0, col: int = 0) -> None:
        super().__init__(message, code=code, line=line)
        self.col = col

    def caret(self, source_lines: list[str]) -> str:
        """Render ``line N: msg`` plus the offending source line with a ``^`` under the column."""
        text = source_lines[self.line - 1] if 1 <= self.line <= len(source_lines) else ""
        pointer = " " * self.col + "^"
        return f"line {self.line}: {self.code}: {self.message}\n  {text}\n  {pointer}"
