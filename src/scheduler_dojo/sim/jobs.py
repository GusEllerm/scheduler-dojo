"""Job model: what a job is, how it moves through its states, and what we learn from a run."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class JobState(str, enum.Enum):
    """Lifecycle states. Transitions are driven by the scheduler, never by a policy directly."""

    QUEUED = "queued"        # submitted, waiting (deps may be unsatisfied)
    RUNNING = "running"      # placed on whole nodes, executing
    COMPLETED = "completed"  # finished normally (actual_runtime <= walltime_req)
    TIMEOUT = "timeout"      # killed at walltime_req (actual_runtime > walltime_req)
    # PREEMPTED appears when the preemption slot is unlocked (Stage 8).


# The wall a job may not run past, in integer seconds. Kept out of jobs so callers
# can build a Job without knowing about time: the scheduler computes it.


@dataclass
class Job:
    """A batch job. Whole-node model: a job occupies `nodes_req` whole nodes.

    Fields the policy can see (per the level's sensor unlocks) vs hidden fields are
    enforced by the Kata environment, not here — the engine always has the truth.
    """

    id: str                      # stable id, e.g. "j0007"; the deterministic sort tiebreaker
    user: str
    submit_time: int             # integer-second clock
    nodes_req: int = 1
    walltime_req: int = 3600     # the request (may lie); execution is capped at it
    # Per-node resource request. Defaults accept any node; used by the partitions level.
    cpus_req: int = 1
    mem_req: int = 0
    gpus_req: int = 0
    partition: str | None = None  # required partition name, or None = any
    tags: tuple[str, ...] = ()    # required node tags
    priority: int = 0
    deps: tuple[str, ...] = ()    # job ids that must complete first
    actual_runtime: int = 3600    # hidden from the policy unless `est_runtime` is unlocked
    sla: int | None = None        # must start within sla seconds of submit, if set

    # --- runtime state (mutated by the scheduler) ---
    state: JobState = JobState.QUEUED
    start_time: int | None = None
    end_time: int | None = None
    placed_nodes: tuple[str, ...] = ()
    run_epoch: int = 0        # bumped on every (re)place/preempt; stale FINISH events carry an old epoch
    preempt_count: int = 0    # how many times this job has been preempted (livelock guard signal)

    # Derived quantities used by scoring; None until the job has run.
    @property
    def runtime_used(self) -> int | None:
        if self.start_time is None or self.end_time is None:
            return None
        return self.end_time - self.start_time

    @property
    def wait_time(self) -> int | None:
        if self.start_time is None:
            return None
        return self.start_time - self.submit_time

    @property
    def timed_out(self) -> bool:
        return self.state == JobState.TIMEOUT


@dataclass
class JobResult:
    """The immutable record a completed run carries per job — the scoring input."""

    id: str
    user: str
    submit_time: int
    start_time: int | None
    end_time: int | None
    nodes_req: int
    walltime_req: int
    actual_runtime: int
    runtime_used: int | None
    timed_out: bool
    completed: bool

    @property
    def wait(self) -> int | None:
        if self.start_time is None:
            return None
        return self.start_time - self.submit_time

    @property
    def turnaround(self) -> int | None:
        if self.end_time is None:
            return None
        return self.end_time - self.submit_time

    @classmethod
    def from_job(cls, job: Job) -> JobResult:
        return cls(
            id=job.id,
            user=job.user,
            submit_time=job.submit_time,
            start_time=job.start_time,
            end_time=job.end_time,
            nodes_req=job.nodes_req,
            walltime_req=job.walltime_req,
            actual_runtime=job.actual_runtime,
            runtime_used=job.runtime_used,
            timed_out=job.timed_out,
            completed=job.state in (JobState.COMPLETED, JobState.TIMEOUT),
        )
