"""The campus calendar: the ONE place day/week/week-end are computed (CLI and browser agree).

Per ``docs/vault/Concepts/Campus.md`` a city's horizon spans exactly one week: the week is
sliced into ``weeks`` equal days whose stride is ``duration // weeks`` (a literal 86,400 s day
would give a sub-two-day level no weekly rhythm at all). Endless mode passes the literal
``day_secs=86400`` to :func:`day_clock`, where the sun cycle is a real day.

Determinism (see ``docs/vault/Concepts/Determinism.md``): pure integer arithmetic on the sim
clock plus one float division for the sun fraction; no wall clock, no RNG, no iteration order.
"""

from __future__ import annotations

DAY_SECONDS = 86400  # one sim-day in sim-seconds (the literal day endless uses)
WEEK_DAYS = 7


def _stride(duration: int, weeks: int) -> int:
    """Seconds per calendar day: the horizon sliced into ``weeks`` (7) equal days, >= 1."""
    return max(1, max(1, int(duration)) // max(1, int(weeks)))


def day_week(t: int, t0: int, duration: int, weeks: int = WEEK_DAYS) -> tuple[int, int]:
    """(day, week) — both 1-indexed — for sim time ``t`` in a level starting at ``t0``.

    The day stride spans the level horizon (``duration // weeks`` seconds per day), so a level
    of any length still shows one full week; times before ``t0`` report the first day.
    """
    stride = _stride(duration, weeks)
    day_index = max(0, int(t) - int(t0)) // stride
    return day_index + 1, day_index // max(1, int(weeks)) + 1


def day_clock(t: int, t0: int, duration: int, weeks: int = WEEK_DAYS,
              day_secs: int = DAY_SECONDS) -> tuple[int, float]:
    """(day_index, frac): 0-indexed day plus position ``frac`` in [0, 1) of the sun cycle.

    The sun cycle is ``min(day_secs, stride)`` seconds, so a short level still shows a full
    day-night arc inside each calendar day, and endless (literal ``day_secs=86400`` over a
    long horizon) shows several real days per calendar day. ``day_index`` is 0-indexed here
    (a renderer offset); :func:`day_week` returns the 1-indexed labels.
    """
    stride = _stride(duration, weeks)
    cycle = min(max(1, int(day_secs)), stride)
    elapsed = max(0, int(t) - int(t0))
    return elapsed // stride, (elapsed % cycle) / cycle


def week_end_time(t0: int, duration: int, week: int, weeks: int = WEEK_DAYS) -> int:
    """The sim time week ``week`` (1-indexed) ends — the boundary the run freezes on.

    Exactly ``t0 + week * weeks * stride``; consistent with :func:`day_week` (a t equal to this
    instant is already day 1 of week ``week + 1``) and strictly monotone in ``week``.
    """
    return int(t0) + max(1, int(week)) * max(1, int(weeks)) * _stride(duration, weeks)
