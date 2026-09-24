"""Cluster topology and whole-node occupancy.

Whole-node model: at any instant a node hosts at most one *running* job for the whole
interval [start, end). Reservations are future-dated allocations of the same node, so
backfill and ``earliest_fit`` are expressible without changing this model. Occupancy is a
sorted list of ``Allocation`` intervals per node; free-ness at a time is "no interval
covers that time", so the model is time-sliced rather than current-state-only (needed for
reserve/backfill and for a deterministic ``earliest_fit``).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Allocation:
    """A node being held for [start, end). Exactly one holder at a time (whole-node)."""

    start: int
    end: int
    job_id: str
    is_reservation: bool = False  # future hold; a reservation blocks but is not "running"

    @property
    def covers(self) -> tuple[int, int]:
        return (self.start, self.end)


@dataclass
class Node:
    id: str
    name: str
    cpus: int
    mem: int
    gpus: int
    partition_id: str
    tags: tuple[str, ...] = ()
    # Occupancy timeline, kept sorted by (start, job_id). Whole-node: intervals never overlap.
    allocations: list[Allocation] = field(default_factory=list)

    def free_at(self, t: int) -> bool:
        """True if no allocation covers time t (half-open: an allocation ending at t frees it)."""
        return not any(a.start <= t < a.end for a in self.allocations)

    def free_for(self, t: int, duration: int) -> bool:
        """True if the node stays free across [t, t+duration) — no interval overlaps it."""
        if duration <= 0:
            return self.free_at(t)
        return not any(a.start < t + duration and t < a.end for a in self.allocations)

    def next_free_time(self, t: int) -> int:
        """The earliest time >= t at which the node is free (t itself if already free)."""
        cur = t
        changed = True
        # Iterate to a fixed point; allocations are non-overlapping so this is O(intervals).
        while changed:
            changed = False
            for a in self.allocations:
                if a.start <= cur < a.end:
                    cur = a.end
                    changed = True
        return cur

    def allocate(self, start: int, end: int, job_id: str, is_reservation: bool = False) -> None:
        self.allocations.append(Allocation(start, end, job_id, is_reservation))
        self.allocations.sort(key=lambda a: (a.start, a.job_id))

    def release(self, job_id: str) -> None:
        """Drop a finished job's allocation so the timeline stays bounded by *active* +
        future-reservation holders (finished history is never queried again)."""
        if self.allocations:
            self.allocations = [a for a in self.allocations if a.job_id != job_id]

    def meets(self, cpus: int, mem: int, gpus: int, tags: tuple[str, ...]) -> bool:
        return (
            self.cpus >= cpus
            and self.mem >= mem
            and self.gpus >= gpus
            and set(tags).issubset(self.tags)
        )


@dataclass
class Partition:
    id: str
    name: str
    site_id: str
    nodes: list[Node] = field(default_factory=list)


@dataclass
class Site:
    id: str
    name: str
    partitions: list[Partition] = field(default_factory=list)


class Cluster:
    """Flat node index + topology. Nodes carry their own partition/site ids for O(1) scans."""

    def __init__(self, sites: list[Site]) -> None:
        self.sites = sites
        self._nodes: dict[str, Node] = {}
        self._partitions: dict[str, Partition] = {}
        self._sites: dict[str, Site] = {}
        for site in sites:
            self._sites[site.id] = site
            for part in site.partitions:
                self._partitions[part.id] = part
                for node in part.nodes:
                    if node.id in self._nodes:
                        raise ValueError(f"duplicate node id {node.id!r} in cluster")
                    self._nodes[node.id] = node
        # Fixed node set: cache the canonical order once. Sort by node.id explicitly so the
        # iteration/first-fit order depends only on ids, never on site/partition/node input order
        # (determinism across runtimes and across JSON vs hand-built clusters — see Determinism).
        self._nodes_sorted: list[Node] = sorted(self._nodes.values(), key=lambda n: n.id)

    # --- lookups ---
    @property
    def nodes(self) -> list[Node]:
        """All nodes in a stable order (by id) — the canonical iteration order (cached)."""
        return self._nodes_sorted

    def node(self, node_id: str) -> Node | None:
        return self._nodes.get(node_id)

    @property
    def partitions(self) -> dict[str, Partition]:
        return self._partitions

    @property
    def num_nodes(self) -> int:
        return len(self._nodes)

    def node_seconds_available(self, start: int, end: int) -> int:
        return self.num_nodes * max(0, end - start)

    def _iter_compatible(self, *, partition: str | None, cpus: int, mem: int,
                         gpus: int, tags: tuple[str, ...]):
        """Lazily yield compatible nodes in stable (id) order — so first_fit can stop early."""
        for node in self.nodes:
            if partition is not None and self._partitions[node.partition_id].name != partition:
                continue
            if node.meets(cpus, mem, gpus, tags):
                yield node

    # --- compatibility (partition name + resources + tags) ---
    def compatible_nodes(self, *, partition: str | None, cpus: int, mem: int,
                        gpus: int, tags: tuple[str, ...]) -> list[Node]:
        """Nodes a given job *could* run on, in stable (id) order."""
        return list(self._iter_compatible(partition=partition, cpus=cpus, mem=mem,
                                         gpus=gpus, tags=tags))

    def free_compatible_nodes(self, t: int, *, partition: str | None, cpus: int,
                              mem: int, gpus: int, tags: tuple[str, ...]) -> list[Node]:
        return [
            n for n in self.compatible_nodes(partition=partition, cpus=cpus, mem=mem,
                                             gpus=gpus, tags=tags)
            if n.free_at(t)
        ]

    def first_fit(self, count: int, t: int, duration: int, *, partition: str | None,
                  cpus: int, mem: int, gpus: int, tags: tuple[str, ...]) -> list[Node] | None:
        """First-fit: the `count` lowest-id compatible nodes that stay free for [t, t+duration).

        Returns the nodes, or None if not enough are free for the whole window.
        """
        chosen: list[Node] = []
        for n in self._iter_compatible(partition=partition, cpus=cpus, mem=mem,
                                       gpus=gpus, tags=tags):
            if n.free_for(t, duration):
                chosen.append(n)
                if len(chosen) == count:
                    return chosen
        return None

    def can_host(self, count: int, *, partition: str | None, cpus: int, mem: int,
                 gpus: int, tags: tuple[str, ...]) -> bool:
        """Could ``count`` compatible nodes *ever* host a job (a capacity ceiling, time-agnostic).

        Backfill katas use this to tell "a big job will fit eventually" from "it can never run here",
        so they hold capacity for the former while backfilling short jobs around it.
        """
        seen = 0
        for _n in self._iter_compatible(partition=partition, cpus=cpus, mem=mem,
                                        gpus=gpus, tags=tags):
            seen += 1
            if seen >= count:
                return True
        return False
