"""Cross-cutting determinism invariants, added after Stage-1 review.

These lock the two invariants a reviewer flagged as fragile (cluster build-order and trace
submit monotonicity) so they can never silently regress. See Concepts/Determinism.md.
"""

from __future__ import annotations

import random

from scheduler_dojo.sim import Cluster, Node, Partition, Site
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.level import build_cluster
from scheduler_dojo.sim.scheduler import fifo, shortest_first, Scheduler
from scheduler_dojo.sim.trace import generate_jobs
from scheduler_dojo.sim.trajectory import trajectory_hash


def _cluster(order: list[str], multi_partition: bool) -> Cluster:
    parts = []
    for idx, nid in enumerate(order):
        pid = f"p{idx}" if multi_partition else "p"
        name = f"part{idx}" if multi_partition else "batch"
        node = Node(id=nid, name=nid, cpus=1, mem=1, gpus=0, partition_id=pid)
        parts.append(Partition(id=pid, name=name, site_id="s", nodes=[node]))
    return Cluster([Site(id="s", name="s", partitions=parts)])


def _jobs(n: int, partitioned: bool) -> list[Job]:
    return [
        Job(id=f"j{i}", user="u", submit_time=i % 3, walltime_req=100, actual_runtime=50,
            partition=(f"part{i % 8}" if partitioned else None))
        for i in range(n)
    ]


def test_cluster_build_order_never_affects_trajectory():
    ids = [f"n{i}" for i in range(8)]
    for multi in (False, True):
        hashes = set()
        for trial in range(12):
            order = ids[:]
            random.Random(trial).shuffle(order)
            res = Scheduler(_cluster(order, multi), _jobs(16, multi), fifo).run()
            hashes.add(trajectory_hash(res))
        assert len(hashes) == 1, f"build order leaked into trajectory (multi={multi})"


def test_json_and_hand_built_clusters_agree():
    order = ["n3", "n0", "n5", "n1", "n4", "n2"]
    level = {"cluster": {"nodes": [{"id": i, "cpus": 1, "mem": 1} for i in order]}}
    from_json = build_cluster(level["cluster"])
    from_hand = _cluster(order, multi_partition=False)
    hj = trajectory_hash(Scheduler(from_json, _jobs(12, False), fifo).run())
    hh = trajectory_hash(Scheduler(from_hand, _jobs(12, False), fifo).run())
    assert hj == hh


def test_trace_submit_times_monotonic_across_specs():
    # High arrival rates round overlapping submit times; output must still be nondecreasing
    # and ids must be assigned in arrival order.
    specs = [
        {"n_jobs": 2000, "arrival": {"type": "poisson", "rate_per_hour": 5000},
         "walltime": {"type": "fixed", "value": 300}},
        {"n_jobs": 1500, "arrival": {"type": "uniform", "first": 500, "last": 100},  # reversed
         "walltime": {"type": "fixed", "value": 300}},
        {"n_jobs": 800, "arrival": {"type": "poisson", "rate_per_hour": 2000},
         "walltime": {"type": "lognormal", "median": 120, "sigma": 0.9}},
    ]
    for spec in specs:
        for seed in (0, 7, 13):
            jobs = generate_jobs(spec, seed)
            subs = [j.submit_time for j in jobs]
            assert all(b >= a for a, b in zip(subs, subs[1:])), "submit times regressed"
            ids = [j.id for j in jobs]
            assert ids == sorted(ids), "ids not monotonic with arrival order"
