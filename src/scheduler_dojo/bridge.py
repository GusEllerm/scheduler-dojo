"""The WASM-boundary API — the *only* thing the browser calls into from inside Pyodide.

Everything here is JSON-in / JSON-out and deterministic: given the same level + seed + policy/kata
arguments, it returns byte-identical results on any platform (the same invariant the goldens pin). The
worker just `await pyodide.g["run"](...)`-style dispatches `{id, call, args}` to a function here and
ships the dict back. No engine logic lives in TypeScript.

Public surface (dispatched by name in `dispatch`):

- ``ping()`` -> ``{"ok": True, "version": ...}``
- ``run(level, seed=None, policy="fifo", kata=None)`` -> a run summary + timeline ``frames`` + metrics
  + ``score`` + ``trajectory_hash``. ``level`` is a level dict (or a JSON string).
- ``step(level, seed=..., policy=...)`` starts an interactive run and returns a handle id;
  ``step_n(handle, n)`` / ``step_until(handle, t)`` advance it and return a compact state diff;
  ``step_result(handle)`` finalizes. This is the §4.1 stepping API for animated hand placement.
- ``check_kata(kata)`` -> a ``Report`` dict (``dojo kata check`` for the editor).
- ``calibrate? / version``: ``version()`` for the loading screen.

Keep every returned value JSON-safe: no sets, no tuples-as-tuples (lists), ints for seconds, floats
only where scoring produces them.
"""

from __future__ import annotations

import json
from typing import Any

from scheduler_dojo import __version__
from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.cluster import Cluster
from scheduler_dojo.sim.level import (build_cluster, load_jobs, run_level, validate_level,
                                      _kata_source)
from scheduler_dojo.sim.scheduler import POLICIES, Scheduler
from scheduler_dojo.sim.trajectory import trajectory_hash

# Interactive stepping handles: handle id -> Scheduler (kept alive across step calls).
_SESSIONS: dict[int, Scheduler] = {}
_NEXT_HANDLE = [1]


def _coerce_level(level: Any) -> dict:
    return json.loads(level) if isinstance(level, str) else level


def _nodes_json(cluster: Cluster) -> list[dict]:
    parts = cluster.partitions
    return [{"id": n.id, "name": n.name, "cpus": n.cpus, "gpus": n.gpus,
             "partition": parts[n.partition_id].name if n.partition_id in parts else n.partition_id}
            for n in cluster.nodes]


def _jobs_json(result) -> list[dict]:
    out = []
    for j in result.jobs:
        state = "timeout" if j.timed_out else ("done" if j.completed else "unfinished")
        out.append({"id": j.id, "user": j.user, "nodes": j.nodes_req,
                    "submit": j.submit_time, "start": j.start_time, "end": j.end_time,
                    "runtime": j.runtime_used, "state": state})
    return out


def _score_for(level: dict, result) -> int | None:
    w, a = level.get("score_weights"), level.get("score_anchors")
    return scoring.score(scoring.metrics_from_run(result), w, a) if (w and a) else None


def version() -> dict:
    return {"version": __version__, "python_ok": True}


def ping() -> dict:
    return {"ok": True, "version": __version__}


def run(level: Any, seed: int | None = None, policy: str = "fifo",
        kata: Any | None = None) -> dict:
    lvl = _coerce_level(level)
    validate_level(lvl)
    cluster = build_cluster(lvl["cluster"])
    result = run_level(lvl, seed=seed, policy=policy, kata=kata)
    metrics = scoring.metrics_from_run(result)
    out = {
        "level_id": lvl.get("id"),
        "seed": seed if seed is not None else int(lvl.get("seed", 0)),
        "policy": policy if kata is None else "kata",
        "nodes": _nodes_json(cluster),
        "jobs": _jobs_json(result),
        "end_time": result.end_time,
        "n_jobs": result.n_jobs,
        "node_seconds_busy": result.node_seconds_busy,
        "node_seconds_total": result.node_seconds_total,
        "metrics": metrics,
        "trajectory_hash": trajectory_hash(result),
    }
    score = _score_for(lvl, result)
    if score is not None:
        out["score"] = score
    if lvl.get("bars"):
        out["bars"] = lvl["bars"]
    return out


