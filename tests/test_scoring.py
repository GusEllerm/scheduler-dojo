"""Hand-computed checks for every raw metric and the 0..1000 score.

Every expected value below is computed by hand in the comment above the assertion — these are
the numbers a vault note cites, so they are not derived from the code.
"""

from __future__ import annotations

import math

import pytest

from scheduler_dojo.sim import (
    Cluster,
    Job,
    JobResult,
    JobState,
    Node,
    Partition,
    RunResult,
    Scheduler,
    Site,
    fifo,
)
from scheduler_dojo.sim.scoring import (
    bounded_slowdown,
    fairness,
    metrics_from_run,
    normalize,
    score,
    sla_from_jobs,
    utilization,
    wait_p95,
)


def result(
    jid: str,
    user: str = "u",
    submit: int = 0,
    start: int | None = 0,
    end: int | None = 100,
    nodes: int = 1,
    walltime: int = 100,
    actual: int = 100,
    completed: bool = True,
) -> JobResult:
    return JobResult(
        id=jid,
        user=user,
        submit_time=submit,
        start_time=start,
        end_time=end,
        nodes_req=nodes,
        walltime_req=walltime,
        actual_runtime=actual,
        runtime_used=None if start is None or end is None else end - start,
        timed_out=False,
        completed=completed,
    )


# --- utilization -------------------------------------------------------------


def test_utilization_uses_run_totals_when_populated():
    run = RunResult(
        jobs=[result("j1", end=100)], node_seconds_busy=100, node_seconds_total=400, end_time=100
    )
    # 100 busy / 400 available = 0.25 exactly.
    assert utilization(run) == pytest.approx(0.25)


def test_utilization_zero_denominator_is_zero():
    # No totals, no jobs, no window -> defined as 0.0 (never ZeroDivisionError).
    assert utilization(RunResult(jobs=[], end_time=0)) == 0.0


def test_utilization_falls_back_to_peak_nodes_without_totals():
    # Two jobs: j1 holds 2 nodes [0,50) -> 100 node-seconds; j2 holds 1 node [0,100) -> 100.
    # Busy = 200. Peak concurrent demand = 2 + 1 = 3 nodes at t=0; window = 100 - 0 = 100.
    # Denominator = 3 * 100 = 300 -> 200/300 = 0.6666666666666666, and it can never exceed 1.
    run = RunResult(
        jobs=[
            result("j1", start=0, end=50, nodes=2, walltime=50, actual=50),
            result("j2", start=0, end=100, nodes=1, walltime=100, actual=100),
        ],
        end_time=100,
    )
    assert utilization(run) == pytest.approx(200 / 300)
    assert utilization(run) <= 1.0


def test_utilization_fallback_with_cluster_uses_real_node_count():
    cluster = Cluster(
        [
            Site(
                id="s",
                name="s",
                partitions=[
                    Partition(
                        id="p",
                        name="p",
                        site_id="s",
                        nodes=[
                            Node("n0", "n0", 1, 0, 0, "p"),
                            Node("n1", "n1", 1, 0, 0, "p"),
                            Node("n2", "n2", 1, 0, 0, "p"),
                            Node("n3", "n3", 1, 0, 0, "p"),
                        ],
                    )
                ],
            )
        ]
    )
    # One job: 2 nodes x 100 s = 200 busy. Cluster truth: 4 nodes x (100 - 0) = 400 -> 0.5.
    run = RunResult(
        jobs=[result("j1", start=0, end=100, nodes=2, walltime=100, actual=100)], end_time=100
    )
    assert utilization(run, cluster=cluster) == pytest.approx(0.5)


def test_utilization_fallback_counts_distinct_placed_nodes():
    # Two sequential 1-node jobs, back to back on n0 then n1: busy = 100 + 100 = 200.
    # With placements the distinct-node count is 2 -> 2 * (200 - 0) = 400 -> 200/400 = 0.5.
    jobs = [
        Job("j1", "u", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=100,
            state=JobState.COMPLETED, start_time=0, end_time=100, placed_nodes=("n0",)),
        Job("j2", "u", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=100,
            state=JobState.COMPLETED, start_time=100, end_time=200, placed_nodes=("n1",)),
    ]
    run = RunResult(jobs=[JobResult.from_job(j) for j in jobs], end_time=200)
    assert utilization(run, jobs) == pytest.approx(0.5)
    # Without placements the peak concurrent demand is 1 node -> 1 * 200 = 200 -> 1.0.
    assert utilization(run) == pytest.approx(1.0)


