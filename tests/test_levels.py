"""Stage 3 acceptance: the level schema validates and rejects; every shipped level is a deterministic
puzzle whose baseline scores 300 and reference scores 800 (gold earned, not baked in); goldens match.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.errors import LevelError
from scheduler_dojo.sim.level import (KNOWN_METRICS, load_level_file, run_level, validate_level)
from scheduler_dojo.sim.trajectory import trajectory_hash

ROOT = Path(__file__).resolve().parent.parent
LEVELS = ROOT / "levels"
GOLDENS = ROOT / "tests" / "goldens" / "levels.json"


def _level_files():
    return sorted(LEVELS.glob("level*.json"))


def _reference_src(level):
    ref = level.get("reference_kata")
    cand = LEVELS / ref if ref else None
    return cand.read_text() if cand and cand.exists() else None


def _minimal():
    return {"id": "x", "title": "t", "cluster": {"nodes": [{"id": "n0"}]},
            "generator": {"n_jobs": 1}}


# --- schema validation --------------------------------------------------------


def test_minimal_level_validates():
    validate_level(_minimal())  # no raise


@pytest.mark.parametrize("mutate,code", [
    (lambda l: l.pop("id"), "level_schema"),
    (lambda l: l.pop("generator"), "level_schema"),
    (lambda l: l.__setitem__("cluster", {}), "level_schema"),
    (lambda l: l.__setitem__("unlocks", ["nonsense"]), "level_schema"),
    (lambda l: l.__setitem__("sensors", ["bogus"]), "level_schema"),
    (lambda l: l.__setitem__("duration", -5), "level_schema"),
    (lambda l: (l.__setitem__("score_weights", {"made_up": 1.0}),
                l.__setitem__("score_anchors", {"made_up": {"baseline": 0, "reference": 1}})),
     "level_metric"),
    (lambda l: (l.__setitem__("score_weights", {"utilization": 1.0}),
                l.__setitem__("score_anchors", {"fairness": {"baseline": 0, "reference": 1}})),
     "level_metric"),
    (lambda l: l.__setitem__("bars", {"pass_score": 900, "gold_score": 100}), "level_bars"),
])
def test_validate_rejects(mutate, code):
    lvl = _minimal()
    mutate(lvl)
    with pytest.raises(LevelError) as ei:
        validate_level(lvl)
    assert ei.value.code == code


# --- shipped levels: deterministic puzzles ------------------------------------


def test_every_level_validates_and_has_a_seed():
    for path in _level_files():
        lvl = load_level_file(path)
        validate_level(lvl)
        assert "seed" in lvl, path.name
        assert lvl["bars"]["pass_score"] <= lvl["bars"]["gold_score"], path.name


def test_levels_are_deterministic():
    for path in _level_files():
        lvl = load_level_file(path)
        h1 = trajectory_hash(run_level(lvl))  # uses the level's fixed seed
        h2 = trajectory_hash(run_level(lvl))
        assert h1 == h2, path.name


def test_reference_scores_800_and_beats_baseline_to_gold():
    for path in _level_files():
        lvl = load_level_file(path)
        w, a = lvl["score_weights"], lvl["score_anchors"]
        base_policy = lvl.get("baseline_policy", lvl.get("default_policy", "fifo"))
        s_base = scoring.score(scoring.metrics_from_run(run_level(lvl, policy=base_policy)), w, a)
        s_ref = scoring.score(scoring.metrics_from_run(
            run_level(lvl, kata=_reference_src(lvl))), w, a)
        assert s_base == 300, (path.name, s_base)
        assert s_ref == 800, (path.name, s_ref)
        assert s_ref >= lvl["bars"]["gold_score"], path.name
        assert s_base < lvl["bars"]["pass_score"], path.name


def test_reference_improves_primary_metric():
    for path in _level_files():
        lvl = load_level_file(path)
        base_policy = lvl.get("baseline_policy", lvl.get("default_policy", "fifo"))
        b = scoring.metrics_from_run(run_level(lvl, policy=base_policy))
        r = scoring.metrics_from_run(run_level(lvl, kata=_reference_src(lvl)))
        m = lvl["primary_metric"]
        lower = m in ("bounded_slowdown", "wait_p95")
        assert (r[m] < b[m]) if lower else (r[m] > b[m]), (path.name, m, b[m], r[m])


def test_level_goldens_match():
    goldens = json.loads(GOLDENS.read_text())
    for path in _level_files():
        lvl = load_level_file(path)
        g = goldens[path.name]
        assert g["seed"] == lvl["seed"], path.name
        base_policy = lvl.get("baseline_policy", lvl.get("default_policy", "fifo"))
        rb = run_level(lvl, policy=base_policy)
        assert trajectory_hash(rb) == g["baseline_hash"], path.name
        assert g["baseline_score"] == 300
        rr = run_level(lvl, kata=_reference_src(lvl))
        assert trajectory_hash(rr) == g["reference_hash"], path.name
        assert g["reference_score"] == 800


# --- primitives introduced in Stage 3 -----------------------------------------


def test_idle_policy_places_nothing():
    lvl = load_level_file(next(p for p in _level_files() if p.name == "level2.json"))
    r = run_level(lvl, policy="idle")
    assert r.node_seconds_busy == 0
    assert all(not j.completed for j in r.jobs)


def test_fits_later_is_a_capacity_ceiling():
    from scheduler_dojo.sim.cluster import Cluster, Node, Partition, Site
    from scheduler_dojo.sim.jobs import Job
    from scheduler_dojo.sim.scheduler import Scheduler, PolicyContext

    nodes = [Node(id=str(i), name=f"n{i}", cpus=8, mem=32, gpus=0, partition_id="p")
             for i in range(2)]
    cluster = Cluster([Site(id="s", name="s", partitions=[
        Partition(id="p", name="b", site_id="s", nodes=nodes)])])
    sched = Scheduler(cluster, [], lambda ctx: None)
    ctx = PolicyContext(sched)  # fits_later is time-agnostic (a pure capacity ceiling)

    big = Job(id="big", user="u", submit_time=0, nodes_req=3, walltime_req=100)  # >2 nodes
    fits = Job(id="fit", user="u", submit_time=0, nodes_req=2, walltime_req=100)
    assert ctx.fits_later(fits) is True
    assert ctx.fits_later(big) is False  # 3 nodes impossible on a 2-node cluster


def test_level_json_files_are_valid_json_on_disk():
    # The calibration rewrites files; guard that they stayed well-formed and sorted-key-stable.
    for path in _level_files():
        raw = path.read_text()
        assert raw.endswith("\n"), path.name
        data = json.loads(raw)
        assert data["id"] == path.stem, path.name
