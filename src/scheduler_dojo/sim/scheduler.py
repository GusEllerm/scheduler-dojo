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
        # Site must match what `place` enforces (place restricts to run_site or home_site);
        # without it a site-pinned job "fits" somewhere it can never run, and the default
        # policies would attempt a placement that raises instead of skipping the job.
        return c.first_fit(
            job.nodes_req, self.now, runtime_used(job), partition=job.partition,
            cpus=job.cpus_req, mem=job.mem_req, gpus=job.gpus_req, tags=job.tags,
            site=job.run_site or job.home_site,
        ) is not None

    def fits_later(self, job: Job) -> bool:
        """Could ``job`` run at all on this cluster (ignoring *when*) — a capacity ceiling, not a
        time search. Used by backfill katas to hold capacity for a job that does not fit *now*."""
        c = self._sched.cluster
        return c.can_host(job.nodes_req, partition=job.partition, cpus=job.cpus_req,
                          mem=job.mem_req, gpus=job.gpus_req, tags=job.tags)

    def _deps_done(self, job: Job) -> bool:
        return self._sched._deps_done(job)

    def has_free_node(self) -> bool:
        """True if at least one node is unallocated right now — if not, no placement is
        possible and a place-only policy can skip its whole scan."""
        return self._sched.busy_node_slots < self._sched.cluster.num_nodes

    def place(self, job: Job | str, nodes: list[str] | None = None) -> Job:
        return self._sched.place(job, nodes, self.now)

    def preempt(self, job: Job | str) -> Job:
        """Preempt a running job now (free its nodes, requeue it). Requires the `preempt` tier in a kata."""
        return self._sched.preempt(job, self.now)

    def route(self, job: Job | str, site: str) -> Job:
        """Route a queued job to a site (requires the `route` tier)."""
        return self._sched.route(job, site, self.now)

    def transfer_secs(self, job: Job, site: str | None = None) -> int:
        return self._sched.transfer_secs(job, site)


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
                 tick: int | None = None, *, transfer_rate_mbs: float = 0.0,
                 pressure: dict | None = None, trace: int = 0,
                 horizon: int | None = None) -> None:
        self.cluster = cluster
        # MB/s inter-site data movement; 0 means transfer is instantaneous (single-site).
        self.transfer_rate_mbs = transfer_rate_mbs
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
        # Cumulative successful placements (auto + hand): the tutorial's `placed_any`/`first_place`
        # predicate source — a count, not a set size, so it never decreases.
        self.placed_total = 0
        # Ticks only make sense with a horizon (else they self-reschedule forever).
        # The run's horizon: TICK self-reschedules respect it even when a caller drains with
        # `run(until=None)` (the stepping API's step_result), so ticks can never loop forever.
        self.horizon = horizon
        if tick is not None:
            self._events.add(self._t0 + tick, EventKind.TICK, "tick")
        # --- phase two: patience rings + decision trace (both OFF unless declared) ---
        # pressure = {"cap": int, "end_on_overflow": bool} from the level. cap is the slowdown
        # at which a user's patience runs out: a job whose wait reaches cap x its requested
        # runtime overflows the ring (cap=2 ⇒ waited twice as long as you said you'd run).
        self.pressure_cap = int((pressure or {}).get("cap", 2))
        self.pressure_end = bool((pressure or {}).get("end_on_overflow", False))
        self.pressure_on = pressure is not None  # undeclared levels never compute rings (hash-stable)
        self.pressure: dict[str, float] = {}
        self.overflow_user: str | None = None
        # Set when the heap drains or the run ends by pressure; initialized (was only ever read
        # through getattr(...,False)) so `run` can test it directly.
        self._finished = False
        self.overflow_time: int | None = None
        # trace > 0 keeps the last `trace` decision records (a ring buffer); 0 pays nothing.
        self._trace_limit = trace
        self.trace: list[dict] = []
        self._trace_seq = 0
        # reserve() intents mirrored here so the bridge snapshot can draw cones; the scheduler
        # itself never reads them (they are advisory, as in Stage 2).
        self.reservations: dict[str, int] = {}

    # --- phase two: pressure + trace helpers ---
    def _compute_pressure(self) -> None:
        """Per-user patience ring at a batch boundary: the max unfinished job's bounded slowdown
        under the *requested* runtime estimate, normalized so ring = 1.0 is exactly the overflow
        point (wait == (cap-1) x estimate). Fixed user/job order; integer math to the division.
        Only ever computed when a level declares `pressure`, so hash-stability elsewhere is free."""
        cap = self.pressure_cap
        if cap <= 1:
            return  # degenerate: overflow at the first tick — treated as "no rings"
        best: dict[str, int] = {}
        unfinished = sorted(
            (set(self.queued) | set(self.running)),
            key=lambda i: i,
        )
        for jid in unfinished:
            j = self.by_id[jid]
            wait = self.now - j.submit_time
            est = max(1, j.walltime_req)
            # ring fraction: 0 at submit, 1.0 exactly at the overflow point (wait == grace x est)
            grace = max(1, est * (cap - 1))
            frac = 1 if wait >= grace else min(1, wait / grace)
            if frac >= 1.0 and self.overflow_user is None:
                self.overflow_user = j.user
                self.overflow_time = self.now
            if frac > best.get(j.user, -1.0):
                best[j.user] = frac
        self.pressure = {u: best.get(u, 0.0) for u in sorted({j.user for j in self.jobs})}

    def _trace_event(self, action: str, job_id: str, fields: dict | None = None) -> None:
        if self._trace_limit <= 0:
            return
        self._trace_seq += 1
        rec = {"t": self.now, "action": action, "job": job_id, "seq": self._trace_seq}
        if fields:
            rec.update(fields)
        self.trace.append(rec)
        if len(self.trace) > self._trace_limit:
            self.trace.pop(0)


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
        target_site = j.run_site or j.home_site
        if target_site is not None and j.home_site is not None and j.run_site is not None \
                and j.run_site != j.home_site:
            run += self.transfer_secs(j)  # routing off the data's home site adds a transfer delay
        if j.nodes_req < 1:
            raise errors.PolicyError(
                f"job {j.id} requests {j.nodes_req} nodes (must be >= 1)", code=errors.MISMATCH)
        chosen = nodes
        if chosen is None:
            fit = self.cluster.first_fit(
                j.nodes_req, t, run, partition=j.partition, cpus=j.cpus_req,
                mem=j.mem_req, gpus=j.gpus_req, tags=j.tags, site=target_site)
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
        self.placed_total += 1  # every placement — auto or hand — funnels through here
        self.busy_node_slots += len(chosen)
        self._node_seconds_busy += run * len(chosen)
        self._max_end = max(self._max_end, t + run)
        j.state = JobState.RUNNING
        j.start_time = t
        j.placed_nodes = tuple(sorted(chosen))
        j.run_epoch += 1  # invalidates any FINISH from a prior (preempted) placement
        self.queued.discard(j.id)
        self.running[j.id] = j
        self.reservations.pop(j.id, None)
        self._events.add(t + run, EventKind.FINISH, f"{j.id}#{j.run_epoch}")
        self._trace_event("place", j.id, {
            "nodes": sorted(chosen), "end": t + run,
            "transfer": run - runtime_used(j),
            "site": j.run_site or j.home_site or "",
        })
        return j

    def preempt(self, job: Job | str, t: int) -> Job:
        """Preempt a running job: free its nodes now and return it to the queue (no checkpoint — it
        must be re-placed from the start). Invalidates its pending FINISH via `run_epoch`. The engine
        validates the target; a policy uses this only when the `preempt` tier is unlocked."""
        j = self.by_id[job] if isinstance(job, str) else job
        if j.state != JobState.RUNNING:
            raise errors.PolicyError(f"job {j.id} is not running", code=errors.NOT_RUNNING)
        freed = sorted(j.placed_nodes)  # captured for the trace before the epoch wipe
        for nid in j.placed_nodes:
            self.cluster.node(nid).release(j.id)
        self.busy_node_slots -= len(j.placed_nodes)
        self.running.pop(j.id, None)
        j.run_epoch += 1  # its scheduled FINISH event is now stale
        j.state = JobState.QUEUED
        j.start_time = None
        j.placed_nodes = ()
        j.preempt_count += 1
        self.queued.add(j.id)
        self._trace_event("preempt", j.id, {"nodes": freed})
        return j

    def transfer_secs(self, job: Job, site: str | None = None) -> int:
        """Data-transfer delay (s) to run `job` at `site` (default its run_site): ceil(data_mb / rate)
        when the target differs from the data's home site, else 0. 0 rate ⇒ instantaneous."""
        target = site if site is not None else job.run_site
        if not job.data_mb or self.transfer_rate_mbs <= 0:
            return 0
        if target is None or target == job.home_site:
            return 0
        return max(1, -(-job.data_mb // int(self.transfer_rate_mbs)))

    def route(self, job: Job | str, site: str, t: int) -> Job:
        """Route a queued job to run at `site` (Stage-8 multi-site). Records `run_site`; placement then
        restricts to that site's nodes and adds the inter-site data-transfer delay. Unknown site →
        MISMATCH."""
        j = self.by_id[job] if isinstance(job, str) else job
        if site not in self.cluster.sites_by_id():
            raise errors.PolicyError(f"unknown site {site}", code=errors.MISMATCH)
        j.run_site = site
        self._trace_event("route", j.id, {"site": site, "transfer": self.transfer_secs(j, site)})
        return j

    # --- loop ---
    def _handle(self, ev, until: int | None) -> None:
        if ev.kind == EventKind.ARRIVE:
            job = self.by_id[ev.key]
            if job.state == JobState.QUEUED:
                self.queued.add(job.id)
        elif ev.kind == EventKind.FINISH:
            jid, _, epoch = str(ev.key).partition("#")
            job = self.running.get(jid)
            if job is None or (epoch and int(epoch) != job.run_epoch):
                return  # stale FINISH (job was preempted/re-run) — ignore
            self.running.pop(jid)
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
                # Reschedule the *next* boundary strictly after now (a step that ends mid-interval
                # must not kill the heartbeat), bounded by the step's `until` and the run horizon.
                nxt = self.now + self._ticks - ((self.now - self._t0) % self._ticks)
                within = self.horizon is None or self.horizon <= 0 or nxt <= self._t0 + self.horizon
                if within:
                    self._events.add(nxt, EventKind.TICK, "tick")

    def run(self, until: int | None = None, max_events: int = 5_000_000) -> RunResult:
        """Advance the clock to each event time in order, handle the whole batch there, then
        run one decision. `until` is the level horizon (never process an event past it, including
        the first). Raises `DeterminismError` past `max_events` as a hard loop guard."""
        if self._ran:
            raise errors.DeterminismError(
                "Scheduler.run called twice on the same Job/Cluster objects", code="rerun")
        self._ran = True
        # A caller's `until=None` still honors the constructed horizon: the engine never processes
        # events past `t0 + horizon` (a stepped `step_result` drain must truncate exactly where a
        # canonical `run(until=duration)` does, or stepped and full runs hash differently — F1).
        if until is None and self.horizon is not None and self.horizon > 0:
            until = self._t0 + self.horizon
        self._advance(until=until, max_events=max_events)
        if self.overflow_user is not None and self.pressure_end and not self._finished:
            # Patience ran out mid-run *and the level ends on overflow*: the run ends here —
            # do NOT drain the remaining events. (Ring-only levels keep draining: F2 review fix
            # narrowed is_stopped(), so the ending is keyed on the level flag, not that method.)
            self._finished = True
        return self._result()

    def _advance(self, *, until: int | None, max_events: int = 5_000_000,
                 max_batches: int | None = None) -> bool:
        """The single event-loop body. Processes timestamp batches (handle the whole batch, then one
        decision) until the heap empties, the horizon `until` is reached, or `max_batches` batches
        are done. Returns True iff the heap is empty (run finished). Shared by `run`, `step_events`,
        and `run_until` so a stepped run is bit-for-bit identical to a full one."""
        # The engine owns the horizon in EVERY advance path, not just `run` (F1 generalized):
        # `step_events`/`run_until` passing `until=None` must truncate exactly where a canonical
        # run would — stepping past `t0 + horizon` lets pressure (and anything time-bounded)
        # observe events the canonical trajectory never contains.
        if until is None and self.horizon is not None and self.horizon > 0:
            until = self._t0 + self.horizon
        batches = 0
        if self.overflow_user is not None and self.pressure_end:
            # Patience already ran out and the level ends on overflow: the run is over.
            return len(self._events) == 0
        while True:
            t = self._events.peek_time()
            if t is None:
                # Empty heap only means FINISHED when the step horizon cannot hide future events
                # (else a `run_until(t)` with nothing scheduled before t would end the run early).
                if until is None or until >= self._t0 + (self.horizon or 0):
                    self._finished = True
                    return True
                self._advance_clock_to(until)
                return False
            if until is not None and t > until:
                # The clock lands exactly at the step horizon — `now` is an *observed* time, not a
                # decision time; no state reads it between events, so trajectories are unaffected.
                self._advance_clock_to(until)
                return False
            self.now = t
            for ev in self._events.pop_batch():
                self._handle(ev, until)
                self._events_processed += 1
                if self._events_processed > max_events:
                    raise errors.DeterminismError("event budget exhausted", code="event_budget")
            if self.pressure_on:
                self._compute_pressure()
                if self.overflow_user is not None and self.pressure_end:
                    # Patience ran out: the run stops here (jobs unfinished are scored as such).
                    return len(self._events) == 0
            self._safe_policy()
            batches += 1
            if max_batches is not None and batches >= max_batches:
                return False

    def step_events(self, n: int = 1) -> bool:
        """Advance at most `n` event *batches* (a batch = all events at one timestamp + its one
        decision, which is the atomic decision unit). Returns True iff finished."""
        self._require_unfinished()
        return self._advance(until=None, max_batches=n)

    def run_until(self, t: int) -> bool:
        """Advance until the clock would exceed `t`, then stop (returns True iff the run finished).
        The stepping API's time-sliced mode; identical event ordering to a full `run`."""
        self._require_unfinished()
        if isinstance(t, float):  # the clock is integer-seconds by invariant; clamp, never crash
            t = int(t)
        return self._advance(until=t)

    def _advance_clock_to(self, until: int | None) -> None:
        """Move the observed clock up to a step horizon (never past an event, never backwards)."""
        if until is not None and until > self.now and (self.horizon is None or until <= self._t0 + self.horizon):
            self.now = until

    def is_stopped(self) -> bool:
        """True when the run is over: heap drained, or patience ran out *and the level ends on
        overflow*. A ring-only level (`end_on_overflow: false`) keeps running with a full ring —
        `overflow_user` is a display fact there, not an ending (F2 review fix)."""
        return bool(getattr(self, "_finished", False)) or (
            self.overflow_user is not None and self.pressure_end)

    def _require_unfinished(self) -> None:
        if self.is_stopped():
            raise errors.DeterminismError("simulation already finished", code="finished")

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


def idle(ctx: PolicyContext) -> None:
    """Place nothing — the 'do nothing' baseline a hand level starts from, and the calibration
    floor. Jobs queue forever; every cost metric goes to its worst."""
    return None


POLICIES: dict[str, Policy] = {"fifo": fifo, "shortest_first": shortest_first, "idle": idle}