# --- bounded_slowdown --------------------------------------------------------


def test_bounded_slowdown_hand_mean():
    run = RunResult(
        jobs=[
            result("j1", submit=0, start=0, end=100),      # wait 0,   run 100
            result("j2", submit=0, start=50, end=150),     # wait 50,  run 100
            result("j3", submit=0, start=5, end=7),        # wait 5,   run 2 (short-job floor)
        ],
        end_time=150,
    )
    # j1: max(0+100,10)/max(100,10)     = 1.0
    # j2: max(50+100,10)/max(100,10)    = 1.5
    # j3: max(5+2,10)/max(2,10)         = 10/10 = 1.0  (the 10 s floor shields the short job)
    # mean = (1.0 + 1.5 + 1.0) / 3      = 3.5/3 = 1.1666666666666667
    assert bounded_slowdown(run) == pytest.approx(3.5 / 3)


def test_bounded_slowdown_penalizes_unfinished_run():
    # An unfinished job must NOT measure as best-on-earth (0.0); measured at the horizon a never-
    # started job is pure wait. A run where nothing finishes must score WORST, not best.
    run = RunResult(jobs=[result("j1", submit=0, start=None, end=None, completed=False)],
                    end_time=1000)
    assert bounded_slowdown(run) > 1.0  # starved job -> large slowdown, not 0.0
    # Truly empty (no jobs at all) is defined as 0.0 (nothing was ever scheduled).
    assert bounded_slowdown(RunResult(jobs=[])) == 0.0


def test_idle_run_does_not_outscore_working_run():
    # Anti-exploit: two runs over the same jobs; one completes them, one completes none. The
    # working run's bounded_slowdown must be strictly lower (a dead run must not win).
    working = RunResult(
        jobs=[result(f"j{i}", submit=0, start=0, end=100) for i in range(5)], end_time=100)
    dead = RunResult(
        jobs=[result(f"j{i}", submit=0, start=None, end=None, completed=False) for i in range(5)],
        end_time=100)
    assert bounded_slowdown(working) < bounded_slowdown(dead)
    assert wait_p95(working) < wait_p95(dead)


# --- wait_p95 ----------------------------------------------------------------


def test_wait_p95_nearest_rank_ten_jobs():
    # Waits 0..9 sorted -> [0,1,...,9]; N=10, rank = ceil(0.95*10) = ceil(9.5) = 10, index 9.
    run = RunResult(
        jobs=[result(f"j{i:02d}", submit=0, start=i, end=i + 1) for i in range(10)],
        end_time=10,
    )
    assert wait_p95(run) == 9.0


def test_wait_p95_nearest_rank_twenty_jobs():
    # Waits 0..19; N=20, rank = ceil(0.95*20) = ceil(19) = 19, index 18 -> value 18.
    run = RunResult(
        jobs=[result(f"j{i:02d}", submit=0, start=i, end=i + 1) for i in range(20)],
        end_time=20,
    )
    assert wait_p95(run) == 18.0


def test_wait_p95_single_and_empty():
    assert wait_p95(RunResult(jobs=[result("j1", start=7, end=8)], end_time=8)) == 7.0
    assert wait_p95(RunResult(jobs=[])) == 0.0


# --- fairness ----------------------------------------------------------------


def test_fairness_perfectly_equal_users_is_one():
    # a: 1 node x 100 s delivered 100, entitled 1 x 100 = 100
    # b: 1 node x 100 s delivered 100, entitled 1 x 100 = 100
    # shares equal -> x = [1, 1] -> Jain = (2)^2 / (2 * 2) = 1.0
    run = RunResult(
        jobs=[
            result("j1", user="a", start=0, end=100),
            result("j2", user="b", start=0, end=100),
        ],
        end_time=100,
    )
    assert fairness(run) == pytest.approx(1.0)


