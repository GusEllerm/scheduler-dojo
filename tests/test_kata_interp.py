"""Tests for the Kata interpreter + Env + KataPolicy (ast built by hand; parser optional)."""

from __future__ import annotations

import pytest

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.ast import (
    Assign, Attribute, BinOp, Bool, BoolOp, Call, Def, ExprStmt, For, If, Int, Module,
    Name, Nil, Pass, Program, Remember, Return, Str, Tuple, While,
)
from scheduler_dojo.kata.builtins import Env, JobRec
from scheduler_dojo.kata.errors import EngineError
from scheduler_dojo.kata.interp import Interp, run_module
from scheduler_dojo.kata.policy import KataPolicy
from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.cluster import Cluster, Node, Partition, Site
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.scheduler import PolicyContext, Scheduler, fifo

try:
    from scheduler_dojo.kata.parser import parse
    HAVE_PARSER = True
except ImportError:  # the parser is built concurrently; skip its tests until it lands
    parse = None
    HAVE_PARSER = False


# --- fixtures ------------------------------------------------------------------

def make_cluster(n=2, cpus=8):
    nodes = [
        Node(id=f"n{i}", name=f"node{i}", cpus=cpus, mem=32, gpus=0, partition_id="p")
        for i in range(n)
    ]
    return Cluster([Site(id="s", name="site",
                         partitions=[Partition(id="p", name="batch", site_id="s",
                                              nodes=nodes)])])


def simple_jobs():
    return [Job(id=f"j{i}", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                actual_runtime=10) for i in range(4)]


def program(*modules, defs=()):
    return Program(modules=tuple(modules), defs=tuple(defs))


def scan_module():
    """`place by scan: for j in queue(): if fits_now(j): place(j)`"""
    return Module("place", "scan", (
        For("j", Call("queue", (), ()), (
            If(Call("fits_now", (Name("j"),), ()),
               (ExprStmt(Call("place", (Name("j"),), ()), line=3),), (), (), line=3),
        ), line=2),
    ))


def sjf_order_module():
    """`order by sjf: key = (job.walltime_req, job.submit_time)`"""
    return Module("order", "sjf", (
        Assign("key", Tuple((Attribute(Name("job"), "walltime_req"),
                             Attribute(Name("job"), "submit_time"))), line=2),
    ))


def run_kata(modules, jobs, cluster, *, defs=(), unlocked=(), step_budget=20000):
    pol = KataPolicy(program(*modules, defs=defs), unlocked=unlocked,
                     step_budget=step_budget)
    sched = Scheduler(cluster, jobs, pol)
    res = sched.run()
    return pol, res, sched


def make_ctx(jobs, n=2):
    """A PolicyContext parked at t=0 with `jobs` already queued (for direct interp tests)."""
    sched = Scheduler(make_cluster(n), jobs, lambda ctx: None)
    sched.queued.update(j.id for j in jobs)
    return PolicyContext(sched)


# --- placement behaviour --------------------------------------------------------

def test_place_module_matches_fifo_placement():
    jobs1, jobs2 = simple_jobs(), simple_jobs()
    pol, res, _ = run_kata([scan_module()], jobs1, make_cluster(2))
    res_fifo = Scheduler(make_cluster(2), jobs2, fifo).run()
    assert pol.fallbacks == 0
    by_id = {j.id: (j.start_time, j.end_time) for j in res.jobs}
    by_id_f = {j.id: (j.start_time, j.end_time) for j in res_fifo.jobs}
    assert by_id == by_id_f
    assert all(j.end_time is not None for j in res.jobs)  # everything completed


def test_order_module_beats_fifo_on_bounded_slowdown():
    def jobs():
        return [
            Job(id="a", user="u", submit_time=0, nodes_req=1, walltime_req=100,
                actual_runtime=100),
            Job(id="b", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                actual_runtime=10),
            Job(id="c", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                actual_runtime=10),
        ]

    pol, res, sched = run_kata([sjf_order_module(), scan_module()], jobs(), make_cluster(1),
                               unlocked=())
    res_fifo = Scheduler(make_cluster(1), jobs(), fifo).run()
    assert pol.fallbacks == 0
    sd_kata = scoring.bounded_slowdown(res)
    sd_fifo = scoring.bounded_slowdown(res_fifo)
    assert sd_kata < sd_fifo
    starts = {j.id: j.start_time for j in res.jobs}
    assert starts["b"] == 0 and starts["c"] == 10 and starts["a"] == 20


