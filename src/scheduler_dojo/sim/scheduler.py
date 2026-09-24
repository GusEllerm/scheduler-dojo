"""The scheduling loop and built-in policies.

The loop advances an integer clock, processes a batch of events at a time (arrivals
enqueue, finishes complete), and runs the active policy once per decision point. The
policy sees a ``PolicyContext`` and calls ``place``; the engine validates and commits the
placement, allocating whole nodes for the job's run window and scheduling its finish.

Placement is whole-node and interval-based: at ``place`` time the node is marked busy for
``[start, start + runtime_used)`` so ``first_fit``/backfill see future frees without a
separate state machine.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from scheduler_dojo.sim import errors
from scheduler_dojo.sim.cluster import Cluster
from scheduler_dojo.sim.events import EventKind, EventQueue
from scheduler_dojo.sim.jobs import Job, JobResult, JobState

Policy = Callable[["PolicyContext"], None]


def runtime_used(job: Job) -> int:
    """How long a job actually occupies its nodes: the smaller of its true runtime and its
    (possibly over-generous) walltime request. Never zero, so a finish event is always due."""
    return max(1, min(job.actual_runtime, job.walltime_req))


class PolicyContext:
    """The read view + action surface a policy gets at a decision point.

    Views are *live*: after a ``place`` the node occupancy and the running/queued lists
    reflect it immediately, so a policy can place several jobs in one decision.
    """

    def __init__(self, sched: "Scheduler") -> None:
        self._sched = sched

    @property
    def now(self) -> int:
        return self._sched.now

    @property
    def queued(self) -> list[Job]:
        """Jobs submitted and waiting, in stable (id) order."""
        return sorted((self._sched.by_id[i] for i in self._sched.queued), key=lambda j: j.id)

    @property
    def running(self) -> list[Job]:
        return sorted(self._sched.running.values(), key=lambda j: j.id)

    def free_nodes(self) -> list[str]:
        return [n.id for n in self._sched.cluster.nodes if n.free_at(self.now)]

    def fits_now(self, job: Job) -> bool:
        c = self._sched.cluster
        return c.first_fit(
            job.nodes_req, self.now, runtime_used(job), partition=job.partition,
            cpus=job.cpus_req, mem=job.mem_req, gpus=job.gpus_req, tags=job.tags,
        ) is not None

    def _deps_done(self, job: Job) -> bool:
        return self._sched._deps_done(job)

    def has_free_node(self) -> bool:
        """True if at least one node is unallocated right now — if not, no placement is
        possible and a place-only policy can skip its whole scan."""
        return self._sched.busy_node_slots < self._sched.cluster.num_nodes

    def place(self, job: Job | str, nodes: list[str] | None = None) -> Job:
        return self._sched.place(job, nodes, self.now)


@dataclass
class RunResult:
    jobs: list[JobResult] = field(default_factory=list)
    node_seconds_total: int = 0
    node_seconds_busy: int = 0
    end_time: int = 0
    n_jobs: int = 0
    sim_seconds: int = 0  # events processed (approx cost metric)


class Scheduler:
    def __init__(self, cluster: Cluster, jobs: list[Job], policy: Policy,
                 tick: int | None = None) -> None:
        self.cluster = cluster
        if len({j.id for j in jobs}) != len(jobs):
            raise errors.DeterminismError("duplicate job id", code="duplicate_job")
        self.by_id = {j.id: j for j in jobs}
        self.jobs = sorted(jobs, key=lambda j: (j.submit_time, j.id))
        self.policy = policy
        self.now = 0
        self.queued: set[str] = set()      # ids
        self.running: dict[str, Job] = {}
        self.finished: list[Job] = []
        self.busy_node_slots = 0  # sum of nodes_req across running jobs (for a free fast-path)
        self.finished: list[Job] = []
        self._events = EventQueue()
        self._ticks: int | None = tick
        self._ran = False
        # Seed one ARRIVE per job.
        for j in self.jobs:
            self._events.add(j.submit_time, EventKind.ARRIVE, j.id)
        self._events_processed = 0
        self._t0 = min((j.submit_time for j in jobs), default=0)
        # Incremental accounting so _result stays O(1) once finished allocations are pruned.
        self._node_seconds_busy = 0
        self._max_end = 0  # 0 until something actually runs; utilization window uses _t0
        # Ticks only make sense with a horizon (else they self-reschedule forever).
        if tick is not None:
            self._events.add(self._t0 + tick, EventKind.TICK, "tick")

    # --- actions (validated) ---
    def _deps_done(self, job: Job) -> bool:
        for dep in job.deps:
            dj = self.by_id.get(dep)
            if dj is None or dj.state not in (JobState.COMPLETED, JobState.TIMEOUT):
                return False
        return True

    def place(self, job: Job | str, nodes: list[str] | None, t: int) -> Job:
        j = self.by_id[job] if isinstance(job, str) else job
        if j.state == JobState.RUNNING:
            raise errors.PolicyError(
                f"job {j.id} is already running", code=errors.ALREADY_RUNNING)
        if j.id not in self.queued:
            raise errors.PolicyError(
                f"job {j.id} is not queued (unknown or already dispatched)",
                code=errors.UNKNOWN_JOB)
        if j.deps and not all(
            self.by_id.get(d) is not None
            and self.by_id[d].state in (JobState.COMPLETED, JobState.TIMEOUT)
            for d in j.deps
        ):
            raise errors.PolicyError(f"job {j.id} has unmet dependencies", code=errors.DEPS_UNMET)

        run = runtime_used(j)
        if j.nodes_req < 1:
            raise errors.PolicyError(
                f"job {j.id} requests {j.nodes_req} nodes (must be >= 1)", code=errors.MISMATCH)
        chosen = nodes
        if chosen is None:
            fit = self.cluster.first_fit(
                j.nodes_req, t, run, partition=j.partition, cpus=j.cpus_req,
                mem=j.mem_req, gpus=j.gpus_req, tags=j.tags)
            if fit is None:
                raise errors.PolicyError(
                    f"job {j.id} does not fit now", code=errors.NO_NODES)
            chosen = [n.id for n in fit]
        else:
            if len(set(chosen)) != len(chosen):
                raise errors.PolicyError(
                    f"job {j.id} lists duplicate nodes", code=errors.MISMATCH)
            if len(chosen) != j.nodes_req:
                raise errors.PolicyError(
                    f"job {j.id} needs {j.nodes_req} nodes, got {len(chosen)}",
                    code=errors.MISMATCH)
            for nid in chosen:
                node = self.cluster.node(nid)
                if node is None:
                    raise errors.PolicyError(f"unknown node {nid}", code=errors.UNKNOWN_JOB)
                part = self.cluster.partitions[node.partition_id]
                if j.partition is not None and part.name != j.partition:
                    raise errors.PolicyError(
                        f"node {nid} is not in partition {j.partition}", code=errors.MISMATCH)
                if not node.meets(j.cpus_req, j.mem_req, j.gpus_req, j.tags):
                    raise errors.PolicyError(
                        f"node {nid} cannot satisfy job {j.id}'s resources", code=errors.MISMATCH)
                if not node.free_for(t, run):
                    raise errors.PolicyError(
                        f"node {nid} is not free for job {j.id}'s window", code=errors.NO_NODES)

        # Commit.
        for nid in chosen:
            self.cluster.node(nid).allocate(t, t + run, j.id)
        self.busy_node_slots += len(chosen)
        self._node_seconds_busy += run * len(chosen)
        self._max_end = max(self._max_end, t + run)
        j.state = JobState.RUNNING
        j.start_time = t
        j.placed_nodes = tuple(sorted(chosen))
        self.queued.discard(j.id)
        self.running[j.id] = j
        self._events.add(t + run, EventKind.FINISH, j.id)
        return j

    # --- loop ---
    def _handle(self, ev, until: int | None) -> None:
        if ev.kind == EventKind.ARRIVE:
            job = self.by_id[ev.key]
            if job.state == JobState.QUEUED:
                self.queued.add(job.id)
        elif ev.kind == EventKind.FINISH:
            job = self.running.pop(ev.key)
            job.end_time = self.now
            job.state = (
                JobState.TIMEOUT if job.actual_runtime > job.walltime_req
                else JobState.COMPLETED
            )
            for nid in job.placed_nodes:
                self.cluster.node(nid).release(job.id)
            self.busy_node_slots -= len(job.placed_nodes)
            self.finished.append(job)
        elif ev.kind == EventKind.TICK:
            if self._ticks is not None:
                nxt = self.now + self._ticks
                if until is None or nxt <= until:
                    self._events.add(nxt, EventKind.TICK, "tick")

    def run(self, until: int | None = None, max_events: int = 5_000_000) -> RunResult:
        """Advance the clock to each event time in order, handle the whole batch there, then
        run one decision. `until` is the level horizon (never process an event past it, including
        the first). Raises `DeterminismError` past `max_events` as a hard loop guard."""
        if self._ran:
            raise errors.DeterminismError(
                "Scheduler.run called twice on the same Job/Cluster objects", code="rerun")
        self._ran = True
        while True:
            t = self._events.peek_time()
            if t is None:
                break
            if until is not None and t > until:
                break
            self.now = t
            for ev in self._events.pop_batch():
                self._handle(ev, until)
                self._events_processed += 1
                if self._events_processed > max_events:
                    raise errors.DeterminismError("event budget exhausted", code="event_budget")
            self._safe_policy()
        return self._result()

    def _safe_policy(self) -> None:
        # Built-in policies cannot raise; the kata driver catches StepBudgetError here and
        # falls back to the default. Kept as a seam.
        self.policy(PolicyContext(self))

    def _result(self) -> RunResult:
        results = [JobResult.from_job(j) for j in sorted(self.jobs, key=lambda x: x.id)]
        # Use the incremental counters, not the (pruned) allocation lists.
        end = self._max_end
        return RunResult(
            jobs=results,
            node_seconds_busy=self._node_seconds_busy,
            node_seconds_total=self.cluster.num_nodes * max(0, end - self._t0),
            end_time=end,
            n_jobs=len(self.jobs),
            sim_seconds=self._events_processed,
        )


# --- built-in policies (plain Python; these are Kata's fallback defaults) ---

def fifo(ctx: PolicyContext) -> None:
    """First-come-first-served, first-fit: start queued jobs by submit order. Skips jobs whose
    deps are unmet (the engine would reject them) and exits early when no node is free."""
    if not ctx.has_free_node():
        return
    for job in sorted(ctx.queued, key=lambda j: (j.submit_time, j.id)):
        if ctx._deps_done(job) and ctx.fits_now(job):
            ctx.place(job)


def shortest_first(ctx: PolicyContext) -> None:
    """Shortest walltime request first, first-fit. Ties broken by submit order."""
    if not ctx.has_free_node():
        return
    for job in sorted(ctx.queued, key=lambda j: (j.walltime_req, j.submit_time, j.id)):
        if ctx._deps_done(job) and ctx.fits_now(job):
            ctx.place(job)


POLICIES: dict[str, Policy] = {"fifo": fifo, "shortest_first": shortest_first}