def test_fairness_one_user_hogging_is_nine_thirteenths():
    # a: 2 nodes x run 100 (walltime 100) -> delivered 200, entitled 200
    # b: 1 node  x run 20  (walltime 100) -> delivered 20,  entitled 100
    # delivered shares: 200/220, 20/220 ; entitled shares: 200/300, 100/300
    # x_a = (200/220)/(200/300) = 300/220 = 15/11
    # x_b = (20/220)/(100/300) = 60/220 = 3/11
    # Jain = (15/11 + 3/11)^2 / (2 * ((15/11)^2 + (3/11)^2))
    #      = (324/121) / (2 * 234/121) = 324/468 = 9/13 = 0.6923076923076923
    run = RunResult(
        jobs=[
            result("j1", user="a", start=0, end=100, nodes=2, walltime=100, actual=100),
            result("j2", user="b", start=0, end=20, nodes=1, walltime=100, actual=20),
        ],
        end_time=100,
    )
    assert fairness(run) == pytest.approx(9 / 13)
    assert fairness(run) < 1.0


def test_fairness_skips_zero_entitled_users_and_degenerates_to_one():
    # c requested 0 node-seconds (walltime 0) -> excluded from the index; a and b are equal.
    run = RunResult(
        jobs=[
            result("j1", user="a", start=0, end=100, walltime=100),
            result("j2", user="b", start=0, end=100, walltime=100),
            result("j3", user="c", start=0, end=100, walltime=0),
        ],
        end_time=100,
    )
    assert fairness(run) == pytest.approx(1.0)
    assert fairness(RunResult(jobs=[])) == 1.0


# --- sla ---------------------------------------------------------------------


def test_sla_from_jobs_mix_of_met_and_missed():
    jobs = [
        Job("j1", "a", submit_time=0, sla=10, start_time=5, end_time=105),    # met (wait 5)
        Job("j2", "a", submit_time=0, sla=10, start_time=20, end_time=120),   # missed (wait 20)
        Job("j3", "b", submit_time=0, sla=5, start_time=None),                # missed (never ran)
        Job("j4", "b", submit_time=0, sla=None, start_time=999, end_time=1000),  # no SLA: ignored
    ]
    # 1 met out of the 3 SLA-bearing jobs = 0.3333333333333333.
    assert sla_from_jobs(jobs) == pytest.approx(1 / 3)


def test_sla_from_jobs_without_any_sla_is_one():
    assert sla_from_jobs([Job("j1", "a", submit_time=0, start_time=500)]) == 1.0


def test_metrics_from_run_includes_sla_only_with_jobs():
    run = RunResult(jobs=[result("j1", start=0, end=100)], node_seconds_busy=100,
                    node_seconds_total=400, end_time=100)
    assert "sla" not in metrics_from_run(run)
    with_jobs = metrics_from_run(run, [Job("j1", "a", submit_time=0, sla=10, start_time=0)])
    assert "sla" in with_jobs and with_jobs["sla"] == 1.0


def test_metrics_from_run_shape_and_order_independence():
    jobs = [result("j2", user="b", submit=0, start=10, end=110),
            result("j1", user="a", submit=0, start=0, end=100)]
    run_a = RunResult(jobs=list(jobs), node_seconds_busy=210, node_seconds_total=400, end_time=110)
    run_b = RunResult(jobs=list(reversed(jobs)), node_seconds_busy=210,
                      node_seconds_total=400, end_time=110)
    m = metrics_from_run(run_a)
    assert set(m) == {"utilization", "bounded_slowdown", "wait_p95", "fairness"}
    assert all(math.isfinite(v) for v in m.values())
    # 210/400 = 0.525
    assert m["utilization"] == pytest.approx(0.525)
    # Input order must not move a float: sums run in job-id order.
    assert metrics_from_run(run_b) == m


# --- normalized score --------------------------------------------------------

ANCHORS = {
    "utilization": {"baseline": 0.40, "reference": 0.85, "higher_better": True},
    "wait_p95": {"baseline": 200.0, "reference": 20.0, "higher_better": False},
}
WEIGHTS = {"utilization": 0.5, "wait_p95": 0.5}


def test_normalize_both_directions_and_degenerate_anchor():
    assert normalize("utilization", 0.40, ANCHORS["utilization"]) == pytest.approx(0.0)
    assert normalize("utilization", 0.85, ANCHORS["utilization"]) == pytest.approx(1.0)
    # lower-better: (b - v) / (b - r) = (200 - 20) / (200 - 20) = 1.0
    assert normalize("wait_p95", 20.0, ANCHORS["wait_p95"]) == pytest.approx(1.0)
    assert normalize("wait_p95", 110.0, ANCHORS["wait_p95"]) == pytest.approx(0.5)
    # r == b is degenerate -> 0.0, no ZeroDivisionError, and unclamped otherwise
    assert normalize("x", 5.0, {"baseline": 1.0, "reference": 1.0}) == 0.0
    assert normalize("x", 10.0, {"baseline": 0.0, "reference": 1.0}) == pytest.approx(10.0)