@pytest.mark.skipif(not HAVE_PARSER, reason="kata parser not available yet")
def test_parsed_modules_run():
    src = (
        "order by sjf:\n"
        "    key = (job.walltime_req, job.submit_time)\n"
        "\n"
        "place by scan:\n"
        "    for j in queue():\n"
        "        if fits_now(j):\n"
        "            place(j)\n"
    )
    prog = parse(src)
    jobs = [
        Job(id="a", user="u", submit_time=0, nodes_req=1, walltime_req=100,
            actual_runtime=100),
        Job(id="b", user="u", submit_time=0, nodes_req=1, walltime_req=10,
            actual_runtime=10),
    ]
    pol = KataPolicy(prog)
    res = Scheduler(make_cluster(1), jobs, pol).run()
    assert pol.fallbacks == 0
    assert {j.id: j.start_time for j in res.jobs} == {"b": 0, "a": 10}


# --- step budget -----------------------------------------------------------------

def test_step_budget_stops_and_falls_back():
    spin = Module("place", "spin", (While(Bool(True), (Pass(),), line=1),))
    jobs = simple_jobs()
    pol, res, _ = run_kata([spin], jobs, make_cluster(2), step_budget=500)
    res_fifo = Scheduler(make_cluster(2), simple_jobs(), fifo).run()
    assert pol.fallbacks >= 1
    assert pol.last_fallback == "step_budget"
    by_id = {j.id: (j.start_time, j.end_time) for j in res.jobs}
    by_id_f = {j.id: (j.start_time, j.end_time) for j in res_fifo.jobs}
    assert by_id == by_id_f  # the fallback default (FIFO first-fit) did the work


def test_step_budget_error_names_the_line():
    spin = Module("place", "spin", (
        Assign("x", Int(0), line=1),
        While(Bool(True), (Pass(),), line=2),
    ))
    ctx = make_ctx(simple_jobs()[:1])
    env = Env(ctx, step_budget=100)
    with pytest.raises(EngineError) as ei:
        run_module(spin, env, {})
    assert ei.value.code == "step_budget"
    assert ei.value.line == 2
    assert "line 2" in str(ei.value)


# --- error codes -------------------------------------------------------------------

def _module_error_code(module, *, jobs=None, defs=(), unlocked=(), scope=None):
    ctx = make_ctx(jobs if jobs is not None else simple_jobs()[:2])
    env = Env(ctx, unlocked=unlocked)
    with pytest.raises(EngineError) as ei:
        run_module(module, env, defs, scope=scope)
    return ei.value


def test_undefined_name():
    m = Module("place", "e", (Assign("x", Name("nope"), line=1),))
    assert _module_error_code(m).code == "undefined_name"


def test_no_such_field():
    m = Module("order", "e", (Assign("key", Attribute(Name("job"), "banana"), line=1),))
    err = _module_error_code(m, jobs=[], scope={"job": JobRec(
        Job(id="j0", user="u", submit_time=0))})
    assert err.code == "no_such_field"


def test_type_string_misuse():
    m = Module("place", "e", (Assign("x", BinOp("+", Str("gpu"), Int(1)), line=1),))
    assert _module_error_code(m).code == "type"
    m2 = Module("place", "e", (Assign("x", BinOp("<", Str("gpu"), Int(1)), line=1),))
    assert _module_error_code(m2).code == "type"
    m3 = Module("place", "e", (Assign("x", Tuple((Str("gpu"),)), line=1),))
    assert _module_error_code(m3).code == "type"


def test_arity_wrong_count_for_place():
    m = Module("place", "e", (
        For("j", Call("queue", (), ()), (
            ExprStmt(Call("place", (Name("j"), Name("j"), Name("j")), ()), line=2),
        ), line=1),
    ))
    assert _module_error_code(m).code == "arity"


