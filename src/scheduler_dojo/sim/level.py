"""Level JSON -> (Cluster, arriving Jobs) + a headless ``run_level``.

The full level schema (unlocks, sensors, weights, bars) lands in Stage 3; this loader
handles the parts Stage 1 needs — cluster shape and the arrival source — and is the single
place the CLI and goldens build a scenario from data.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from scheduler_dojo.sim.cluster import Cluster, Node, Partition, Site
from scheduler_dojo.sim.errors import (LEVEL_BARS, LEVEL_METRIC, LEVEL_SCHEMA, LevelError)
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.scheduler import POLICIES, RunResult, Scheduler
from scheduler_dojo.sim.trace import generate_jobs

# Vocabulary the schema validator checks level files against.
KNOWN_METRICS = frozenset({"utilization", "bounded_slowdown", "wait_p95", "fairness", "sla"})
KNOWN_TIERS = frozenset({"core", "reserve", "fairness", "sensor", "preempt", "route"})
KNOWN_SENSORS = frozenset({"actual_runtime", "est_runtime"})


def validate_level(level: dict[str, Any]) -> None:
    """Raise ``LevelError`` if a level dict is malformed. Cheap dict checks only (no simulation).

    This is the single gate every level (fixture, shipped, or share-card sandbox) passes through, so
    a bad level fails loudly with a code rather than producing a confusing run.
    """
    if not isinstance(level, dict):
        raise LevelError("level must be an object", code=LEVEL_SCHEMA)
    for key in ("id", "title", "cluster"):
        if key not in level:
            raise LevelError(f"level missing required key {key!r}", code=LEVEL_SCHEMA)
    if "generator" not in level and "jobs" not in level:
        raise LevelError("level needs a 'generator' or an explicit 'jobs' list", code=LEVEL_SCHEMA)
    if not isinstance(level["cluster"], dict) or not (
        "sites" in level["cluster"] or "nodes" in level["cluster"]
    ):
        raise LevelError("cluster needs 'sites' or 'nodes'", code=LEVEL_SCHEMA)
    if level.get("generator") is not None and "generator" in level:
        if not isinstance(level["generator"], dict):
            raise LevelError("generator must be an object", code=LEVEL_SCHEMA)
    if "jobs" in level:
        if not isinstance(level["jobs"], list) or not level["jobs"]:
            raise LevelError("jobs must be a non-empty list", code=LEVEL_SCHEMA)
        for jd in level["jobs"]:
            if not isinstance(jd, dict) or "id" not in jd or "submit_time" not in jd:
                raise LevelError("each explicit job needs 'id' and 'submit_time'", code=LEVEL_SCHEMA)

    dur = level.get("duration")
    if dur is not None and (not isinstance(dur, int) or dur <= 0):
        raise LevelError("duration must be a positive integer", code=LEVEL_SCHEMA)

    if "unlocks" in level:
        u = level["unlocks"]
        if not isinstance(u, list) or not set(u) <= KNOWN_TIERS:
            raise LevelError(f"unlocks must be a subset of {sorted(KNOWN_TIERS)}", code=LEVEL_SCHEMA)
    if "sensors" in level:
        s = level["sensors"]
        if not isinstance(s, list) or not set(s) <= KNOWN_SENSORS:
            raise LevelError(f"sensors must be a subset of {sorted(KNOWN_SENSORS)}", code=LEVEL_SCHEMA)

    weights = level.get("score_weights")
    anchors = level.get("score_anchors")
    if weights is not None:
        if not isinstance(weights, dict) or not weights:
            raise LevelError("score_weights must be a non-empty object", code=LEVEL_METRIC)
        unknown = set(weights) - KNOWN_METRICS
        if unknown:
            raise LevelError(f"score_weights has unknown metric(s) {sorted(unknown)}",
                             code=LEVEL_METRIC)
        if anchors is None:
            raise LevelError("score_weights present but no score_anchors", code=LEVEL_METRIC)
        if set(anchors) != set(weights):
            raise LevelError("score_anchors must have the same metrics as score_weights",
                             code=LEVEL_METRIC)
        for m, pair in anchors.items():
            if not isinstance(pair, dict) or "baseline" not in pair or "reference" not in pair:
                raise LevelError(f"anchor for {m!r} needs baseline and reference", code=LEVEL_METRIC)

    bars = level.get("bars")
    if bars is not None:
        if not isinstance(bars, dict) or "pass_score" not in bars or "gold_score" not in bars:
            raise LevelError("bars needs pass_score and gold_score", code=LEVEL_BARS)
        p, g = bars["pass_score"], bars["gold_score"]
        if not (0 <= p <= g <= 1000):
            raise LevelError(f"bars must satisfy 0 <= pass({p}) <= gold({g}) <= 1000", code=LEVEL_BARS)


def build_cluster(spec: dict[str, Any]) -> Cluster:
    """Accept the full ``sites`` shape or a ``nodes`` shorthand (one implicit site+partition)."""
    if "sites" in spec:
        sites: list[Site] = []
        for sd in spec["sites"]:
            parts: list[Partition] = []
            for pd in sd.get("partitions", []):
                nodes = [
                    Node(
                        id=str(nd["id"]), name=str(nd.get("name", nd["id"])),
                        cpus=int(nd.get("cpus", 1)), mem=int(nd.get("mem", 0)),
                        gpus=int(nd.get("gpus", 0)), partition_id=str(pd["id"]),
                        tags=tuple(nd.get("tags", ())),
                    )
                    for nd in pd.get("nodes", [])
                ]
                parts.append(Partition(id=str(pd["id"]), name=str(pd.get("name", pd["id"])),
                                       site_id=str(sd["id"]), nodes=nodes))
            sites.append(Site(id=str(sd["id"]), name=str(sd.get("name", sd["id"])),
                              partitions=parts))
        return Cluster(sites)

    # Shorthand: a flat node list under one site/partition.
    part_name = spec.get("partition", "batch")
    nodes = [
        Node(id=str(nd["id"]), name=str(nd.get("name", nd["id"])), cpus=int(nd.get("cpus", 1)),
             mem=int(nd.get("mem", 0)), gpus=int(nd.get("gpus", 0)), partition_id="p",
             tags=tuple(nd.get("tags", ())))
        for nd in spec["nodes"]
    ]
    part = Partition(id="p", name=part_name, site_id="s", nodes=nodes)
    return Cluster([Site(id="s", name="site", partitions=[part])])


def load_jobs(level: dict[str, Any], seed: int) -> list[Job]:
    """Materialize a level's jobs: an explicit list (trace mode) wins, else the generator draws."""
    if level.get("jobs"):
        return jobs_from_level(level)
    gen = level.get("generator")
    if gen is None:
        raise ValueError("level has neither 'generator' nor 'jobs'")
    horizon = level.get("duration")
    return generate_jobs(gen, seed, horizon=horizon)


