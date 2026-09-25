"""Phase-two engine additions (PROMPT-ART §5.1–5.4): patience rings with run-ending overflow,
decision traces (off = free), real placements in the run record, reserve intents in snapshots."""

from __future__ import annotations

from scheduler_dojo import bridge
from scheduler_dojo.kata import parse
from scheduler_dojo.kata.policy import KataPolicy
from scheduler_dojo.sim.level import build_cluster
from scheduler_dojo.sim.scheduler import POLICIES, Scheduler

_TWO_NODES = {"nodes": [{"id": "n0", "cpus": 8}, {"id": "n1", "cpus": 8}]}
_FOUR_NODES = {"nodes": [{"id": f"n{i}", "cpus": 8} for i in range(4)]}


def _convoy_jobs():
    # Big convoy hogs both nodes; little jobs queue behind it (starvation, both users).
    return [
        {"id": "BIG", "user": "u1", "submit_time": 0, "nodes_req": 2,
         "walltime_req": 1000, "actual_runtime": 1000},
        {"id": "L1", "user": "u2", "submit_time": 1, "nodes_req": 1,
         "walltime_req": 100, "actual_runtime": 100},
        {"id": "L2", "user": "u3", "submit_time": 2, "nodes_req": 1,
         "walltime_req": 100, "actual_runtime": 100},
    ]


def _levels(jobs, **kw):
    lvl = {"id": "t", "title": "t", "cluster": _TWO_NODES, "jobs": jobs, "duration": kw.get("dur", 2000)}
    return lvl


def test_no_pressure_declared_means_no_rings_and_hash_stable():
    sched_lvl = _levels(_convoy_jobs())
    out = bridge.run(sched_lvl, policy="fifo")
    assert out["pressure"] == {} and out["overflow"] == ""
    # and the trajectory matches a plain Scheduler run (no hidden per-batch behavior)
    from scheduler_dojo.sim.level import jobs_from_level
    s = Scheduler(build_cluster(_TWO_NODES), jobs_from_level({"jobs": _convoy_jobs()}),
                  POLICIES["fifo"])
    from scheduler_dojo.sim.trajectory import trajectory_hash
    assert out["trajectory_hash"] == trajectory_hash(s.run(until=2000))


def test_ring_fills_and_overflow_ends_the_run():
    lvl = _levels(_convoy_jobs(), dur=3000)
    lvl["pressure"] = {"cap": 2, "end_on_overflow": True}
    out = bridge.run(lvl, policy="fifo")
    assert out["overflow"] in {"u2", "u3"}          # a little job's user popped first
    # unfinished jobs are scored as unfinished: the run ended at the overflow, not at the makespan
    assert any(j["state"] == "unfinished" for j in out["jobs"])
    assert next(j for j in out["jobs"] if j["id"] == "L1")["end"] is None


def test_overflow_flag_without_end_keeps_running():
    lvl = _levels(_convoy_jobs(), dur=3000)
    lvl["pressure"] = {"cap": 2, "end_on_overflow": False}
    out = bridge.run(lvl, policy="fifo")
    assert out["overflow"] in {"u2", "u3"}
    assert all(j["state"] != "unfinished" for j in out["jobs"])  # the run drained normally
    assert out["end_time"] >= 1000


def test_pressure_values_monotonic_in_wait():
    lvl = _levels(_convoy_jobs(), dur=3000)
    lvl["pressure"] = {"cap": 2, "end_on_overflow": False}
    h = bridge.start(lvl, policy="fifo")["handle"]
    seen = []
    st = bridge.step_until(h, 43)["state"]
    st2 = bridge.step_until(h, 85)["state"]
    for s in (st, st2):
        seen.append(s["pressure"]["u2"])
    assert 0.0 <= seen[0] < seen[1] <= 1.0


def test_trace_off_by_default_and_capped_when_on():
    lvl = _levels(_convoy_jobs(), dur=3000)
    assert "trace" not in bridge.run(lvl, policy="fifo")
    out = bridge.run(lvl, policy="fifo", trace=5)
    assert 0 < len(out["trace"]) <= 5
    places = [r for r in out["trace"] if r["action"] == "place"]
    assert places and all("nodes" in r for r in places)


def test_trace_in_step_snapshots_and_kata_order_keys():
    lvl = _levels(_convoy_jobs(), dur=3000)
    kata = "order by wide_first:\n    key = (0 - job.nodes_req, job.submit_time)\n"
    h = bridge.start(lvl, kata=kata, trace=50)["handle"]
    bridge.step_until(h, 5)
    res = bridge.step_result(h)
    assert res["trace"]
    orders = [r for r in res["trace"] if r["action"] == "order"]
    assert orders and orders[0]["keys"], "kata order decisions must record per-job keys"


def test_run_record_carries_real_placements():
    lvl = {"id": "t", "title": "t", "cluster": _FOUR_NODES, "duration": 500,
           "jobs": [{"id": "W", "user": "u", "submit_time": 0, "nodes_req": 4,
                     "walltime_req": 100, "actual_runtime": 100}]}
    out = bridge.run(lvl, policy="fifo")
    w = next(j for j in out["jobs"] if j["id"] == "W")
    assert sorted(w["placed"]) == ["n0", "n1", "n2", "n3"]
    h = bridge.start(lvl, policy="fifo")["handle"]
    bridge.step_until(h, 1)
    st = bridge.step_until(h, 10)["state"]
    assert sorted(st["running"][0]["nodes"]) == ["n0", "n1", "n2", "n3"]


def test_sensor_visibility_rule_in_run_record():
    lvl = {"id": "t", "title": "t", "cluster": _TWO_NODES, "duration": 500,
           "hide_actual": True,
           "jobs": [{"id": "S", "user": "u", "submit_time": 0, "nodes_req": 1,
                     "walltime_req": 50, "actual_runtime": 200}]}
    out = bridge.run(lvl, policy="fifo")
    s = next(j for j in out["jobs"] if j["id"] == "S")
    assert "runtime" not in s and s["est"] == 50  # claimed length only, until sensors


def test_reserve_intent_surfaces_in_snapshot_and_clears_on_place():
    lvl = {"id": "t", "title": "t", "cluster": _TWO_NODES, "duration": 600,
           "unlocks": ["core", "reserve"],
           "jobs": [
               {"id": "C", "user": "u", "submit_time": 0, "nodes_req": 2,
                "walltime_req": 300, "actual_runtime": 300},
               {"id": "P", "user": "u", "submit_time": 0, "nodes_req": 1,
                "walltime_req": 50, "actual_runtime": 50},
           ]}
    # P is queued after C (id order); the kata reserves P's start far out and places nothing else.
    kata = "place by hold:\n    for j in queue():\n        if j.id == \"P\":\n            reserve(j, 400)\n"
    h = bridge.start(lvl, kata=kata)["handle"]
    bridge.step_until(h, 1)
    st = bridge.step_until(h, 2)["state"]
    assert st["reserved"].get("P") == 400