def test_score_baseline_is_300_and_reference_is_800():
    baseline = {"utilization": 0.40, "wait_p95": 200.0}
    reference = {"utilization": 0.85, "wait_p95": 20.0}
    assert score(baseline, WEIGHTS, ANCHORS) == 300
    assert score(reference, WEIGHTS, ANCHORS) == 800


def test_score_midpoint_is_linear():
    # Halfway to reference on both metrics: blend = 0.5 -> 300 + 500*0.5 = 550.
    mid = {"utilization": 0.625, "wait_p95": 110.0}
    assert score(mid, WEIGHTS, ANCHORS) == 550


def test_score_clamps_at_1000_and_0():
    # utilization 10x past reference: normalize = 40/0.45, wait met -> blend > 1 -> clamp 1000
    assert score({"utilization": 40.0, "wait_p95": 20.0}, WEIGHTS, ANCHORS) == 1000
    # utilization 0: normalize = (0 - 0.4)/0.45 = -0.888.., wait 2000:
    # normalize = (200 - 2000)/(200-20) = -10.0 -> blend = -5.44 -> clamp 0
    assert score({"utilization": 0.0, "wait_p95": 2000.0}, WEIGHTS, ANCHORS) == 0


def test_score_normalizes_weights_over_present_metrics_only():
    # `fairness` is weighted but absent from metrics -> weights renormalize over the two
    # present ones; here only utilization is weighted and it sits at reference -> 800.
    assert score({"utilization": 0.85, "fairness": 1.0},
                 {"utilization": 1.0, "fairness": 1.0},
                 {**ANCHORS, "fairness": {"baseline": 0.9, "reference": 1.0}}) == 800
    # Unequal weights, both at half -> blend 0.5 -> 550 regardless of the split.
    assert score({"utilization": 0.625, "wait_p95": 110.0},
                 {"utilization": 0.9, "wait_p95": 0.1}, ANCHORS) == 550


def test_score_empty_weights_and_missing_anchors():
    # No weighted metrics present -> blend 0.0 -> the baseline score of 300.
    assert score({"utilization": 0.99}, {}, ANCHORS) == 300
    assert score({}, WEIGHTS, ANCHORS) == 300
    # A weighted metric with no anchor block normalizes to 0.0, i.e. it behaves like baseline:
    # utilization at baseline -> 0.0, energy has no anchor -> 0.0 -> blend 0.0 -> 300.
    assert score({"utilization": 0.40, "energy": 1.0},
                 {"utilization": 0.5, "energy": 0.5}, ANCHORS) == 300


# --- integration smoke (not a golden) ----------------------------------------


def test_metrics_from_a_real_fifo_run_are_sane():
    cluster = Cluster(
        [
            Site(
                id="s1",
                name="site",
                partitions=[
                    Partition(
                        id="p1",
                        name="batch",
                        site_id="s1",
                        nodes=[
                            Node("n0", "node0", cpus=8, mem=0, gpus=0, partition_id="p1"),
                            Node("n1", "node1", cpus=8, mem=0, gpus=0, partition_id="p1"),
                        ],
                    )
                ],
            )
        ]
    )
    jobs = [
        Job("j0", "alice", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=100,
            sla=10),
        Job("j1", "bob", submit_time=0, nodes_req=1, walltime_req=100, actual_runtime=100,
            sla=10),
        Job("j2", "alice", submit_time=10, nodes_req=1, walltime_req=50, actual_runtime=50,
            sla=10),
        Job("j3", "bob", submit_time=20, nodes_req=2, walltime_req=100, actual_runtime=40),
    ]
    run = Scheduler(cluster, jobs, fifo).run()

    m = metrics_from_run(run, jobs, cluster=cluster)
    assert set(m) == {"utilization", "bounded_slowdown", "wait_p95", "fairness", "sla"}
    assert all(math.isfinite(v) for v in m.values())
    assert 0.0 <= m["utilization"] <= 1.0
    assert 0.0 <= m["sla"] <= 1.0
    assert m["bounded_slowdown"] >= 1.0
    assert m["wait_p95"] >= 0.0
    assert 0.0 < m["fairness"] <= 1.0
    # A deterministic pure function: same run, identical dict.
    assert metrics_from_run(run, jobs, cluster=cluster) == m