def jobs_from_level(level: dict[str, Any]) -> list[Job]:
    """Build `Job`s from a level's explicit `jobs` list (trace-imported or hand-authored)."""
    out: list[Job] = []
    for jd in level["jobs"]:
        out.append(Job(
            id=str(jd["id"]), user=str(jd.get("user", "u")), submit_time=int(jd["submit_time"]),
            nodes_req=int(jd.get("nodes_req", 1)), walltime_req=int(jd.get("walltime_req", 3600)),
            cpus_req=int(jd.get("cpus_req", 1)), mem_req=int(jd.get("mem_req", 0)),
            gpus_req=int(jd.get("gpus_req", 0)),
            partition=jd.get("partition"), tags=tuple(jd.get("tags", ())),
            priority=int(jd.get("priority", 0)), deps=tuple(jd.get("deps", ())),
            actual_runtime=int(jd.get("actual_runtime", jd.get("walltime_req", 3600))),
            sla=jd.get("sla"),
            home_site=jd.get("home_site"), data_mb=int(jd.get("data_mb", 0)),
        ))
    return out


def run_level(level: dict[str, Any], *, seed: int | None = None, policy: str | None = None,
              kata: str | Path | None = None, validate: bool = True) -> RunResult:
    """Run a level with a built-in `policy`, or with a `kata` (source string or path).

    `seed` defaults to the level's fixed ``seed`` (levels are deterministic puzzles). When `kata` is
    given, the level's `unlocks` list gates which Kata slots/builtins are enabled, and the policy is
    a ``scheduler_dojo.kata.KataPolicy`` over the parsed program (with FIFO first-fit fallback).
    """
    if validate:
        validate_level(level)
    if seed is None:
        seed = int(level.get("seed", 0))
    cluster = build_cluster(level["cluster"])
    jobs = load_jobs(level, seed)
    if policy is None:
        policy = level.get("default_policy", "fifo")
    if kata is not None:
        from scheduler_dojo.kata import parse
        from scheduler_dojo.kata.policy import KataPolicy

        src = _kata_source(kata)
        program = parse(src)
        unlocked = frozenset(level.get("unlocks", ["core"]))
        active: Any = KataPolicy(program, unlocked=unlocked)
    else:
        if policy not in POLICIES:
            raise ValueError(f"unknown policy {policy!r}; have {sorted(POLICIES)}")
        active = POLICIES[policy]
    # Optional level key: inter-site MB/s for multi-site (route-tier) levels; absent ⇒ instantaneous.
    rate = float(level.get("transfer_rate_mbs", 0.0) or 0.0)
    sched = Scheduler(cluster, jobs, active, transfer_rate_mbs=rate)
    duration = level.get("duration")
    return sched.run(until=duration)


def fifo_policy():
    from scheduler_dojo.sim.scheduler import fifo

    return fifo


def _kata_source(kata: str | Path) -> str:
    """Resolve a kata argument to source text: a readable path wins, otherwise it is literal source.

    A path test on a multi-line program string can raise `OSError` (name too long) or be ambiguous,
    so only treat `kata` as a path when it looks like one (single line, no newline, reasonable length).
    """
    text = str(kata)
    if "\n" not in text and len(text) <= 512:
        try:
            p = Path(text)
            if p.exists():
                return p.read_text()
        except OSError:
            pass
    return text


def load_level_file(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())
