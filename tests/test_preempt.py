"""Real preemption (Stage 8 primitive): preempt frees nodes and requeues, stale FINISH events are
ignored (no early finish), and the `preempt` builtin is gated by the preempt tier."""

from __future__ import annotations

from scheduler_dojo.kata import parse
from scheduler_dojo.kata.policy import KataPolicy
from scheduler_dojo.sim import JobState
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.level import build_cluster
from scheduler_dojo.sim.scheduler import POLICIES, Scheduler

_CLUSTER = {"nodes": [{"id": "n0", "cpus": 8}]}


def _ab_jobs():
    return [
        Job("A", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=10),
        Job("B", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=1),
    ]


def test_preempt_requeues_and_frees_node():
    sched = Scheduler(build_cluster(_CLUSTER), _ab_jobs(), POLICIES["fifo"])
    sched.now = 0
    sched.queued.update({"A", "B"})
    a = sched.by_id["A"]
    sched.place(a, None, 0)
    assert a.state is JobState.RUNNING
    assert not sched.cluster.node("n0").free_for(0, 1)

    sched.preempt(a, 0)
    assert a.state is JobState.QUEUED
    assert a.preempt_count == 1 and a.start_time is None and a.placed_nodes == ()
    assert sched.cluster.node("n0").free_for(0, 1)
    assert "A" in sched.queued and "A" not in sched.running


def test_preempt_stale_finish_ignored_during_run():
    # Place A via FIFO, advance mid-run, preempt it, drain — A must complete after a FULL 10s re-run,
    # never truncated early by the stale FINISH event from its preempted placement.
    sched = Scheduler(build_cluster(_CLUSTER), _ab_jobs(), POLICIES["fifo"])
    sched.run_until(5)  # FIFO places A at 0 (runs 0..10); B queued; stops at t=5
    assert sched.by_id["A"].state is JobState.RUNNING
    sched.preempt(sched.by_id["A"], 5)  # node freed from 5, A requeued, FINISH@10 stale
    sched.run()  # drain to completion
    by = {j.id: j for j in sched.jobs}
    assert by["A"].state is JobState.COMPLETED
    assert by["A"].runtime_used == 10  # a full re-run, not a truncated 5s
    assert by["A"].start_time >= 5


def test_preempt_builtin_gated_by_tier():
    # preempt is preempt-tier; core-only unlock -> slot_locked fallback (proves the gate).
    cluster = build_cluster(_CLUSTER)
    policy = KataPolicy(parse("place by x:\n    preempt(first(running()))\n"),
                        unlocked=frozenset({"core"}))
    Scheduler(cluster, _ab_jobs(), policy).run()
    assert policy.last_fallback == "slot_locked"


def test_preempt_builtin_reaches_engine_when_unlocked():
    # Unlocked preempt, driving a real running job: place A, advance mid-run, preempt A once, then
    # drain with plain FIFO. If preempt were still a stub, s2.run() would raise slot_locked.
    cluster = build_cluster(_CLUSTER)
    p = KataPolicy(parse("place by p:\n  if has_free_node():\n    place(first(queue()))\n"),
                   unlocked=frozenset({"core"}))
    s = Scheduler(cluster, _ab_jobs(), p)
    s.run_until(5)  # FIFO-ish kata places A at 0 (runs 0..10); B queued
    assert s.by_id["A"].state is JobState.RUNNING
    s.preempt(s.by_id["A"], 5)  # real Scheduler.preempt through the tier-unlocked primitive
    s.run()
    a = s.by_id["A"]
    assert a.preempt_count == 1 and a.state is JobState.COMPLETED and a.runtime_used == 10

    # And the kata builtin actually passes the tier gate when unlocked (nil preempt -> a *type*
    # fallback, not slot_locked — proving it reached the interpreter, not the locked stub).
    p_gate = KataPolicy(parse("place by x:\n  preempt(nil)\n"),
                        unlocked=frozenset({"core", "preempt"}))
    Scheduler(build_cluster(_CLUSTER), _ab_jobs(), p_gate).run()
    assert p_gate.last_fallback != "slot_locked"


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
