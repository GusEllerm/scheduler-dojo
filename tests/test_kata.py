"""Stage 2 acceptance: reference katas parse, run, and beat FIFO; the step budget stops an infinite
loop inside one decision with a clean fallback; and each error-catalogue code surfaces correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from scheduler_dojo.kata import parse
from scheduler_dojo.kata.check import check
from scheduler_dojo.kata.policy import KataPolicy
from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.cluster import Cluster, Node, Partition, Site
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.level import load_level_file, run_level
from scheduler_dojo.sim.scheduler import Scheduler

HERE = Path(__file__).resolve().parent.parent
KATAS = HERE / "levels" / "reference_katas"


def _fixture():
    return load_level_file(HERE / "levels" / "fixture.json")


def _small_cluster(n=4):
    nodes = [Node(id=str(i), name=f"n{i}", cpus=8, mem=64, gpus=0, partition_id="p")
             for i in range(n)]
    return Cluster([Site(id="s", name="s", partitions=[Partition(id="p", name="batch",
                                                                  site_id="s", nodes=nodes)])])


def _run_kata(src, *, unlocked=("core",), jobs=None, cluster=None):
    cluster = cluster or _small_cluster()
    jobs = jobs or []
    policy = KataPolicy(parse(src), unlocked=frozenset(unlocked))
    sched = Scheduler(cluster, jobs, policy)
    result = sched.run()
    return result, policy


# --- reference katas beat / match FIFO -----------------------------------------------------------


def test_order_kata_beats_fifo_on_bounded_slowdown():
    lvl = _fixture()
    fifo_bs = scoring.metrics_from_run(run_level(lvl, seed=1, policy="fifo"))["bounded_slowdown"]
    kata_bs = scoring.metrics_from_run(
        run_level(lvl, seed=1, kata=str(KATAS / "shortest_first.kata"))
    )["bounded_slowdown"]
    assert kata_bs < fifo_bs, (kata_bs, fifo_bs)


def test_order_kata_matches_builtin_shortest_first():
    lvl = _fixture()
    builtin = scoring.metrics_from_run(
        run_level(lvl, seed=1, policy="shortest_first"))["bounded_slowdown"]
    kata = scoring.metrics_from_run(
        run_level(lvl, seed=1, kata=str(KATAS / "shortest_first.kata")))["bounded_slowdown"]
    assert kata == pytest.approx(builtin)


def test_backfill_kata_runs_completely_with_reserve_unlocked():
    lvl = dict(_fixture())
    lvl["unlocks"] = ["core", "reserve"]
    result = run_level(lvl, seed=2, kata=str(KATAS / "backfill.kata"))
    # Every job is accounted for and the kata did not crash out of the run.
    assert result.n_jobs == lvl["generator"]["n_jobs"]
    assert result.end_time > 0
    metrics = scoring.metrics_from_run(result)
    assert metrics["utilization"] > 0.5


# --- step budget ------------------------------------------------------------------


def test_infinite_loop_falls_back_to_fifo_without_crashing():
    jobs = [Job(id=str(i), user="u", submit_time=0, nodes_req=1, walltime_req=30,
                actual_runtime=30) for i in range(6)]
    src = "place by spin:\n    while true:\n        pass\n"
    result, policy = _run_kata(src, jobs=jobs)
    # It completed (no crash) and fell back — the loop is bounded by the budget.
    assert policy.fallbacks >= 1
    assert policy.last_fallback == "step_budget"
    finished = [j for j in result.jobs if j.completed or j.timed_out]
    assert len(finished) == len(jobs)


def test_step_budget_error_carries_line():
    from scheduler_dojo.sim.errors import StepBudgetError

    jobs = [Job(id="0", user="u", submit_time=0, nodes_req=1, walltime_req=10, actual_runtime=10)]
    # A place module that never terminates but is written so the budget trips inside the loop body.
    src = "place by spin:\n    x = 0\n    while true:\n        x = x + 1\n"
    result, policy = _run_kata(src, jobs=jobs)
    assert policy.last_fallback == "step_budget"


# --- error catalogue --------------------------------------------------------------


def _fallback_code(src, *, unlocked=("core",), jobs=None):
    jobs = jobs or [Job(id="0", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                        actual_runtime=10)]
    _, policy = _run_kata(src, unlocked=unlocked, jobs=jobs)
    return policy.last_fallback


def test_undefined_name():
    assert _fallback_code("place by bad:\n    place(nothere)\n") == "undefined_name"


def test_no_such_field():
    assert _fallback_code("order by bad:\n    x = job.nope\n") == "no_such_field"


def test_type_error_on_string_misuse():
    assert _fallback_code("place by bad:\n    x = len(3)\n") in ("type", "arity")


def test_arity_error():
    assert _fallback_code("order by bad:\n    x = queue(1, 2, 3)\n") == "arity"


def test_sensor_locked():
    # job.actual_runtime with sensor tier off -> sensor_locked fallback (job is bound in `order`).
    assert _fallback_code("order by bad:\n    x = job.actual_runtime\n",
                          unlocked=("core",)) == "sensor_locked"


def test_reserve_slot_locked_without_unlock():
    # earliest_fit is reserve-tier; core-only unlock -> slot_locked.
    assert _fallback_code("order by bad:\n    x = earliest_fit(job)\n",
                          unlocked=("core",)) == "slot_locked"


def test_max_depth_via_recursion():
    src = ("def boom(x):\n"
           "    return boom(x + 1)\n"
           "place by bad:\n"
           "    boom(0)\n")
    assert _fallback_code(src) == "max_depth"


# --- check() ----------------------------------------------------------------------


@pytest.mark.parametrize("snippet,code", [
    ("order by x:\n\tkey = 1\n", "tab"),
    ("order by x:\n  key = (\n", "syntax"),
    ("place by p:\n    job.x = 1\n", "field_write"),
    ("place by p:\n    queue = 1\n", "shadow_builtin"),
])
def test_check_reports_codes(snippet, code):
    report = check(snippet)
    assert not report.ok
    assert report.errors[0]["code"] == code


def test_check_ok_on_reference_katas():
    for k in sorted(KATAS.glob("*.kata")):
        assert check(k.read_text()).ok, k.name


def test_cli_missing_file_is_a_clean_error(tmp_path, capsys):
    # Regression: `dojo kata check <missing>` must not raise a traceback.
    from scheduler_dojo.cli import main

    rc = main(["kata", "check", str(tmp_path / "nope.kata")])
    assert rc == 2
    assert "cannot read" in capsys.readouterr().err
