"""Raw run metrics and the normalized 0..1000 score (PROMPT 4.2).

Pure functions over a ``RunResult``: no IO, no randomness, no wall clock, no cluster mutation.

Raw metrics (over *terminal* jobs — ``completed`` with both ``start_time`` and ``end_time``
set, which includes jobs killed at walltime), always summed in **job-id order** and with users
walked in **sorted-name order**, per ``docs/vault/Concepts/Determinism.md``:

* ``utilization``      = busy node-seconds / available node-seconds
* ``bounded_slowdown`` = mean of ``max(wait + run, 10) / max(run, 10)``
* ``wait_p95``         = 95th percentile of ``wait`` by nearest rank
* ``fairness``         = Jain's index of ``delivered_share / entitled_share`` across users
* ``sla``              = fraction of SLA-bearing jobs that started inside their SLA
                         (only computable from ``Job`` objects — ``JobResult`` drops ``sla``)

Score formula (cite this in ``docs/vault/Concepts/Scoring.md``):

    normalize(name, value, anchor):
        b = anchor["baseline"]; r = anchor["reference"]
        if r == b:                      -> 0.0
        anchor["higher_better"]:        -> (value - b) / (r - b)
        else (lower is better):         -> (b - value) / (b - r)
    # no clamping inside normalize — a level may legitimately score above/below the anchors

    members = sorted(m for m in metrics if m in weights)      # metrics actually present
    blend   = sum(weights[m] * normalize(m, metrics[m], anchors[m]) for m in members)
              / sum(weights[m] for m in members)              # weights renormalized to 1
              = 0.0 when there are no members or their weight sum is 0

    score   = clamp(round(300 + 500 * blend), 0, 1000)        # returned as int

By construction a run that only matches the level's ``baseline`` anchors (plain FIFO) scores
300 and one matching the ``reference`` anchors scores 800; anything past the reference keeps
scaling linearly until the 0..1000 clamp.
"""

from __future__ import annotations

import math

from scheduler_dojo.sim.cluster import Cluster
from scheduler_dojo.sim.jobs import Job, JobResult
from scheduler_dojo.sim.scheduler import RunResult

#: The bounded-slowdown floor, in seconds: waits/runs below it are not punished (PROMPT 4.2).
SLOWDOWN_FLOOR = 10.0
#: The percentile ``wait_p95`` reports.
P95 = 0.95
#: Metric names the scorer knows about (``energy``/``transfer`` come with later levels).
METRICS = ("utilization", "bounded_slowdown", "wait_p95", "fairness", "sla")


def _run_of(job: JobResult) -> int:
    """Node-occupying runtime: the recorded ``runtime_used``, or ``end - start`` if unset."""
    if job.runtime_used is not None:
        return job.runtime_used
    if job.start_time is not None and job.end_time is not None:
        return job.end_time - job.start_time
    return 0


def completed_jobs(run: RunResult) -> list[JobResult]:
    """Terminal jobs (completed or timed out, both having run), in job-id order."""
    return sorted(
        (
            j
            for j in run.jobs
            if j.completed and j.start_time is not None and j.end_time is not None
        ),
        key=lambda j: j.id,
    )


def _peak_nodes(jobs: list[JobResult]) -> int:
    """The minimum number of nodes the observed schedule needed (peak concurrent demand).

    Sweep of interval endpoints, ends before starts at the same instant so back-to-back
    placements do not double count. Deterministic: the event list is explicitly sorted.
    """
    events: list[tuple[int, int, int]] = []
    for j in jobs:
        events.append((j.start_time, 1, j.nodes_req))          # type: ignore[arg-type]
        events.append((j.end_time, 0, -j.nodes_req))          # type: ignore[arg-type]
    events.sort()  # (time, end-before-start, delta)
    cur = peak = 0
    for _, _, delta in events:
        cur += delta
        peak = max(peak, cur)
    return max(peak, 0)


def _node_count(
    done: list[JobResult], jobs: list[Job] | None, cluster: Cluster | None
) -> int:
    """How many nodes the available-node-seconds denominator should count.

    Precedence: the cluster's real ``num_nodes`` when one is supplied; else the number of
    *distinct* nodes the run actually touched (``Job.placed_nodes``, materialised through a
    sorted list); else the peak concurrent demand the schedule shows. Every choice is a valid
    upper bound on the busy rate, so ``utilization`` stays <= 1 without inventing a cluster size.
    """
    if cluster is not None:
        return max(int(cluster.num_nodes), 1)
    if jobs:
        touched = sorted({n for j in jobs for n in j.placed_nodes})
        if touched:
            return len(touched)
    return max(_peak_nodes(done), 1)


