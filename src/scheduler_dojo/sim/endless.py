"""Endless mode: a growth curve instead of a fixed level — one seeded stream until the horizon.

``generate_endless_jobs(seed, growth)`` mirrors ``sim/trace.py`` conventions: one
``random.Random(seed)`` feeds every draw and nothing else (no global ``random``, no wall clock);
per job the draws happen in a fixed order (arrival gap, then user, then nodes, then walltime);
jobs past the horizon are dropped *after* drawing so the stream cannot shift; ids ``e%06d`` are
assigned after a stable sort by ``(submit_time, draw order)``, so the same seed + growth always
produces byte-identical jobs (see ``docs/vault/Concepts/Determinism.md``).

Growth dict (every sub-key optional; the shape the city-endless UI sends)::

    {"base":   {"users": [{"name": str, "weight": float}, ...]   default [{"name": "user0", "weight": 1.0}]
                "arrival": [min, max]     per-job gap seconds   default [1800, 3600]
                "nodes":   [min, max]     uniform integer nodes  default [1, 1]
                "walltime":[min, max]     uniform integer seconds default [600, 3600]
                "jobs_per_day": int                               default 24},
     "growth": {"new_user_every_days": int   a new neighbour moves in every N days   0/absent = none
                "max_users": int             cap on neighbourhoods (base users all count)
                "arrival_ramp_pct_per_day": int  gap window shrinks by this % per day
                "rate_ramp_pct_per_week": int    jobs_per_day grows by this % per week
                "cap_jobs_per_day": int          ceiling on the weekly-ramped count
                "horizon": int                    default 30*86400 (30 literal sim-days)}}

Structure: one calendar week = seven literal 86,400 s days ([[Concepts/Campus]]), so endless is
generated day by day. Each day the per-job gap window is the base window scaled by
``(1 - arrival_ramp_pct_per_day/100) ** day``, the day carries
``min(cap, jobs_per_day * (1 + rate_ramp_pct_per_week/100) ** (day // 7))`` jobs, and the active
users are the base users plus one extra per ``new_user_every_days`` days (capped at
``max_users``), named ``user{k}`` beyond the base names. ``actual_runtime == walltime_req``
(honest walltimes — no ratio knob in the growth schema; an ambiguity resolved the boring way).
"""

from __future__ import annotations

import random
from typing import Any

from scheduler_dojo.sim.jobs import Job

DAY_SECONDS = 86400
DEFAULT_HORIZON = 30 * DAY_SECONDS
DEFAULT_ARRIVAL = (1800, 3600)
DEFAULT_NODES = (1, 1)
DEFAULT_WALLTIME = (600, 3600)
DEFAULT_JOBS_PER_DAY = 24


