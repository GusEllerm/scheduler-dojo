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
from scheduler_dojo.sim.jobs import Job
from scheduler_dojo.sim.scheduler import POLICIES, RunResult, Scheduler
from scheduler_dojo.sim.trace import generate_jobs


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
    gen = level.get("generator")
    if gen is None:
        raise ValueError("level has no 'generator' block")
    horizon = level.get("duration")
    return generate_jobs(gen, seed, horizon=horizon)


def run_level(level: dict[str, Any], *, seed: int, policy: str = "fifo") -> RunResult:
    if policy not in POLICIES:
        raise ValueError(f"unknown policy {policy!r}; have {sorted(POLICIES)}")
    cluster = build_cluster(level["cluster"])
    jobs = load_jobs(level, seed)
    sched = Scheduler(cluster, jobs, POLICIES[policy])
    duration = level.get("duration")
    return sched.run(until=duration)


def load_level_file(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())