def _fallback_node_seconds(
    done: list[JobResult], run: RunResult, jobs: list[Job] | None, cluster: Cluster | None
) -> int:
    """Available node-seconds when ``run.node_seconds_total`` is not populated.

    ``nodes * (run.end_time - min submit_time)``, with ``nodes`` from ``_node_count``.
    """
    if run.end_time <= 0 or not done:
        return 0
    start = min(j.submit_time for j in done)
    window = max(0, run.end_time - start)
    return _node_count(done, jobs, cluster) * window


def utilization(
    run: RunResult, jobs: list[Job] | None = None, *, cluster: Cluster | None = None
) -> float:
    """Busy node-seconds over available node-seconds; 0.0 when nothing was available.

    Prefers ``run.node_seconds_busy`` / ``run.node_seconds_total``. When the total is 0 (the
    scheduler leaves it unset), the numerator becomes ``sum(nodes_req * runtime_used)`` in job-id
    order and the denominator ``_fallback_node_seconds``; pass ``cluster=`` for the exact one.
    """
    done = completed_jobs(run)
    busy = float(run.node_seconds_busy)
    total = float(run.node_seconds_total)
    if busy <= 0.0:
        busy = float(sum(j.nodes_req * _run_of(j) for j in done))
    if total <= 0.0:
        total = float(_fallback_node_seconds(done, run, jobs, cluster))
    if total <= 0.0:
        return 0.0
    return busy / total


def _horizon(run: RunResult) -> int:
    """The time metrics are measured AT: the last finish, never earlier than the last submit.
    A job unfinished at this instant has been waiting/running this long."""
    return max(
        run.end_time,
        max((j.submit_time for j in run.jobs), default=0),
    )


def _wait_at(job: JobResult, horizon: int) -> int:
    """Queue wait at measurement time: to its start, or (never started) the whole horizon."""
    if job.start_time is not None:
        return job.start_time - job.submit_time
    return horizon - job.submit_time


def _turnaround_at(job: JobResult, horizon: int) -> int:
    """Turnaround at measurement time; unfinished jobs are still open at the horizon."""
    if job.end_time is not None:
        return job.end_time - job.submit_time
    return horizon - job.submit_time


def bounded_slowdown(run: RunResult) -> float:
    """Mean of ``max(wait + run, 10) / max(run, 10)`` over all submitted jobs (lower is better).

    Measured at the horizon: a job that started measures normally; one still running measures
    with run = (horizon - start); one that never started measures as pure wait. So a run where
    nothing finishes scores *worst*, not best (it must not outscore a run that did work).
    """
    if not run.jobs:
        return 0.0
    horizon = _horizon(run)
    total = 0.0
    for j in sorted(run.jobs, key=lambda j: j.id):
        wait = float(_wait_at(j, horizon))
        if j.start_time is not None and j.end_time is None:      # still running at horizon
            total += float(horizon - j.submit_time) / max(horizon - j.start_time, SLOWDOWN_FLOOR)
            continue
        run_s = float(_run_of(j))
        total += max(wait + run_s, SLOWDOWN_FLOOR) / max(run_s, SLOWDOWN_FLOOR)
    return total / len(run.jobs)


def _nearest_rank(values: list[float], q: float = P95) -> float:
    """Nearest-rank percentile of an ascending-sorted list: index ``ceil(q*N) - 1`` clamped."""
    n = len(values)
    if n == 0:
        return 0.0
    # The epsilon keeps a binary-float product like 0.95*20 (19.000000000000004) from
    # rounding up to rank 20; it never moves a genuinely fractional rank.
    rank = math.ceil(q * n - 1e-9)
    return float(values[min(max(rank - 1, 0), n - 1)])


def wait_p95(run: RunResult) -> float:
    """95th-percentile queue wait over all submitted jobs, nearest rank; unfinished jobs count
    their wait up to the horizon (so starving a job inflates the metric, as it should)."""
    if not run.jobs:
        return 0.0
    horizon = _horizon(run)
    waits = sorted(float(_wait_at(j, horizon)) for j in run.jobs)
    return _nearest_rank(waits, P95)


