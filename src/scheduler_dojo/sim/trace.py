"""Trace sources: synthetic job generators (and, later, Slurm sacct import).

A level's "generator spec" is a plain dict; ``generate_jobs`` turns it into an ordered
``list[Job]`` that ``Scheduler`` can consume directly (unique ids, integer submit times).

Determinism (see ``docs/vault/Concepts/Determinism.md``): one ``random.Random(seed)`` feeds
every draw and nothing else — no global ``random``, no wall clock. Per job the draws happen in
a fixed order (arrival delta, then user, then nodes, then walltime, then runtime ratio), and
ids are assigned after sorting by ``(submit_time, index)``, so the same spec + seed always
produces byte-identical jobs. Only ``random`` is imported — exponentials are written as powers
of the literal ``E`` so the module needs no ``math`` (no reliance on runtime-specific helpers).

Spec keys and defaults (every sub-key optional)::

    n_jobs        int                                            default 100
    users         [{"name": str, "weight": float}, ...]          default [{"name": "user0", "weight": 1.0}]
    arrival       {"type": "poisson", "rate_per_hour": float}    default rate 20.0 (mean gap 3600/rate s)
                  {"type": "uniform", "first": int, "last": int} default first 0, last 86400
    nodes         {"type": "fixed", "value": int}                default fixed 1
                  {"type": "discrete", "choices": [[n, p], ...]} probs need not sum to 1 (normalized)
    walltime      {"type": "fixed", "value": int}                default fixed 3600 s
                  {"type": "lognormal", "median": int, "sigma": float} default median 1800, sigma 0.5
    runtime_ratio {"type": "lognormal", "median": float, "sigma": float}  default median 0.5, sigma 0.5
                  {"type": "fixed", "value": float}                 # constant ratio, e.g. 1.0 = honest walltime

``runtime_ratio`` is the "walltime lies" model: ``actual_runtime`` is drawn independently of
the request as ``walltime_req * ratio``, so a slice of jobs overruns its walltime and is killed
at the cap (that is what teaches backfill / walltime discipline).

The keyword-only ``horizon`` is the level's simulated duration in seconds. When ``n_jobs`` is
omitted from a poisson spec, the job count is derived from it (``horizon * rate / 3600``);
either way, jobs whose submit time falls past the horizon are dropped so an arrival never
lands outside the run. Dropping happens after all draws, so it cannot shift the RNG stream.
"""

from __future__ import annotations

import math
import random
from typing import Any

from scheduler_dojo.sim.jobs import Job

# --- defaults (documented in the module docstring) ---
DEFAULT_N_JOBS = 100
DEFAULT_RATE_PER_HOUR = 20.0
DEFAULT_FIRST = 0
DEFAULT_LAST = 24 * 3600
DEFAULT_NODES_VALUE = 1
DEFAULT_WALLTIME_VALUE = 3600
DEFAULT_WALLTIME_MEDIAN = 1800
DEFAULT_SIGMA = 0.5
DEFAULT_RATIO_MEDIAN = 0.5
HOUR_SECONDS = 3600
E = 2.718281828459045  # math.e as a literal: exp() is a power, so no `math` import (Pyodide-safe)
MAX_LOG = 700.0  # clamp so exp(x) stays finite (E**700 ~ 1e304) for pathological sigma


def generate_jobs(spec: dict[str, Any] | None, seed: int, *,
                  horizon: int | None = None) -> list[Job]:
    """Generate a deterministic job list from a generator spec (see the module docstring)."""
    spec = spec or {}
    rng = random.Random(seed)

    arrival = _as_dict(spec.get("arrival"))
    arrival_type = str(arrival.get("type", "poisson"))
    if arrival_type not in ("poisson", "uniform"):
        raise ValueError(f"unknown arrival type {arrival_type!r} (want poisson|uniform)")
    rate = float(arrival.get("rate_per_hour", DEFAULT_RATE_PER_HOUR))
    if arrival_type == "poisson" and rate <= 0:
        raise ValueError("arrival.rate_per_hour must be > 0")
    first = int(arrival.get("first", DEFAULT_FIRST))
    last = int(arrival.get("last", DEFAULT_LAST))

    names, weights = _users(spec.get("users"))

    n_raw = spec.get("n_jobs")
    if n_raw is None:
        if horizon is not None and arrival_type == "poisson":
            n_raw = int(round(max(0, horizon) * rate / HOUR_SECONDS))
        else:
            n_raw = DEFAULT_N_JOBS
    n_jobs = max(0, int(_finite(n_raw, "n_jobs")))

    nodes_dist = _as_dict(spec.get("nodes"))
    wall_dist = _as_dict(spec.get("walltime"))
    ratio_dist = _as_dict(spec.get("runtime_ratio"))

    rows: list[tuple[int, str, int, int, int]] = []  # (submit, user, nodes, walltime, actual)
    total = 0.0
    prev = 0
    for i in range(n_jobs):
        if arrival_type == "poisson":
            total += rng.expovariate(rate / HOUR_SECONDS)
            submit = max(prev, int(round(total)))  # deltas >= 0, so never decreasing
            prev = submit
        else:
            submit = int(round(first + i * (last - first) / max(1, n_jobs - 1)))
        user = _weighted(rng, names, weights)
        nodes = _nodes(rng, nodes_dist)
        walltime = _walltime(rng, wall_dist)
        # The "walltime lies" model: actual runtime is the request times an independent ratio,
        # so a slice of jobs overruns its request and is killed at the cap.
        actual = max(1, int(round(walltime * _ratio(rng, ratio_dist))))
        rows.append((max(0, submit), user, nodes, walltime, actual))

    if horizon is not None:
        rows = [r for r in rows if r[0] <= horizon]

    # Sort stable by submit time (ties keep draw order), then id by arrival position.
    rows.sort(key=lambda r: r[0])
    jobs = [
        Job(id=f"j{i:06d}", user=user, submit_time=submit,
            nodes_req=nodes, walltime_req=walltime, actual_runtime=actual)
        for i, (submit, user, nodes, walltime, actual) in enumerate(rows)
    ]
    return sorted(jobs, key=lambda j: (j.submit_time, j.id))