def test_sensor_locked_actual_runtime():
    m = Module("place", "e", (
        For("j", Call("queue", (), ()), (
            Assign("r", Attribute(Name("j"), "actual_runtime"), line=2),
        ), line=1),
    ))
    assert _module_error_code(m).code == "sensor_locked"
    # ... and readable once the sensor tier is unlocked
    ctx = make_ctx(simple_jobs()[:2])
    env = Env(ctx, unlocked=frozenset({"sensor"}))
    out = run_module(m, env, {}).scope
    assert out["r"] == 10


def test_no_such_builtin():
    m = Module("place", "e", (ExprStmt(Call("wat", (), ()), line=1),))
    assert _module_error_code(m).code == "no_such_builtin"


def test_slot_locked_reserve_tier():
    m = Module("place", "e", (
        For("j", Call("queue", (), ()), (
            ExprStmt(Call("reserve", (Name("j"), Int(5)), ()), line=2),
        ), line=1),
    ))
    assert _module_error_code(m).code == "slot_locked"


def test_kata_policy_surfaces_error_code_as_fallback():
    m = Module("place", "e", (Assign("x", Name("nope"), line=1),))
    pol, res, _ = run_kata([m], simple_jobs(), make_cluster(2))
    assert pol.last_fallback == "undefined_name"
    assert pol.fallbacks >= 1
    assert all(j.end_time is not None for j in res.jobs)


# --- defs, recursion, memory --------------------------------------------------------

def test_user_def_called_from_module():
    helper = Def("helper", ("x",), (Return(BinOp("+", Name("x"), Int(1)), line=2),))
    m = Module("order", "k", (Return(Call("helper", (Int(1),), ()), line=1),))
    ctx = make_ctx([])
    env = Env(ctx)
    res = run_module(m, env, {"helper": helper})
    assert res.value == 2


def test_recursion_depth_cap_raises_max_depth():
    rec = Def("f", ("x",), (Return(Call("f", (Name("x"),), ()), line=2),))
    m = Module("place", "e", (ExprStmt(Call("f", (Int(0),), ()), line=1),))
    assert _module_error_code(m, defs={"f": rec}).code == "max_depth"


def test_def_wrong_arity():
    helper = Def("helper", ("x",), (Return(BinOp("+", Name("x"), Int(1)), line=2),))
    m = Module("place", "e", (Assign("y", Call("helper", (Int(1), Int(2)), ()), line=1),))
    assert _module_error_code(m, defs={"helper": helper}).code == "arity"


def test_remember_recall_persists_across_decisions():
    # `place by lead`: only the first head ever remembered gets placed; memory must
    # survive between decisions for the later ones to place nothing.
    lead = Module("place", "lead", (
        Assign("head", Call("first", (Call("queue", (), ()),), ()), line=1),
        If(BoolOp("and", (BinOp("!=", Name("head"), Nil()),
                           BinOp("==", Call("recall", (Str("lead"),), ()), Nil()))),
           (Remember("lead", Name("head"), line=3),), (), (), line=2),
        If(BoolOp("and", (BinOp("!=", Name("head"), Nil()),
                          BinOp("==", Name("head"),
                                Call("recall", (Str("lead"),), ())))),
           (If(Call("fits_now", (Name("head"),), ()),
               (ExprStmt(Call("place", (Name("head"),), ()), line=6),), (), (), line=6),),
           (), (), line=5),
    ))
    jobs = [Job(id=f"k{i}", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                actual_runtime=10) for i in range(2)]
    pol, res, _ = run_kata([lead], jobs, make_cluster(2),
                           unlocked=frozenset({"remember"}))
    assert pol.fallbacks == 0
    got = {j.id: (j.start_time, j.end_time) for j in res.jobs}
    assert got["k0"][0] == 0 and got["k0"][1] == 10
    assert got["k1"][0] is None  # never placed: memory still points at k0


