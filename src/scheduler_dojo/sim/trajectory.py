"""Canonical trajectory serialization + hash, for golden-trajectory tests and share cards.

The trajectory is the authoritative fingerprint of a run: every job's start/end, in job-id
order. Two runs are identical iff their trajectories are. Keeping the encoding here (one
place) means the CLI, the goldens, and Stage 9 share verification all agree byte-for-byte.
"""

from __future__ import annotations

import hashlib

from scheduler_dojo.sim.scheduler import RunResult


def trajectory_str(result: RunResult) -> str:
    """A compact, deterministic string: one line per job ``id,start,end,state``.

    ``state`` is derived from the result flags so a change in any timing or outcome flips
    the hash. ``None`` timings render as ``-`` (a job that never started by the horizon).
    """
    lines: list[str] = []
    for j in result.jobs:  # RunResult.jobs is already in job-id order
        st = "-" if j.start_time is None else str(j.start_time)
        en = "-" if j.end_time is None else str(j.end_time)
        state = "timeout" if j.timed_out else ("done" if j.completed else "unfinished")
        lines.append(f"{j.id},{st},{en},{state}")
    return "\n".join(lines)


def trajectory_hash(result: RunResult) -> str:
    return hashlib.sha256(trajectory_str(result).encode("utf-8")).hexdigest()
