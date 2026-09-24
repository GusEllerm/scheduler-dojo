"""Structured engine errors.

A policy (manual UI or a kata) can propose an action the engine must reject; that is a
``PolicyError`` with a stable ``code`` and a one-line teaching message — the UI shows it
against the offending kata line and never crashes. Determinism/level errors are distinct.
"""

from __future__ import annotations


class EngineError(Exception):
    """Base for engine-raised, structured errors."""

    def __init__(self, message: str, *, code: str, line: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.line = line  # kata line number when the error came from a kata


class PolicyError(EngineError):
    """An invalid policy action (place a job that doesn't fit, reserve in the past, ...)."""


class StepBudgetError(EngineError):
    """A kata exhausted its per-decision interpreter steps."""


class DeterminismError(EngineError):
    """An internal invariant that protects determinism was violated (should never fire)."""


# Stable error codes — the UI and tests key off these, not the message text.
UNKNOWN_JOB = "unknown_job"
ALREADY_RUNNING = "already_running"
DEPS_UNMET = "deps_unmet"
NO_NODES = "no_nodes"
MISMATCH = "mismatch"
PAST_TIME = "past_time"