# --- interactive stepping (§4.1) ------------------------------------------------


def start(level: Any, seed: int | None = None, policy: str = "fifo",
          kata: Any | None = None) -> dict:
    """Start an interactive run and return a handle to step it."""
    lvl = _coerce_level(level)
    validate_level(lvl)
    sseed = seed if seed is not None else int(lvl.get("seed", 0))
    jobs = load_jobs(lvl, sseed)
    if kata is not None:
        from scheduler_dojo.kata import parse
        from scheduler_dojo.kata.policy import KataPolicy
        pol = KataPolicy(parse(_kata_source(kata)), unlocked=frozenset(lvl.get("unlocks", ["core"])))
    else:
        pol = POLICIES.get(policy, POLICIES["fifo"])
    sched = Scheduler(build_cluster(lvl["cluster"]), jobs, pol)
    handle = _NEXT_HANDLE[0]
    _NEXT_HANDLE[0] += 1
    _SESSIONS[handle] = sched
    return {"handle": handle, "state": _snapshot(sched)}


def _snapshot(sched: Scheduler) -> dict:
    return {
        "now": sched.now,
        "events_processed": sched._events_processed,
        "queued": sorted(sched.queued),
        "running": [{"id": j.id, "nodes": list(j.placed_nodes), "start": j.start_time}
                    for j in sorted(sched.running.values(), key=lambda j: j.id)],
        "finished": len(sched.finished),
        "done": bool(getattr(sched, "_finished", False)),
    }


def step_n(handle: int, n: int = 1) -> dict:
    sched = _SESSIONS[handle]
    finished = True if getattr(sched, "_finished", False) else sched.step_events(n)
    return {"state": _snapshot(sched), "done": finished}


def step_until(handle: int, t: int) -> dict:
    sched = _SESSIONS[handle]
    finished = True if getattr(sched, "_finished", False) else sched.run_until(t)
    return {"state": _snapshot(sched), "done": finished}


def step_result(handle: int) -> dict:
    """Finish the run (drain remaining events) and return the same payload as `run`."""
    sched = _SESSIONS.pop(handle, None)
    if sched is None:
        raise ValueError(f"no such stepping handle {handle}")
    result = sched.run(until=None) if not getattr(sched, "_finished", False) else sched._result()
    return {"metrics": scoring.metrics_from_run(result),
            "trajectory_hash": trajectory_hash(result),
            "jobs": _jobs_json(result), "end_time": result.end_time}


def check_kata(kata: Any) -> dict:
    from scheduler_dojo.kata.check import check

    src = _kata_source(kata)
    report = check(src)
    return {"ok": report.ok, "errors": report.errors}


# --- dispatch (the worker's `{id, call, args}` protocol) ------------------------


_DISPATCH = {
    "ping": ping, "version": version, "run": run, "start": start, "step_n": step_n,
    "step_until": step_until, "step_result": step_result, "check_kata": check_kata,
}


def dispatch(call: str, args: dict | list | None = None) -> dict:
    """Call a bridge function by name with positional (list) or keyword (dict) args.

    Wraps any exception into ``{"error": {"code": ..., "message": ...}}`` so a broken level or kata
    becomes a structured message the UI shows, never an uncaught throw across the WASM boundary.
    """
    fn = _DISPATCH.get(call)
    if fn is None:
        return {"error": {"code": "unknown_call", "message": f"no bridge call {call!r}"}}
    try:
        if isinstance(args, dict):
            result = fn(**args)
        elif isinstance(args, (list, tuple)):
            result = fn(*args)
        else:
            result = fn()
        return {"result": result}
    except Exception as exc:  # noqa: BLE001 - the WASM boundary must not raise
        code = getattr(exc, "code", type(exc).__name__)
        return {"error": {"code": code, "message": str(exc)}}