def test_remember_locked_raises_slot_locked():
    m = Module("place", "e", (Remember("v", Int(1), line=1),))
    assert _module_error_code(m).code == "slot_locked"


# --- direct Env builtin checks ---------------------------------------------------------

def test_env_builtins_basics_and_record_fields():
    jobs = [Job(id="j0", user="amy", submit_time=0, nodes_req=1, walltime_req=20,
                actual_runtime=5, partition="batch")]
    ctx = make_ctx(jobs)
    env = Env(ctx, unlocked=frozenset({"reserve", "fairness", "sensor"}))
    assert env.bi_now() == 0
    assert [r.job.id for r in env.bi_queue()] == ["j0"]
    assert len(env.bi_nodes()) == 2
    assert env.bi_fits_now(JobRec(jobs[0])) is True
    assert env.bi_end_if_started_now(JobRec(jobs[0])) == 5  # min(5, 20) from now=0
    # core list helpers
    assert env.bi_first([3, 1, 2]) == 3
    assert env.bi_rest([3, 1, 2]) == [1, 2]
    assert env.bi_min([4, 2], ) == 2
    assert env.bi_max(1, 7, 3) == 7
    assert env.bi_sum([1, 2, 3]) == 6
    assert env.bi_sorted([3, 1, 2]) == [1, 2, 3]
    assert env.bi_any([False, True]) is True
    assert env.bi_all([True, True]) is True
    assert env.bi_abs(-4) == 4
    assert env.bi_if(True, "a", "b") == "a"
    # records
    assert env.getattr(JobRec(jobs[0]), "user").value == "amy"
    assert env.getattr(JobRec(jobs[0]), "state").value == "queued"
    assert env.getattr(JobRec(jobs[0]), "partition").value == "batch"
    assert env.getattr(JobRec(jobs[0]), "actual_runtime") == 5  # sensor unlocked
    assert env.getattr(JobRec(jobs[0]), "est_runtime") == 20
    node0 = env.bi_nodes()[0]
    assert env.getattr(node0, "free") is True
    assert env.getattr(node0, "partition").value == "batch"


def test_reserve_records_and_earliest_fit_is_deterministic():
    jobs = [Job(id="s", user="u", submit_time=0, nodes_req=1, walltime_req=100,
                actual_runtime=100),
            Job(id="t", user="u", submit_time=0, nodes_req=1, walltime_req=10,
                actual_runtime=10)]
    ctx = make_ctx(jobs, n=1)  # one node: s occupies it [0,100)
    env = Env(ctx, unlocked=frozenset({"reserve"}))
    env.bi_place(JobRec(jobs[0]))            # occupies [0,100)
    ef = env.bi_earliest_fit(JobRec(jobs[1]))
    assert ef == 100                          # waits for s to release the node
    env.bi_reserve(JobRec(jobs[1]), ef)
    assert env.bi_reservation_start(JobRec(jobs[1])) == 100
    assert env.bi_reservation_start(JobRec(jobs[0])) is None


def test_place_with_explicit_nodes():
    job = Job(id="j0", user="u", submit_time=0, nodes_req=1, walltime_req=10,
              actual_runtime=10)
    sched = Scheduler(make_cluster(2), [job], lambda ctx: None)
    seen = []
    sched.policy = lambda ctx: seen.append(ctx)
    sched.run(until=0)  # process t=0 arrivals + one decision, then stop
    env = Env(seen[0])
    env.bi_place(JobRec(job), [env.bi_nodes()[1]])
    assert job.placed_nodes == ("n1",)


def test_user_usage_and_share():
    jobs = [Job(id=f"u{i}", user=("amy" if i == 0 else "bob"), submit_time=-10,
                nodes_req=1, walltime_req=100, actual_runtime=100) for i in range(2)]
    ctx = make_ctx(jobs)
    ctx._sched.running.update({j.id: j for j in jobs})
    for j in jobs:
        j.start_time = 0
    ctx._sched.now = 30
    env = Env(ctx, unlocked=frozenset({"fairness"}))
    assert env.bi_user_usage("amy") == 30
    assert env.bi_user_share("amy") == pytest.approx(0.5)