def poisson_jobs(seed: int, *, n_jobs: int = 200, rate_per_hour: float = DEFAULT_RATE_PER_HOUR,
                 median_walltime: int = DEFAULT_WALLTIME_MEDIAN,
                 users: list[dict[str, Any]] | None = None) -> list[Job]:
    """Convenience: poisson arrivals with lognormal walltimes, for quick tests and fixtures."""
    spec: dict[str, Any] = {
        "n_jobs": n_jobs,
        "arrival": {"type": "poisson", "rate_per_hour": rate_per_hour},
        "walltime": {"type": "lognormal", "median": median_walltime, "sigma": DEFAULT_SIGMA},
    }
    if users is not None:
        spec["users"] = users
    return generate_jobs(spec, seed)


def import_sacct_csv(path: str) -> list[Job]:
    """Import a Slurm ``sacct`` CSV export as a job list (trace mode).

    Not implemented yet: Stage 8 ships trace mode, including the column mapping
    (JobID/User/Submit/Elapsed/NNodes/ReqTimelimit) and the anonymized sample trace.
    """
    raise NotImplementedError("sacct trace import lands in Stage 8")


# --- distribution helpers: every draw is a method call on the single seeded rng ---

def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if value else {}


def _finite(value: Any, what: str) -> float:
    """Coerce to a finite float; reject NaN/inf with a clear error (not a downstream crash)."""
    try:
        f = float(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"{what} must be a number, got {value!r}") from e
    if not math.isfinite(f):
        raise ValueError(f"{what} must be finite, got {value!r}")
    return f


def _users(value: Any) -> tuple[list[str], list[float]]:
    items = list(value) if value else [{"name": "user0", "weight": 1.0}]
    names = [str(dict(u).get("name", f"user{k}")) for k, u in enumerate(items)]
    weights = [float(dict(u).get("weight", 1.0)) for u in items]
    if any(w < 0 for w in weights) or sum(weights) <= 0:
        raise ValueError("users weights must be non-negative and sum to > 0")
    return names, weights


def _weighted(rng: random.Random, names: list[str], weights: list[float]) -> str:
    """Cumulative weighted pick over one rng.random() draw."""
    total = sum(weights)
    r = rng.random() * total
    acc = 0.0
    for name, w in zip(names, weights):
        acc += w
        if r < acc:
            return name
    return names[-1]


def _nodes(rng: random.Random, dist: dict[str, Any]) -> int:
    kind = str(dist.get("type", "fixed"))
    if kind == "fixed":
        return max(1, int(dist.get("value", DEFAULT_NODES_VALUE)))
    if kind != "discrete":
        raise ValueError(f"unknown nodes distribution type {kind!r} (want fixed|discrete)")
    choices = [(int(n), _finite(p, "nodes.choices prob")) for n, p in dist.get("choices", [])]
    if not choices:
        raise ValueError("nodes choices must not be empty")
    if any(p < 0 for _, p in choices):
        raise ValueError("nodes choice probabilities must be non-negative")
    total = sum(p for _, p in choices)
    if total <= 0:
        raise ValueError("nodes choice probabilities must sum to > 0")
    r = rng.random() * total
    acc = 0.0
    for nodes, prob in choices:
        acc += prob
        if r < acc:
            return max(1, nodes)
    return max(1, choices[-1][0])


def _walltime(rng: random.Random, dist: dict[str, Any]) -> int:
    """Walltime request in integer seconds, always >= 1 (and capped to stay representable)."""
    kind = str(dist.get("type", "fixed"))
    if kind == "fixed":
        return max(1, int(_finite(dist.get("value", DEFAULT_WALLTIME_VALUE), "walltime.value")))
    if kind != "lognormal":
        raise ValueError(f"unknown walltime distribution type {kind!r} (want fixed|lognormal)")
    median = _finite(dist.get("median", DEFAULT_WALLTIME_MEDIAN), "walltime.median")
    sigma = _finite(dist.get("sigma", DEFAULT_SIGMA), "walltime.sigma")
    # exp(gauss) overflows for large sigma; clamp the exponent so a fat tail is huge, not a crash.
    return max(1, int(round(median * (E ** min(max(rng.gauss(0.0, sigma), -MAX_LOG), MAX_LOG)))))


def _ratio(rng: random.Random, dist: dict[str, Any]) -> float:
    """actual_runtime / walltime_req. Lognormal around the median ratio (default 0.5)."""
    kind = str(dist.get("type", "lognormal"))
    if kind == "fixed":
        return max(0.0, _finite(dist.get("value", DEFAULT_RATIO_MEDIAN), "runtime_ratio.value"))
    if kind != "lognormal":
        raise ValueError(f"unknown runtime_ratio type {kind!r} (want lognormal|fixed)")
    median = _finite(dist.get("median", DEFAULT_RATIO_MEDIAN), "runtime_ratio.median")
    sigma = _finite(dist.get("sigma", DEFAULT_SIGMA), "runtime_ratio.sigma")
    if median <= 0:
        raise ValueError("runtime_ratio.median must be > 0")
    # exp(N(log median, sigma)) == median * exp(N(0, sigma)): same draw, no log needed.
    return median * (E ** min(max(rng.gauss(0.0, sigma), -MAX_LOG), MAX_LOG))
