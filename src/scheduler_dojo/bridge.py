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
  ``step_n(handle, n)`` / ``step_until(handle, t)`` advance it and return a compact state diff
  (plus the last-N ``trace`` records when ``trace`` was enabled at ``start`` — the booth's
  why-panel reads them per step); ``step_result(handle)`` finalizes. This is the §4.1 stepping API
  for animated hand placement.
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
_SESSION_LEVELS: dict[int, dict] = {}  # stepped handle -> its level (for scoring step_result)
_NEXT_HANDLE = [1]


def _coerce_level(level: Any) -> dict:
    return json.loads(level) if isinstance(level, str) else level


def _tick_for(lvl: dict) -> int | None:
    """A level with patience rings ticks (rings fill between events); others never tick — which is
    exactly what keeps undeclared levels' trajectories byte-identical to phase one."""
    if lvl.get("pressure") is None:
        return None
    dur = int(lvl.get("duration") or 0)
    return max(1, dur // 70) if dur else 60


def _nodes_json(cluster: Cluster) -> list[dict]:
    parts = cluster.partitions
    return [{"id": n.id, "name": n.name, "cpus": n.cpus, "gpus": n.gpus,
             "partition": parts[n.partition_id].name if n.partition_id in parts else n.partition_id,
             "site": cluster.node_site(n.id)}
            for n in cluster.nodes]


def _jobs_json(result, sensors: bool = True) -> list[dict]:
    """Per-job run record. Phase two: `placed` carries the REAL node ids (+ `site`), and with
    sensors off the job's *claimed* walltime is all a viewer may see (same visibility rule the
    sensor builtin enforces mid-run): `runtime` is hidden and `est` carries the request."""
    out = []
    for j in result.jobs:
        state = "timeout" if j.timed_out else ("done" if j.completed else "unfinished")
        rec = {"id": j.id, "user": j.user, "nodes": j.nodes_req,
               "submit": j.submit_time, "start": j.start_time, "end": j.end_time,
               "state": state, "placed": list(j.placed_nodes), "site": j.run_site or "",
               "home": j.home_site or ""}
        if sensors:
            rec["runtime"] = j.runtime_used
        rec["est"] = j.walltime_req
        out.append(rec)
    return out


def _score_for(level: dict, result) -> int | None:
    w, a = level.get("score_weights"), level.get("score_anchors")
    return scoring.score(scoring.metrics_from_run(result), w, a) if (w and a) else None


def version() -> dict:
    return {"version": __version__, "python_ok": True}


def ping() -> dict:
    return {"ok": True, "version": __version__}


def run(level: Any, seed: int | None = None, policy: str = "fifo",
        kata: Any | None = None, trace: int = 0) -> dict:
    lvl = _coerce_level(level)
    validate_level(lvl)
    cluster = build_cluster(lvl["cluster"])
    sout: dict = {}
    result = run_level(lvl, seed=seed, policy=policy, kata=kata, trace=trace, sched_out=sout)
    sched = sout["sched"]
    metrics = scoring.metrics_from_run(result)
    out = {
        "level_id": lvl.get("id"),
        "seed": seed if seed is not None else int(lvl.get("seed", 0)),
        "policy": policy if kata is None else "kata",
        "nodes": _nodes_json(cluster),
        "jobs": _jobs_json(result, sensors=not lvl.get("hide_actual", False)),
        "end_time": result.end_time,
        "n_jobs": result.n_jobs,
        "node_seconds_busy": result.node_seconds_busy,
        "node_seconds_total": result.node_seconds_total,
        "metrics": metrics,
        "trajectory_hash": trajectory_hash(result),
        "pressure": dict(sched.pressure),
        "overflow": sched.overflow_user or "",
    }
    if trace:
        out["trace"] = list(sched.trace)
    score = _score_for(lvl, result)
    if score is not None:
        out["score"] = score
    if lvl.get("bars"):
        out["bars"] = lvl["bars"]
    return out


# --- interactive stepping (§4.1) ------------------------------------------------


def start(level: Any, seed: int | None = None, policy: str = "fifo",
          kata: Any | None = None, trace: int = 0) -> dict:
    """Start an interactive run and return a handle to step it."""
    lvl = _coerce_level(level)
    validate_level(lvl)
    sseed = seed if seed is not None else int(lvl.get("seed", 0))
    jobs = load_jobs(lvl, sseed)
    late: list = [None]
    tracer = (lambda a, j, f=None: late[0]._trace_event(a, j, f)) if trace else None
    if kata is not None:
        from scheduler_dojo.kata import parse
        from scheduler_dojo.kata.policy import KataPolicy
        pol = KataPolicy(parse(_kata_source(kata)),
                         unlocked=frozenset(lvl.get("unlocks", ["core"])), tracer=tracer)
    else:
        pol = POLICIES.get(policy, POLICIES["fifo"])  # built-ins trace via place() automatically
    sched = Scheduler(build_cluster(lvl["cluster"]), jobs, pol,
                      pressure=lvl.get("pressure"), tick=_tick_for(lvl), trace=trace,
                      horizon=lvl.get("duration"))
    late[0] = sched
    handle = _NEXT_HANDLE[0]
    _NEXT_HANDLE[0] += 1
    _SESSIONS[handle] = sched
    _SESSION_LEVELS[handle] = lvl
    return {"handle": handle, "state": _snapshot(sched, lvl), "nodes": _nodes_json(sched.cluster)}


def _snapshot(sched: Scheduler, lvl: dict | None = None) -> dict:
    sensors_visible = not (lvl or {}).get("hide_actual", False)
    # `placed_total`/`week` feed the tutorial's deterministic predicates (`placed_any`, `first_place`,
    # `week_end`, `after_days`); `week` is the engine calendar's (§5.6), 1-indexed like `day_week`.
    week = 1
    if lvl is not None:
        from scheduler_dojo.sim import calendar

        start = lvl.get("t0")
        if start is None:
            jobs = lvl.get("jobs") or []
            start = min((int(j.get("submit_time", 0)) for j in jobs), default=0)
        _, week = calendar.day_week(sched.now, start, int(lvl.get("duration") or 0))
    return {
        "now": sched.now,
        "placed_total": getattr(sched, "placed_total", 0),
        "week": week,
        # every job the viewer has never seen, minimal fields (submit/user/size) — the campus
        # draws the whole campus from first principles; the cost is O(never-seen jobs).
        "unseen": [{"id": j.id, "user": j.user, "nodes": j.nodes_req, "est": j.walltime_req,
                    "submit": j.submit_time, "state": "unseen"}
                   for j in sched.jobs if j.submit_time > sched.now],
        "events_processed": sched._events_processed,
        "queued": sorted(sched.queued),
        "running": [{"id": j.id, "nodes": list(j.placed_nodes), "start": j.start_time,
                     # Sensor visibility (§5.5): with `hide_actual` the run bar may only span the
                     # CLAIMED walltime — `actual_runtime` must not leak before any result does.
                     # `start_time` is checked for None, never truthiness: a 0-start is falsy (F5).
                     "end": (j.start_time if j.start_time is not None else sched.now) + (
                         max(1, min(j.walltime_req, j.actual_runtime)) if sensors_visible else
                         max(1, j.walltime_req)) + sched.transfer_secs(j)}
                    for j in sorted(sched.running.values(), key=lambda j: j.id)],
        "reserved": {jid: t for jid, t in sorted(sched.reservations.items())
                     if jid in sched.queued},
        "pressure": dict(sched.pressure),
        "overflow": sched.overflow_user or "",
        "finished": len(sched.finished),
        "done": sched.is_stopped(),
    }


def _step_out(sched: Scheduler, lvl: dict | None, finished: bool) -> dict:
    """One stepping result: the snapshot plus (only when tracing is on) the last-N decision
    records — the booth's why-panel reads them per step; a headless run pays nothing (§5.2)."""
    out = {"state": _snapshot(sched, lvl), "done": finished}
    if sched.trace:
        out["trace"] = list(sched.trace)
    return out


def step_n(handle: int, n: int = 1) -> dict:
    sched = _SESSIONS[handle]
    finished = True if getattr(sched, "_finished", False) else sched.step_events(n)
    return _step_out(sched, _SESSION_LEVELS.get(handle), finished)


def step_until(handle: int, t: int) -> dict:
    sched = _SESSIONS[handle]
    finished = True if getattr(sched, "_finished", False) else sched.run_until(t)
    return _step_out(sched, _SESSION_LEVELS.get(handle), finished)


def step_result(handle: int) -> dict:
    """Finish the run (drain remaining events) and return the same payload as `run` — including
    the engine-computed `score`/`bars` (so no client ever mirrors `scoring.score`)."""
    sched = _SESSIONS.pop(handle, None)
    if sched is None:
        raise ValueError(f"no such stepping handle {handle}")
    lvl = _SESSION_LEVELS.pop(handle, {})
    finished = sched.is_stopped()
    # Drain *to the horizon* (`run` stops at t0+horizon), never past it — events scheduled beyond
    # the week (jobs still running at week end are the point) must not be processed, or a stepped
    # run would gain trajectory entries a canonical `run` truncates and the hashes would diverge.
    result = sched.run(until=None) if not finished else sched._result()
    # (horizon is enforced inside `run`; see scheduler.run)
    out = {"metrics": scoring.metrics_from_run(result),
           "trajectory_hash": trajectory_hash(result),
           "jobs": _jobs_json(result, sensors=not lvl.get("hide_actual", False)),
           "end_time": result.end_time,
           "pressure": dict(sched.pressure), "overflow": sched.overflow_user or "",
           "trace": list(sched.trace)}
    if lvl:
        out["seed"] = int(lvl.get("seed", 0))
        out["policy"] = str(lvl.get("default_policy", "fifo"))
    score = _score_for(lvl, result) if lvl else None
    if score is not None:
        out["score"] = score
    if lvl.get("bars"):
        out["bars"] = lvl["bars"]
    return out


def check_kata(kata: Any) -> dict:
    from scheduler_dojo.kata.check import check

    src = _kata_source(kata)
    report = check(src)
    return {"ok": report.ok, "errors": report.errors}


# --- hand placement (§ stage 5: levels 1-2 are played by hand) ------------------


def hand_start(level: Any, seed: int | None = None) -> dict:
    """Start a *manual* run: nothing auto-places; the player places jobs via `hand_place`/`hand_tick`.

    The scheduler runs under a manual policy (a no-op), so a decision never places unless the player
    does — the engine still validates every action. The `suggestions` field shows what FIFO would do
    (a hint the UI can optionally show).
    """
    lvl = _coerce_level(level)
    validate_level(lvl)
    sseed = seed if seed is not None else int(lvl.get("seed", 0))
    jobs = load_jobs(lvl, sseed)
    sched = Scheduler(build_cluster(lvl["cluster"]), jobs, _manual,
                      pressure=lvl.get("pressure"), tick=_tick_for(lvl),
                      horizon=lvl.get("duration"))
    handle = _NEXT_HANDLE[0]
    _NEXT_HANDLE[0] += 1
    _SESSIONS[handle] = sched
    sched.step_events(1)  # process the t=min-submit arrivals so there is a queue to act on
    return {"handle": handle, "state": _snapshot(sched, lvl),
            "suggestions": _suggestions(sched), "nodes": _nodes_json(sched.cluster)}


def _manual(ctx) -> None:
    """Manual policy: place nothing automatically (the player drives placement via the bridge)."""
    return None


def _suggestions(sched: Scheduler) -> dict:
    """What FIFO *would* place now (job id -> node ids) — a read-only hint, it never mutates state.

    Uses `Cluster.first_fit` at `sched.now` (no allocation) and tracks claimed nodes so the hint does
    not double-book the same node across two jobs.
    """
    from scheduler_dojo.sim.scheduler import PolicyContext, runtime_used

    ctx = PolicyContext(sched)
    cluster = sched.cluster
    claimed: set[str] = set()
    out: dict[str, list[str]] = {}
    if not ctx.has_free_node():
        return out
    for job in sorted(ctx.queued, key=lambda j: (j.submit_time, j.id)):
        if not ctx._deps_done(job):
            continue
        fit = cluster.first_fit(job.nodes_req, sched.now, runtime_used(job),
                                partition=job.partition, cpus=job.cpus_req, mem=job.mem_req,
                                gpus=job.gpus_req, tags=job.tags)
        if fit is None:
            continue
        ids = [n.id for n in fit]
        if any(nid in claimed for nid in ids):
            continue
        for nid in ids:
            claimed.add(nid)
        out[job.id] = ids
    return out


def hand_place(handle: int, job_id: str, nodes: list[str] | None = None) -> dict:
    """Place one job by hand at the current time; the engine validates and either runs it or errors."""
    sched = _SESSIONS[handle]
    from scheduler_dojo.sim.scheduler import PolicyContext

    try:
        ctx = PolicyContext(sched)
        ctx.place(job_id, nodes)
        return {"ok": True, "state": _snapshot(sched, _SESSION_LEVELS.get(handle))}
    except Exception as exc:  # surface the teaching error to the UI, keep the run alive
        code = getattr(exc, "code", type(exc).__name__)
        return {"ok": False, "error": {"code": code, "message": str(exc)},
                "state": _snapshot(sched, _SESSION_LEVELS.get(handle))}


def hand_tick(handle: int, until: int | None = None) -> dict:
    """Advance the manual run's clock to the next arrival/finish (or to `until`) without placing.

    Returns the new state plus `suggestions`. Placement decisions made since the last tick stand."""
    sched = _SESSIONS[handle]
    if until is None:
        sched.step_events(1)  # one timestamp batch (arrivals/frees), manual policy places nothing
    else:
        sched.run_until(until)
    return {"state": _snapshot(sched, _SESSION_LEVELS.get(handle)), "suggestions": _suggestions(sched),
            "done": bool(getattr(sched, "_finished", False))}


def hand_result(handle: int) -> dict:
    """Finish the manual run and return metrics/score/hash (identical determinism to any run)."""
    return step_result(handle)


# --- progression (Stage 7: belts, credits, upgrades, offline drift) ------------


def progression_view(state: dict | None = None, *, now: int = 0) -> dict:
    """A read-only snapshot for the HUD: belt, next belt, credits, upgrades + what is buyable."""
    from scheduler_dojo import progression as prog

    st = prog._migrate(state if state is not None else prog.new_state(now=now))
    return {
        "belt": prog.belt(st.get("lifetime", st.get("credits", 0))),
        "next_belt": list(prog.next_belt(st.get("lifetime", 0))) if prog.next_belt(st.get("lifetime", 0)) else None,
        "credits": st.get("credits", 0),
        "lifetime": st.get("lifetime", 0),
        "unlocked": sorted(prog.unlocked_tiers(st)),
        "upgrades": {uid: {**u, "owned": uid in st.get("upgrades", []),
                           "buyable": prog.can_buy(st, uid)}
                     for uid, u in prog.UPGRADES.items()},
    }


def _ensure_state(state: dict | None):
    from scheduler_dojo import progression as prog

    return prog._migrate(state if state is not None else prog.new_state())


def progression_completion(state: dict, level_id: str, score: int, *, seed: int) -> dict:
    from scheduler_dojo import progression as prog

    return prog.apply_completion(_ensure_state(state), level_id, score, seed=seed)


def progression_buy(state: dict, upgrade_id: str) -> dict:
    from scheduler_dojo import progression as prog

    return prog.buy(_ensure_state(state), upgrade_id)


def progression_drift(state: dict, *, now: int) -> dict:
    from scheduler_dojo import progression as prog

    return prog.apply_drift(_ensure_state(state), now=now)


# --- phase two: calendar, weekly offers, city editions, endless -------------------


def watch_plan(level: Any) -> dict:
    """Pacing facts the campus renderer asks the engine for: the sim-step between snapshots and
    the sun-cycle stride. One source, so CLI and browser animate the same run identically (§5.6)."""
    from scheduler_dojo.sim import calendar

    lvl = _coerce_level(level)
    duration = int(lvl.get("duration") or 0)
    return {"step": max(1, duration // 2400), "tick": _tick_for(lvl),
            "stride": calendar._stride(duration, calendar.WEEK_DAYS),
            "duration": duration}


def calendar_at(t: int, level: Any, t0: int | None = None) -> dict:
    """Day/week/sun position of sim time `t` for a level — computed in the engine so the CLI
    and the browser agree exactly on when a week ends (§5.6)."""
    from scheduler_dojo.sim import calendar

    lvl = _coerce_level(level)
    start = t0 if t0 is not None else lvl.get("t0")
    if start is None:
        jobs = lvl.get("jobs") or []
        start = min((int(j.get("submit_time", 0)) for j in jobs), default=0)
    duration = int(lvl.get("duration") or 0)
    day, week = calendar.day_week(int(t), int(start), duration)
    _, frac = calendar.day_clock(int(t), int(start), duration)
    return {"day": day, "week": week, "sun": frac,
            "week_end": calendar.week_end_time(int(start), duration, week)}


def offers_list(state: dict, city: int, week: int) -> dict:
    """The deterministic two upgrades offered at a city/week boundary (share-replayable)."""
    from scheduler_dojo import progression as prog

    return {"offers": prog.offers(_ensure_state(state), int(city), int(week))}


def tutorial_load(city: str = "city1") -> dict:
    """A city tutorial script (data), for the tutorial runner."""
    from scheduler_dojo.sim.tutorial import load_tutorial

    return {"tutorial": load_tutorial(city)}


def tutorial_run(ref: str = "city1", policy: str = "fifo", kata: Any | None = None,
                trace: int = 0) -> dict:
    """Run a city's *edition* of its canonical level (level + whitelisted patch). Calibration,
    goldens and share cards still refer to the canonical level; the patch changes only pacing knobs."""
    from scheduler_dojo.sim.tutorial import load_city_level

    return run(load_city_level(ref), policy=policy, kata=kata, trace=trace)


def endless_run(growth: dict, seed: int = 0, policy: str = "fifo",
                kata: Any | None = None, trace: int = 0) -> dict:
    """Run seeded endless growth (§5.7) as an inline level; the same seed replays identically."""
    from scheduler_dojo.sim.endless import DEFAULT_HORIZON, generate_endless_jobs

    jobs = generate_endless_jobs(int(seed), growth)
    # One lookup, matching `generate_endless_jobs`: `horizon` nests under "growth" (the ramp);
    # a top-level one is accepted as a deprecated alias so a client cannot half-wedge the worker.
    horizon = int((growth.get("growth") or {}).get("horizon",
                                                   growth.get("horizon", DEFAULT_HORIZON)))
    nodes = growth.get("cluster", {"nodes": [{"id": f"e{i}", "cpus": 8} for i in range(4)]})
    lvl = {"id": "endless", "title": "Endless", "cluster": nodes,
           "jobs": [{"id": j.id, "user": j.user, "submit_time": j.submit_time,
                     "nodes_req": j.nodes_req, "walltime_req": j.walltime_req,
                     "actual_runtime": j.actual_runtime}
                    for j in jobs],
           "duration": horizon,
           "pressure": growth.get("pressure", {"cap": 2, "end_on_overflow": True})}
    return run(lvl, seed=seed, policy=policy, kata=kata, trace=trace)


# --- share cards (Stage 9: mint + verify a replayable, tamper-evident card) ------


def share_encode(level: Any, seed: int | None = None, policy: str = "fifo",
                 kata: Any | None = None, level_id: str | None = None) -> dict:
    """Run then mint a share card. Pass the inline `level` dict (a sandbox run) or a `level_id`
    (a shipped puzzle the browser already has). Returns {payload, hash} — the payload is the URL."""
    from scheduler_dojo.share.card import encode_card

    if level is not None:
        lvl = _coerce_level(level)
        result = run_level(lvl, seed=seed, policy=policy, kata=kata)
        sid = seed if seed is not None else int(lvl.get("seed", 0))
        payload = encode_card(level=lvl, seed=sid, policy=policy, kata=kata, result=result)
    else:
        payload = encode_card(level_id=level_id, seed=int(seed or 0), policy=policy, kata=kata)
    from scheduler_dojo.share.card import decode_card

    return {"payload": payload, "hash": decode_card(payload).get("hash")}


def share_replay(payload: str, level: Any | None = None) -> dict:
    """Replay a card payload and check its hash. `level` is required only for a level_id card."""
    from scheduler_dojo.share.card import replay_card

    return replay_card(payload, level=_coerce_level(level) if level is not None else None)



# --- dispatch (the worker's `{id, call, args}` protocol) ------------------------


_DISPATCH = {
    "ping": ping, "version": version, "run": run, "start": start, "step_n": step_n,
    "step_until": step_until, "step_result": step_result, "check_kata": check_kata,
    "hand_start": hand_start, "hand_place": hand_place, "hand_tick": hand_tick,
    "hand_result": hand_result,
    "progression_view": progression_view, "progression_completion": progression_completion,
    "progression_buy": progression_buy, "progression_drift": progression_drift,
    "calendar_at": calendar_at, "watch_plan": watch_plan,
    "offers_list": offers_list,
    "tutorial_load": tutorial_load, "tutorial_run": tutorial_run, "endless_run": endless_run,
    "share_encode": share_encode, "share_replay": share_replay,
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