def fairness(run: RunResult) -> float:
    """Jain's fairness index of delivered-vs-entitled shares across users.

    ``delivered_i = sum(nodes_req * runtime_used)``, ``entitled_i = sum(nodes_req *
    walltime_req)``; both are normalized to sum to 1 over users, ``x_i = delivered_i /
    entitled_i`` (users with ``entitled_i == 0`` are skipped), then
    ``jain = (sum x_i)^2 / (n * sum x_i^2)``. 1.0 for no jobs, no entitled demand, or no
    delivered demand (no discrimination to measure). Users are summed in sorted-name order.
    """
    done = completed_jobs(run)
    if not done:
        return 1.0
    users = sorted({j.user for j in done})  # materialised to a sorted list before iterating
    delivered: dict[str, float] = dict.fromkeys(users, 0.0)
    entitled: dict[str, float] = dict.fromkeys(users, 0.0)
    for j in done:
        delivered[j.user] += float(j.nodes_req) * float(_run_of(j))
        entitled[j.user] += float(j.nodes_req) * float(j.walltime_req)
    keep = [u for u in users if entitled[u] > 0.0]
    delivered_total = sum(delivered[u] for u in keep)
    entitled_total = sum(entitled[u] for u in keep)
    if not keep or delivered_total <= 0.0 or entitled_total <= 0.0:
        return 1.0
    xs = [(delivered[u] / delivered_total) / (entitled[u] / entitled_total) for u in keep]
    s = sum(xs)
    squares = sum(x * x for x in xs)
    if squares <= 0.0:
        return 1.0
    return (s * s) / (len(xs) * squares)


def sla_from_jobs(jobs: list[Job]) -> float:
    """Fraction of SLA-bearing jobs that started within ``sla`` seconds of submit.

    ``JobResult`` does not carry ``sla``, so this reads the ``Job`` objects; a job with an ``sla``
    that never started counts as missed. 1.0 when no job declares an SLA (nothing to miss).
    Jobs are walked in id order so the count is order-independent anyway.
    """
    with_sla = sorted((j for j in jobs if j.sla is not None), key=lambda j: j.id)
    if not with_sla:
        return 1.0
    met = sum(
        1
        for j in with_sla
        if j.start_time is not None and (j.start_time - j.submit_time) <= j.sla
    )
    return met / len(with_sla)


def metrics_from_run(
    run: RunResult, jobs: list[Job] | None = None, *, cluster: Cluster | None = None
) -> dict[str, float]:
    """The raw metric dict a level scores against.

    ``sla`` is included only when the original ``jobs`` list is passed (``JobResult`` drops the
    field); without it the key is simply absent, so ``score`` skips it. ``jobs`` and ``cluster``
    only ever affect the utilization *denominator*, and only when ``run.node_seconds_total`` is
    unset (the scheduler does not populate it): ``cluster.num_nodes`` is exact, otherwise the
    distinct nodes touched via ``Job.placed_nodes``, otherwise peak concurrent demand.
    """
    out: dict[str, float] = {
        "utilization": utilization(run, jobs, cluster=cluster),
        "bounded_slowdown": bounded_slowdown(run),
        "wait_p95": wait_p95(run),
        "fairness": fairness(run),
    }
    if jobs is not None:
        out["sla"] = sla_from_jobs(jobs)
    return out


def normalize(name: str, value: float, anchor: dict) -> float:
    """Anchor-normalize one metric: 0.0 at ``baseline``, 1.0 at ``reference``, unclamped.

    ``anchor`` = ``{"baseline": b, "reference": r, "higher_better": bool}`` (``higher_better``
    defaults to True). ``r == b`` is a degenerate anchor -> 0.0. ``name`` is not used by the
    transform; it is carried for error messages and per-level metric transforms.
    """
    b = float(anchor.get("baseline", 0.0))
    r = float(anchor.get("reference", 0.0))
    if r == b:
        return 0.0
    if anchor.get("higher_better", True):
        return (float(value) - b) / (r - b)
    return (b - float(value)) / (b - r)


def score(
    metrics: dict[str, float],
    weights: dict[str, float],
    anchors: dict[str, dict],
) -> int:
    """Weighted anchor blend mapped to 0..1000 — see the module docstring for the formula."""
    members = sorted(m for m in metrics if m in weights)
    weight_total = sum(weights[m] for m in members)
    blend = 0.0
    if members and weight_total != 0.0:
        blend = sum(
            weights[m] * normalize(m, metrics[m], anchors.get(m, {})) for m in members
        ) / weight_total
    return int(max(0, min(1000, round(300 + 500 * blend))))
