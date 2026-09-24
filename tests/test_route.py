"""Stage 8 multi-site routing: transfer-aware placement, site-restricted fit, the route builtin."""

from __future__ import annotations

import math

from scheduler_dojo.kata import parse
from scheduler_dojo.kata.policy import KataPolicy
from scheduler_dojo.sim import JobState
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.level import build_cluster
from scheduler_dojo.sim.scheduler import POLICIES, Scheduler

# Two sites: site-a {n0,n1}, site-b {n2,n3}, 8 cpus each.
_TWO_SITE = {"sites": [
    {"id": "a", "partitions": [{"id": "p", "nodes": [{"id": "n0", "cpus": 8}, {"id": "n1", "cpus": 8}]}]},
    {"id": "b", "partitions": [{"id": "q", "nodes": [{"id": "n2", "cpus": 8}, {"id": "n3", "cpus": 8}]}]},
]}


def _site_of(job):
    return job.placed_nodes and next(
        s for s in ("a", "b") if any(n in {"n0", "n1"} for n in job.placed_nodes) == (s == "a"))


def test_route_adds_transfer_and_picks_target_site():
    jobs = [Job("J", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=100,
                home_site="a", data_mb=50)]
    s = Scheduler(build_cluster(_TWO_SITE), jobs, POLICIES["fifo"], transfer_rate_mbs=10)
    s.route("J", "b", 0)
    s.run()
    j = s.by_id["J"]
    assert j.state is JobState.COMPLETED
    assert j.placed_nodes and j.placed_nodes[0] in ("n2", "n3")   # ran at site b
    assert j.runtime_used == 100 + 5                              # + ceil(50/10) transfer


def test_home_site_default_is_free():
    jobs = [Job("J", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=100,
                home_site="a", data_mb=50)]
    s = Scheduler(build_cluster(_TWO_SITE), jobs, POLICIES["fifo"], transfer_rate_mbs=10)
    s.run()  # no route call -> runs at home site a, no transfer
    j = s.by_id["J"]
    assert j.placed_nodes[0] in ("n0", "n1")
    assert j.runtime_used == 100


def test_route_builtin_when_unlocked():
    jobs = [Job("J", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=100,
                home_site="a", data_mb=50)]
    src = """
place by p:
  for j in queue():
    for st in sites():
      if transfer_cost(j, st) > 0:
        route(j, st)
    place(j)
"""
    p = KataPolicy(parse(src), unlocked=frozenset({"core", "route"}))
    s = Scheduler(build_cluster(_TWO_SITE), jobs, p, transfer_rate_mbs=10)
    s.run()
    assert p.last_fallback is None
    j = s.by_id["J"]
    assert j.placed_nodes[0] in ("n2", "n3") and j.runtime_used == 100 + 5


def test_route_builtin_gated_without_tier():
    jobs = [Job("J", "u", 0, nodes_req=1, walltime_req=100, actual_runtime=100,
                home_site="a", data_mb=50)]
    p = KataPolicy(parse("place by p:\n  route(first(queue()), first(sites()))\n"),
                   unlocked=frozenset({"core"}))
    Scheduler(build_cluster(_TWO_SITE), jobs, p).run()
    assert p.last_fallback == "slot_locked"


def test_transfer_secs_math():
    j = Job("J", "u", 0, home_site="a", data_mb=0)
    s = Scheduler(build_cluster(_TWO_SITE), [j], POLICIES["fifo"], transfer_rate_mbs=10)
    assert s.transfer_secs(j, "b") == 0                 # no data
    j.data_mb = 33
    assert s.transfer_secs(j, "b") == math.ceil(33 / 10)
    assert s.transfer_secs(j, "a") == 0                 # same site
    s.transfer_rate_mbs = 0
    assert s.transfer_secs(j, "b") == 0                 # rate 0 -> free


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
