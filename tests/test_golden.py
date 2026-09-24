"""Golden-trajectory and performance acceptance tests for Stage 1.

Goldens are regenerated only by scripts/gen_goldens.py and reviewed in the diff (quality bar).
This test never writes a golden; it asserts the committed goldens still match a fresh run, and
that determinism and the 10k-job wall-time budget hold.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from scheduler_dojo.sim.level import load_level_file, run_level
from scheduler_dojo.sim.trace import generate_jobs
from scheduler_dojo.sim.trajectory import trajectory_hash

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "levels" / "fixture.json"
GOLDEN = ROOT / "tests" / "goldens" / "stage1.json"

SEEDS = [1, 2, 3]
POLICIES = ["fifo", "shortest_first"]


@pytest.fixture(scope="module")
def level():
    return load_level_file(FIXTURE)


def test_goldens_exist():
    assert GOLDEN.exists(), "run scripts/gen_goldens.py to create goldens"


def test_golden_trajectories_match(level):
    gold = json.loads(GOLDEN.read_text())
    for seed in SEEDS:
        for policy in POLICIES:
            res = run_level(level, seed=seed, policy=policy)
            key = f"{seed}:{policy}"
            assert key in gold, f"golden missing {key}"
            assert trajectory_hash(res) == gold[key]["trajectory_hash"], (
                f"trajectory drift on {key}; regenerate with scripts/gen_goldens.py")
            assert res.end_time == gold[key]["end_time"]
            assert res.node_seconds_busy == gold[key]["node_seconds_busy"]


def test_fifo_differs_from_shortest_first(level):
    # The two policies must actually produce different trajectories (sanity on the fixture).
    fifo_hash = trajectory_hash(run_level(level, seed=1, policy="fifo"))
    sf_hash = trajectory_hash(run_level(level, seed=1, policy="shortest_first"))
    assert fifo_hash != sf_hash


def test_same_seed_deterministic_across_reruns(level):
    a = trajectory_hash(run_level(level, seed=7, policy="fifo"))
    b = trajectory_hash(run_level(level, seed=7, policy="fifo"))
    assert a == b


def test_10k_jobs_under_5s():
    # A *provisioned* load (util < 1), which is what real levels are: an over-subscribed
    # cluster is not a schedulable scenario (unbounded backlog, infinite slowdown).
    spec = {
        "n_jobs": 10000,
        "users": [{"name": f"u{i}", "weight": 1.0} for i in range(8)],
        "arrival": {"type": "poisson", "rate_per_hour": 300},
        "nodes": {"type": "discrete", "choices": [[1, 0.9], [2, 0.08], [4, 0.02]]},
        "walltime": {"type": "lognormal", "median": 1800, "sigma": 0.6},
        "runtime_ratio": {"type": "lognormal", "median": 0.5, "sigma": 0.7},
    }
    level = {
        "id": "perf",
        "title": "10k perf",
        "cluster": {"nodes": [{"id": f"n{i}", "cpus": 64, "mem": 128} for i in range(256)]},
        "generator": spec,
    }
    t0 = time.perf_counter()
    res = run_level(level, seed=99, policy="fifo")
    dt = time.perf_counter() - t0
    assert res.n_jobs == 10000
    assert dt < 5.0, f"10k-job run took {dt:.2f}s"


def test_trace_generator_deterministic_in_sim():
    # Independent of goldens: the generator itself is deterministic given a seed.
    spec = {"n_jobs": 50, "arrival": {"type": "poisson", "rate_per_hour": 100},
            "walltime": {"type": "lognormal", "median": 600, "sigma": 0.5}}
    a = [(j.id, j.submit_time, j.actual_runtime) for j in generate_jobs(spec, 42)]
    b = [(j.id, j.submit_time, j.actual_runtime) for j in generate_jobs(spec, 42)]
    assert a == b