def generate_endless_jobs(seed: int, growth: dict[str, Any] | None) -> list[Job]:
    """Generate a deterministic endless job list from a growth curve (see the module docstring)."""
    growth = growth or {}
    base = dict(growth.get("base") or {})
    ramp = dict(growth.get("growth") or {})

    horizon = int(ramp.get("horizon", DEFAULT_HORIZON))
    names, weights = _users(base.get("users"))
    arrival = _pair(base.get("arrival"), DEFAULT_ARRIVAL, "arrival")
    nodes = _pair(base.get("nodes"), DEFAULT_NODES, "nodes")
    walltime = _pair(base.get("walltime"), DEFAULT_WALLTIME, "walltime")
    jobs_per_day = max(1, int(base.get("jobs_per_day", DEFAULT_JOBS_PER_DAY)))

    new_user_every = max(0, int(ramp.get("new_user_every_days", 0) or 0))
    max_users = max(len(names), int(ramp.get("max_users", 0) or 0)) if ramp.get(
        "max_users") is not None else 0
    arrival_pct = min(max(0.0, float(ramp.get("arrival_ramp_pct_per_day", 0) or 0)), 99.0)
    rate_pct = max(0.0, float(ramp.get("rate_ramp_pct_per_week", 0) or 0))
    cap = int(ramp.get("cap_jobs_per_day", 0) or 0)

    rng = random.Random(seed)
    rows: list[tuple[int, str, int, int]] = []  # (submit, user, nodes, walltime); drawn in order
    day = 0
    while day * DAY_SECONDS < max(0, horizon):
        day_start = day * DAY_SECONDS
        # User roster for this day: base users plus one extra every N days, capped.
        roster, roster_w = list(names), list(weights)
        if new_user_every:
            extra = min(max_users - len(names), day // new_user_every) if max_users else day // new_user_every
            for k in range(max(0, extra)):
                roster.append(f"user{len(names) + k}")
                roster_w.append(1.0)
        lo, hi = arrival_window(arrival, day, arrival_pct)
        n = jobs_on_day(jobs_per_day, day, rate_pct, cap)
        cursor = day_start
        for _ in range(n):
            cursor += rng.uniform(lo, hi)                       # draw 1: arrival gap
            user = _weighted(rng, roster, roster_w)             # draw 2: neighbourhood
            k = rng.randint(nodes[0], nodes[1])                 # draw 3: width
            w = rng.randint(walltime[0], walltime[1])           # draw 4: length
            submit = min(int(round(cursor)), day_start + DAY_SECONDS - 1)
            rows.append((submit, user, k, w))
        day += 1

    if horizon > 0:  # drop happens after all draws, so it cannot shift the RNG stream
        rows = [r for r in rows if r[0] <= horizon]
    rows.sort(key=lambda r: r[0])  # stable: ties keep draw order, so ids are reproducible
    jobs = [
        Job(id=f"e{i:06d}", user=user, submit_time=submit, nodes_req=k,
            walltime_req=w, actual_runtime=w)  # honest walltimes (no ratio knob)
        for i, (submit, user, k, w) in enumerate(rows)
    ]
    return sorted(jobs, key=lambda j: (j.submit_time, j.id))


def arrival_window(base: tuple[int, int] | list, day: int, ramp_pct_per_day: float) -> tuple[float, float]:
    """The per-job gap window on ``day``: the base window scaled by ``(1 - pct/100) ** day``."""
    lo, hi = _pair(base, DEFAULT_ARRIVAL, "arrival")
    factor = (1.0 - min(max(ramp_pct_per_day, 0.0), 99.0) / 100.0) ** max(0, int(day))
    return lo * factor, hi * factor


def jobs_on_day(jobs_per_day: int, day: int, rate_pct_per_week: float,
                cap_jobs_per_day: int = 0) -> int:
    """The job count on ``day``: base count compounded weekly by ``rate_pct_per_week``, capped."""
    n = int(round(jobs_per_day * (1.0 + max(0.0, rate_pct_per_week) / 100.0) ** (max(0, int(day)) // 7)))
    n = max(1, n)
    if cap_jobs_per_day:
        n = min(n, max(1, int(cap_jobs_per_day)))
    return n


def _pair(value: Any, default: tuple[int, int], what: str) -> tuple[int, int]:
    """Coerce a ``[min, max]`` pair to ordered positive ints (defaults when absent/malformed)."""
    if not value:
        return default
    items = list(value)
    lo, hi = int(items[0]), int(items[min(1, len(items) - 1)])
    if lo > hi:
        lo, hi = hi, lo
    return max(1, lo), max(max(1, lo), hi)


def _users(value: Any) -> tuple[list[str], list[float]]:
    items = list(value) if value else [{"name": "user0", "weight": 1.0}]
    items = [{"name": str(u)} if isinstance(u, str) else u for u in items]
    names = [str(dict(u).get("name", f"user{k}")) for k, u in enumerate(items)]
    weights = [max(0.0, float(dict(u).get("weight", 1.0))) for u in items]
    if sum(weights) <= 0:
        weights = [1.0] * len(names)
    return names, weights


def _weighted(rng: random.Random, names: list[str], weights: list[float]) -> str:
    """Cumulative weighted pick over one rng.random() draw (same shape as trace._weighted)."""
    total = sum(weights)
    r = rng.random() * total
    acc = 0.0
    for name, w in zip(names, weights):
        acc += w
        if r < acc:
            return name
    return names[-1]
