"""Regressions for the Stage-1 adversarial-review fixes.

Each test reproduces a crash/hang/impossible-metric the adversarial reviewer found and asserts
the fixed behavior. See the Stage 1 session log and the Decision Log.
"""

from __future__ import annotations

import pytest

from scheduler_dojo.sim import Cluster, Node, Partition, Site, errors
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.scheduler import Scheduler, fifo, shortest_first
from scheduler_dojo.sim.trace import generate_jobs


def cluster(n=2):
    nodes = [Node(id=f"n{i}", name=f"n{i}", cpus=8, mem=8, gpus=0, partition_id="p")
             for i in range(n)]
    return Cluster([Site(id="s", name="s", partitions=[Partition(id="p", name="b", site_id="s",
                                                                 nodes=nodes)])])


# #1 — built-in policies must not crash on a job whose deps aren't done.
def test_deps_with_free_capacity_does_not_crash():
    c = cluster(2)
    jobs = [
        Job(id="j0", user="u", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=50),
        Job(id="j1", user="u", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=50,
            deps=("j0",)),
    ]
    res = Scheduler(c, jobs, fifo).run()  # must not raise PolicyError
    starts = {j.id: j.start_time for j in res.jobs}
    assert starts["j0"] == 0
    assert starts["j1"] is not None and starts["j1"] >= 50  # j1 waits for j0


def test_self_and_unknown_deps_do_not_crash():
    for deps in (("j1",), ("ghost",)):  # self-dep and unknown-id dep
        c = cluster(2)
        jobs = [Job(id="j1", user="u", submit_time=0, nodes_req=1, walltime_req=100,
                    actual_runtime=50, deps=deps)]
        res = Scheduler(c, jobs, shortest_first).run()
        assert res.jobs[0].start_time is None  # never placeable, but no crash


# #2 — placing a duplicated node list must be rejected (no double-booking, util <= 1).
def test_place_rejects_duplicate_nodes():
    c = cluster(1)
    job = Job(id="a", user="u", submit_time=0, nodes_req=2, walltime_req=100, actual_runtime=10)
    s = Scheduler(c, [job], lambda ctx: None)
    s.now = 0
    s.queued.add("a")
    with pytest.raises(errors.PolicyError) as e:
        s.place(job, ["n0", "n0"], 0)
    assert e.value.code == errors.MISMATCH


def test_job_requesting_zero_nodes_rejected():
    c = cluster(2)
    job = Job(id="a", user="u", submit_time=0, nodes_req=0, walltime_req=100, actual_runtime=10)
    s = Scheduler(c, [job], lambda ctx: None)
    s.now = 0
    s.queued.add("a")
    with pytest.raises(errors.PolicyError):
        s.place(job, None, 0)


# #4 — the horizon applies to the very first event batch too.
def test_until_respected_on_first_batch():
    c = cluster(1)
    jobs = [Job(id="a", user="u", submit_time=500, nodes_req=1, walltime_req=100,
                actual_runtime=100)]
    res = Scheduler(c, jobs, fifo).run(until=10)
    assert res.jobs[0].start_time is None
    assert res.end_time == 0  # nothing happened within the horizon


# #7 — duplicate job ids and duplicate node ids are rejected, not silently dropped.
def test_duplicate_job_ids_rejected():
    c = cluster(2)
    jobs = [Job(id="x", user="u", submit_time=0), Job(id="x", user="u", submit_time=1)]
    with pytest.raises(errors.DeterminismError):
        Scheduler(c, jobs, fifo)


def test_duplicate_node_ids_rejected():
    nodes = [Node(id="dup", name="a", cpus=1, mem=1, gpus=0, partition_id="p"),
             Node(id="dup", name="b", cpus=1, mem=1, gpus=0, partition_id="p")]
    with pytest.raises(ValueError):
        Cluster([Site(id="s", name="s",
                      partitions=[Partition(id="p", name="b", site_id="s", nodes=nodes)])])


# #8 — degenerate generator specs fail with a clear ValueError, not OverflowError/NaN crashes.
def test_trace_degenerate_specs_raise_value_error():
    bad_specs = [
        {"n_jobs": float("nan")},
        {"n_jobs": float("inf")},
        {"n_jobs": 10, "walltime": {"type": "lognormal", "median": float("nan"), "sigma": 0.5}},
        {"n_jobs": 10, "walltime": {"type": "lognormal", "median": 100, "sigma": float("inf")}},
        {"n_jobs": 10, "nodes": {"type": "discrete", "choices": [[1, 0.0], [2, 0.0]]}},
    ]
    for spec in bad_specs:
        with pytest.raises(ValueError):
            generate_jobs(spec, 1)


def test_trace_huge_sigma_is_bounded_not_overflowing():
    # A big-but-finite sigma must produce a huge (finite) walltime, not an OverflowError.
    jobs = generate_jobs({"n_jobs": 20, "walltime": {"type": "lognormal", "median": 1,
                                                     "sigma": 200}}, 3)
    assert all(j.walltime_req >= 1 for j in jobs)


# #9 — a Scheduler is single-use over its (mutable) Job/Cluster objects.
def test_rerun_guard():
    c = cluster(2)
    jobs = [Job(id=f"j{i}", user="u", submit_time=0, nodes_req=1, walltime_req=50,
                actual_runtime=20) for i in range(3)]
    s = Scheduler(c, jobs, fifo)
    s.run()
    with pytest.raises(errors.DeterminismError):
        s.run()
