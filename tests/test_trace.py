"""Tests for the synthetic trace generator: determinism, ordering, distribution sanity."""

from __future__ import annotations

import hashlib
import json
from collections import Counter

from scheduler_dojo.sim.cluster import Cluster, Node, Partition, Site
from scheduler_dojo.sim.scheduler import Scheduler, fifo
from scheduler_dojo.sim.trace import generate_jobs, import_sacct_csv, poisson_jobs

FIELDS = ("id", "submit_time", "user", "nodes_req", "walltime_req", "actual_runtime")


def _cluster(nodes: int = 16) -> Cluster:
    """A fresh one-partition cluster (Scheduler mutates node occupancy, so build it per run)."""
    ns = [Node(id=f"n{k}", name=f"n{k}", cpus=8, mem=0, gpus=0, partition_id="p")
          for k in range(nodes)]
    return Cluster([Site(id="s", name="s",
                         partitions=[Partition(id="p", name="p", site_id="s", nodes=ns)])])


def tuples(jobs) -> list[tuple]:
    return [tuple(getattr(j, f) for f in FIELDS) for j in jobs]


SPEC = {
    "n_jobs": 300,
    "users": [{"name": "alice", "weight": 0.5}, {"name": "bob", "weight": 0.3},
              {"name": "carol", "weight": 0.2}],
    "arrival": {"type": "poisson", "rate_per_hour": 40},
    "nodes": {"type": "discrete", "choices": [[1, 0.7], [2, 0.2], [4, 0.1]]},
    "walltime": {"type": "lognormal", "median": 1800, "sigma": 0.5},
    "runtime_ratio": {"type": "lognormal", "median": 0.5, "sigma": 0.5},
}


def test_same_seed_yields_identical_jobs():
    assert tuples(generate_jobs(SPEC, 42)) == tuples(generate_jobs(SPEC, 42))


def test_different_seeds_differ():
    a, b = tuples(generate_jobs(SPEC, 1)), tuples(generate_jobs(SPEC, 2))
    assert len(a) == len(b)
    assert a != b


def test_ids_unique_sorted_and_monotonic_submit_times():
    jobs = generate_jobs(SPEC, 7)
    ids = [j.id for j in jobs]
    assert len(set(ids)) == len(ids) == 300
    assert ids == sorted(ids)
    assert ids[0] == "j000000" and ids[-1] == "j000299"
    submits = [j.submit_time for j in jobs]
    assert submits == sorted(submits)  # nondecreasing
    assert all(isinstance(s, int) and s >= 0 for s in submits)
    assert all(j.nodes_req >= 1 and j.walltime_req >= 1 and j.actual_runtime >= 1 for j in jobs)


def test_uniform_arrival_spans_the_window():
    jobs = generate_jobs(
        {"n_jobs": 50, "arrival": {"type": "uniform", "first": 100, "last": 10_000}}, 3)
    assert jobs[0].submit_time == 100
    assert jobs[-1].submit_time == 10_000
    assert all(100 <= j.submit_time <= 10_000 for j in jobs)


def test_nodes_distribution_matches_probs():
    spec = dict(SPEC, n_jobs=5000,
                nodes={"type": "discrete", "choices": [[1, 0.7], [2, 0.2], [8, 0.1]]})
    counts = Counter(j.nodes_req for j in generate_jobs(spec, 11))
    n = 5000
    assert abs(counts[1] / n - 0.70) < 0.03
    assert abs(counts[2] / n - 0.20) < 0.02
    assert abs(counts[8] / n - 0.10) < 0.02


def test_nodes_probs_need_not_sum_to_one():
    spec = {"n_jobs": 2000, "nodes": {"type": "discrete", "choices": [[1, 3.0], [4, 1.0]]}}
    counts = Counter(j.nodes_req for j in generate_jobs(spec, 5))
    assert abs(counts[1] / 2000 - 0.75) < 0.03


def test_walltime_fixed_is_exact_and_lognormal_mean_is_close():
    e = 2.718281828459045  # literal, not math.exp (unavailable under Pyodide)

    fixed = generate_jobs({"n_jobs": 100, "walltime": {"type": "fixed", "value": 7200}}, 9)
    assert all(j.walltime_req == 7200 for j in fixed)

    logn = generate_jobs(
        {"n_jobs": 5000, "walltime": {"type": "lognormal", "median": 1800, "sigma": 0.4}}, 13)
    expected = 1800 * (e ** (0.4**2 / 2))  # mean of a lognormal given its median
    mean = sum(j.walltime_req for j in logn) / len(logn)
    assert abs(mean - expected) / expected < 0.15
    assert min(j.walltime_req for j in logn) >= 1


def test_runtime_ratio_lies_model_and_fixed_ratio():
    honest = generate_jobs(
        {"n_jobs": 200, "walltime": {"type": "fixed", "value": 1000},
         "runtime_ratio": {"type": "fixed", "value": 1.0}}, 4)
    assert all(j.actual_runtime == 1000 for j in honest)

    lying = generate_jobs(
        {"n_jobs": 2000, "walltime": {"type": "fixed", "value": 1000},
         "runtime_ratio": {"type": "lognormal", "median": 0.5, "sigma": 0.8}}, 6)
    overruns = sum(1 for j in lying if j.actual_runtime > j.walltime_req)
    assert 0.05 < overruns / len(lying) < 0.45  # some but not most jobs blow past the cap


def test_user_mix_matches_weights():
    spec = dict(SPEC, n_jobs=5000)
    counts = Counter(j.user for j in generate_jobs(spec, 21))
    for name, weight in (("alice", 0.5), ("bob", 0.3), ("carol", 0.2)):
        assert abs(counts[name] / 5000 - weight) < 0.02


def test_defaults_and_edge_cases():
    assert len(generate_jobs({}, 1)) == 100  # n_jobs default
    assert generate_jobs({"n_jobs": 0}, 1) == []
    assert generate_jobs({"n_jobs": 0, "arrival": {"type": "uniform", "first": 0,
                                                  "last": 100}}, 1) == []
    assert generate_jobs({"n_jobs": 1}, 1)[0].user == "user0"


def test_horizon_derives_and_caps_the_job_count():
    # 2 hours at 30/hour -> ~60 arrivals, none past the horizon.
    jobs = generate_jobs({"arrival": {"type": "poisson", "rate_per_hour": 30}}, 8,
                         horizon=7200)
    assert 0 < len(jobs) <= 75
    assert jobs[-1].submit_time <= 7200
    # An explicit n_jobs is capped by the horizon too.
    capped = generate_jobs({"n_jobs": 200}, 8, horizon=600)
    assert capped and capped[-1].submit_time <= 600
    assert len(capped) < 200


def test_jobs_feed_the_scheduler():
    jobs = poisson_jobs(3, n_jobs=40)
    result = Scheduler(_cluster(8), jobs, fifo).run()
    assert result.n_jobs == 40
    assert all(r.completed for r in result.jobs)


def test_poisson_jobs_wrapper_is_deterministic():
    users = [{"name": "u1", "weight": 1.0}, {"name": "u2", "weight": 1.0}]
    assert tuples(poisson_jobs(42)) == tuples(poisson_jobs(42))
    assert tuples(poisson_jobs(42, n_jobs=50, rate_per_hour=5, median_walltime=600,
                              users=users)) == tuples(
        poisson_jobs(42, n_jobs=50, rate_per_hour=5, median_walltime=600, users=users))
    assert len(poisson_jobs(1, n_jobs=10)) == 10


def test_every_seed_produces_a_valid_schedule():
    # Literal seeds only (no wall-clock-derived seeds): a run either raises or returns a schedule.
    for seed in range(10):
        jobs = poisson_jobs(seed, n_jobs=30, rate_per_hour=100)
        assert len({j.id for j in jobs}) == 30
        result = Scheduler(_cluster(), jobs, fifo).run()
        assert result.n_jobs == 30
        assert all(r.completed for r in result.jobs)
        assert all(r.start_time is not None and r.start_time >= r.submit_time
                   for r in result.jobs)


# --- golden trajectory (regenerate with a script only, never by loosening this test) ---
GOLDEN_SEED = 20260810
GOLDEN_HASH = "14f2384f044fbdddc31d2e457db86da717a092dcd00219faa78a94c1941093cc"


def run_poisson_seed(seed: int) -> list[tuple]:
    """FIFO over a poisson trace: per-job trajectory rows in stable job-id order (hash input)."""
    result = Scheduler(_cluster(), poisson_jobs(seed, n_jobs=40, rate_per_hour=30), fifo).run()
    return [
        (r.id, r.submit_time, r.start_time, r.end_time, r.nodes_req, r.walltime_req,
         r.actual_runtime, r.wait, r.timed_out, r.completed)
        for r in result.jobs
    ]


def test_poisson_schedule_golden():
    rows = run_poisson_seed(GOLDEN_SEED)
    assert len(rows) == 40
    assert rows == run_poisson_seed(GOLDEN_SEED)  # same seed, same process
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    assert digest == GOLDEN_HASH


def test_bad_spec_raises_before_any_draw():
    # NaN/inf/unknown kinds are rejected with a clear ValueError, not a downstream crash.
    import math

    bad = [
        {"n_jobs": 5, "arrival": {"type": "step"}},
        {"n_jobs": 5, "arrival": {"rate_per_hour": math.inf}},
        {"n_jobs": 5, "arrival": {"rate_per_hour": -1}},
        {"n_jobs": math.nan},
        {"n_jobs": 5, "users": [{"name": "a", "weight": math.nan}]},
        {"n_jobs": 5, "users": [{"name": "a", "weight": 0}]},
        {"n_jobs": 5, "nodes": {"type": "discrete", "choices": []}},
        {"n_jobs": 5, "nodes": {"type": "discrete", "choices": [[1, math.inf]]}},
        {"n_jobs": 5, "nodes": {"type": "discrete", "choices": [[1, -0.5]]}},
        {"n_jobs": 5, "nodes": {"type": "discrete", "choices": [[1, 0.0]]}},
        {"n_jobs": 5, "nodes": {"type": "normal", "value": 2}},
        {"n_jobs": 5, "walltime": {"type": "lognormal", "median": math.inf}},
        {"n_jobs": 5, "walltime": {"type": "lognormal", "median": 0}},
        {"n_jobs": 5, "walltime": {"type": "lognormal", "median": 60, "sigma": float("nan")}},
        {"n_jobs": 5, "walltime": {"type": "uniform"}},
        {"n_jobs": 5, "runtime_ratio": {"type": "lognormal", "median": math.nan}},
        {"n_jobs": 5, "runtime_ratio": {"type": "uniform"}},
    ]
    for spec in bad:
        try:
            generate_jobs(spec, 1)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {spec}")


def test_sacct_import_reads_a_real_file():
    # Stage 8 shipped: a real CSV imports; a missing file is an OSError (no longer a stub).
    from pathlib import Path
    csv = str(Path(__file__).parent / "data" / "sample_sacct.csv")
    assert len(import_sacct_csv(csv)) == 5
    try:
        import_sacct_csv("definitely-missing.csv")
    except OSError:
        pass
    else:
        raise AssertionError("missing file should raise OSError")
