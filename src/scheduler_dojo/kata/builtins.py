"""Kata builtins and the runtime ``Env`` — the only bridge between a kata program and the engine.

The `Env` wraps a live `sim.scheduler.PolicyContext` (the cluster is taken from
``ctx._sched.cluster``), the level's enabled-name set (`unlocked`), a per-run `memory` dict
(the `remember`/`recall` store) and a per-decision `steps` counter. Every builtin call steps the
counter; exhausting `step_budget` raises `StepBudgetError` (spec §5).

Tier gating (spec §6): a builtin whose tier is not in `unlocked` raises
``EngineError(code="slot_locked")`` when called; a sensor-gated *field* raises
``EngineError(code="sensor_locked")``. Tier names double as unlock names ("reserve",
"fairness", "sensor", "preempt", "route", "remember"), and individual builtin names may be
unlocked one by one as well.

Kata value mapping: nil is Python ``None``; lists/tuples are Python lists/tuples; records are the
opaque `JobRec`/`NodeRec`/`UserRec`/`SiteRec` wrappers below; name-typed fields (user, partition,
state, id, name) come back as `NameVal`, the restricted "string" of spec §4 — equality-comparable
(only against another name or nil), never storable or arithmetic-able.

Documented simplifications (Stage 2):
* ``reserve(job, t)`` does NOT touch the cluster timeline — a real reservation would block the
  job's own nodes from a later legal ``place`` (the engine has no reservation->commit step yet).
  It records the intended start in a per-decision dict that ``reservation_start`` reads back, so
  the backfill pattern of spec §1 works unchanged.
* ``earliest_fit(job)`` is a deterministic first-fit scan over candidate times (now plus every
  future allocation end on compatible nodes); if none admits the job it returns now + the run
  length (deterministic, never a guess of "unknown").
* ``preempt``/``route`` tier builtins are locked stubs until their levels land (Stages 7-8).
"""

from __future__ import annotations

from scheduler_dojo.kata.errors import EngineError, PolicyError
from scheduler_dojo.sim import errors as sim_errors
from scheduler_dojo.sim.scheduler import runtime_used

# --- tiers: builtin name -> tier ("core" is always enabled) --------------------
TIERS: dict[str, str] = {
    # core
    "queue": "core", "running": "core", "now": "core", "nodes": "core",
    "free_nodes": "core", "fits_now": "core", "place": "core",
    "end_if_started_now": "core", "has_tag": "core",
    "first": "core", "rest": "core", "len": "core", "min": "core", "max": "core",
    "sum": "core", "sorted": "core", "any": "core", "all": "core", "abs": "core",
    "if": "core",
    # reserve (levels 3+)
    "earliest_fit": "reserve", "reserve": "reserve", "reservation_start": "reserve",
    # fairness (levels 5+)
    "user_usage": "fairness", "user_share": "fairness",
    # sensor (level 4+)
    "est_runtime": "sensor",
    # preempt (level 7+)
    "preempt": "preempt",
    # route (level 8+)
    "route": "route", "transfer_cost": "route", "sites": "route",
    "current_site": "route",
    # remember (per-run memory; spec §3)
    "recall": "remember",
}

# --- arity: builtin name -> (min_positional, max_positional or None = variadic) -
ARITY: dict[str, tuple] = {
    "queue": (0, 0), "running": (0, 0), "now": (0, 0), "nodes": (0, 0),
    "free_nodes": (0, 0), "fits_now": (1, 1), "place": (1, 2),
    "end_if_started_now": (1, 1), "has_tag": (2, 2),
    "first": (1, 1), "rest": (1, 1), "len": (1, 1), "sum": (1, 1),
    "any": (1, 1), "all": (1, 1), "abs": (1, 1), "if": (3, 3),
    "min": (1, None), "max": (1, None), "sorted": (1, 2),
    "earliest_fit": (1, 1), "reserve": (2, 2), "reservation_start": (1, 1),
    "user_usage": (1, 1), "user_share": (1, 1), "est_runtime": (1, 1),
    "preempt": (1, 1), "route": (2, 2), "transfer_cost": (2, 2),
    "sites": (0, 0), "current_site": (0, 0), "recall": (1, 1),
}


# --- kata value helpers --------------------------------------------------------

class NameVal:
    """A *name* (the restricted string of spec §4): comparable with ==/!= against another
    name or nil only; any other use (arithmetic, storage, ordering) is a `type` error."""

    __slots__ = ("value",)

    def __init__(self, value: str) -> None:
        self.value = value

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<name {self.value!r}>"


def sortable(v):
    """Coerce a kata value into something Python can sort with (used for sort keys)."""
    if isinstance(v, NameVal):
        return str(v.value)
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (list, tuple)):
        return tuple(sortable(x) for x in v)
    return v


class JobRec:
    __slots__ = ("job",)

    def __init__(self, job) -> None:
        self.job = job

    def __eq__(self, other) -> bool:
        return isinstance(other, JobRec) and self.job is other.job

    def __hash__(self) -> int:
        return hash(("job", id(self.job)))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<job {self.job.id}>"


class NodeRec:
    __slots__ = ("node",)

    def __init__(self, node) -> None:
        self.node = node

    def __eq__(self, other) -> bool:
        return isinstance(other, NodeRec) and self.node is other.node

    def __hash__(self) -> int:
        return hash(("node", id(self.node)))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<node {self.node.id}>"


class UserRec:
    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name

    def __eq__(self, other) -> bool:
        return isinstance(other, UserRec) and self.name == other.name

    def __hash__(self) -> int:
        return hash(("user", self.name))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<user {self.name}>"


class SiteRec:
    __slots__ = ("site",)

    def __init__(self, site) -> None:
        self.site = site

    def __eq__(self, other) -> bool:
        return isinstance(other, SiteRec) and self.site is other.site

    def __hash__(self) -> int:
        return hash(("site", id(self.site)))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<site {self.site.id}>"


class TupleRec:
    """A job's tag set, exposed as a read-only list of names."""

    __slots__ = ("items",)

    def __init__(self, items: tuple) -> None:
        self.items = items

    def __repr__(self) -> str:  # pragma: no cover
        return f"<names {self.items!r}>"


# --- the environment -----------------------------------------------------------

class Env:
    """Per-decision kata environment: engine views, builtins, gating and step counter."""

    def __init__(self, ctx, *, unlocked=frozenset(), step_budget: int = 20000,
                 memory: dict | None = None) -> None:
        self.ctx = ctx
        self.cluster = ctx._sched.cluster
        self.unlocked = frozenset(unlocked)
        self.step_budget = step_budget
        self.steps = 0
        # `memory` is the per-RUN store (shared across decisions by KataPolicy); an Env that
        # is handed none gets a private one (per-decision).
        self.memory = memory if memory is not None else {}
        # Per-decision intended starts recorded by reserve() (see module docstring).
        self.reservations: dict[str, int] = {}
        self._queue_key = None  # optional callable Job -> sortable (set by KataPolicy)

    # --- stepping --------------------------------------------------------------
    def step(self, line: int = 0) -> None:
        self.steps += 1
        if self.steps > self.step_budget:
            raise StepBudget_.error(line, self.step_budget)

    @property
    def now(self) -> int:
        return self.ctx.now

    # --- gating ----------------------------------------------------------------
    def enabled(self, name: str) -> bool:
        tier = TIERS.get(name, "core")
        return tier == "core" or name in self.unlocked or tier in self.unlocked

    def enabled_tier(self, tier: str) -> bool:
        return tier in self.unlocked

    def check_builtin(self, name: str, nargs: int, line: int) -> None:
        if name not in ARITY:
            raise EngineError(f"no builtin named '{name}'", code="no_such_builtin", line=line)
        if not self.enabled(name):
            raise EngineError(f"'{name}' is not unlocked at this level",
                              code="slot_locked", line=line)
        lo, hi = ARITY[name]
        if nargs < lo or (hi is not None and nargs > hi) or (hi is None and nargs == 0):
            hi_txt = "more" if hi is None else str(hi)
            raise EngineError(f"'{name}' takes {lo}..{hi_txt} args, got {nargs}",
                              code="arity", line=line)

    def knows(self, name: str) -> bool:
        return name in ARITY

    # --- ordering hook (spec §3: the order slot contract) ------------------------
    def set_queue_order(self, key_fn) -> None:
        """Install the sort key `queue()` must honour (stable; ties keep id order)."""
        self._queue_key = key_fn

    def queue_jobs(self) -> list:
        """The queued Jobs (unwrapped) in the decision's chosen order."""
        jobs = self.ctx.queued  # already id-ordered (deterministic base)
        if self._queue_key is not None:
            key = self._queue_key
            jobs = sorted(jobs, key=key)  # stable -> ties keep id order
        return jobs

    # --- builtin dispatch (interp has already checked tier/arity) ----------------
    _METHODS = {
        "queue": "bi_queue", "running": "bi_running", "now": "bi_now", "nodes": "bi_nodes",
        "free_nodes": "bi_free_nodes", "fits_now": "bi_fits_now", "place": "bi_place",
        "end_if_started_now": "bi_end_if_started_now", "has_tag": "bi_has_tag",
        "first": "bi_first", "rest": "bi_rest", "len": "bi_len", "min": "bi_min",
        "max": "bi_max", "sum": "bi_sum", "sorted": "bi_sorted", "any": "bi_any",
        "all": "bi_all", "abs": "bi_abs", "if": "bi_if",
        "earliest_fit": "bi_earliest_fit", "reserve": "bi_reserve",
        "reservation_start": "bi_reservation_start",
        "user_usage": "bi_user_usage", "user_share": "bi_user_share",
        "est_runtime": "bi_est_runtime", "preempt": "bi_preempt",
        "route": "bi_route", "transfer_cost": "bi_transfer_cost", "sites": "bi_sites",
        "current_site": "bi_current_site", "recall": "bi_recall",
    }

    def invoke(self, name: str, args: list, kwargs: dict):
        meth = getattr(self, self._METHODS[name])
        return meth(*args, **kwargs)

    # --- core builtins -----------------------------------------------------------
    def bi_queue(self):
        return [JobRec(j) for j in self.queue_jobs()]

    def bi_running(self):
        return [JobRec(j) for j in self.ctx.running]

    def bi_now(self):
        return self.ctx.now

    def bi_nodes(self):
        return [NodeRec(n) for n in self.cluster.nodes]

    def bi_free_nodes(self):
        return [NodeRec(n) for n in self.cluster.nodes if n.free_at(self.now)]

    def bi_fits_now(self, job):
        return bool(self.ctx.fits_now(_job_of(job)))

    def bi_place(self, job, nodes=None):
        j = _job_of(job)
        chosen = None
        if nodes is not None:
            items = _as_list(nodes, "place")
            chosen = []
            for n in items:
                if isinstance(n, NodeRec):
                    chosen.append(n.node.id)
                elif isinstance(n, NameVal):
                    chosen.append(str(n.value))
                else:
                    raise _type("place(job, nodes) needs a list of nodes", None)
        return JobRec(self.ctx.place(j, chosen))

    def bi_end_if_started_now(self, job):
        return self.now + runtime_used(_job_of(job))

    def bi_has_tag(self, rec, tag):
        if isinstance(rec, JobRec):
            tags = rec.job.tags
        elif isinstance(rec, NodeRec):
            tags = rec.node.tags
        else:
            raise _type("has_tag needs a job or node", None)
        want = tag.value if isinstance(tag, NameVal) else tag
        return want in list(tags)

    def bi_first(self, xs):
        items = _as_list(xs, "first")
        return items[0] if items else None

    def bi_rest(self, xs):
        items = _as_list(xs, "first")
        return list(items[1:])

    def bi_len(self, xs):
        return len(_as_list(xs, "len"))

    def bi_min(self, *args):
        return _extreme(args, "min", want_low=True)

    def bi_max(self, *args):
        return _extreme(args, "max", want_low=False)

    def bi_sum(self, xs):
        items = _as_list(xs, "sum")
        total: int | float = 0
        for x in items:
            if not isinstance(x, (int, float)) or isinstance(x, NameVal):
                raise _type("sum needs numbers", None)
            total += x
        return total

    def bi_sorted(self, xs, key=None, key_fn=None):
        # Simple form (no user-def callbacks): the interp handles `key=` def calls itself.
        items = list(_as_list(xs, "sorted"))
        if key_fn is not None:
            pairs = [(sortable(key_fn(x)), x) for x in items]
        elif key is not None and isinstance(key, (int, float, NameVal)):
            pairs = [(sortable(key), x) for x in items]
        else:
            pairs = [(sortable(x), x) for x in items]
        pairs.sort(key=lambda p: p[0])
        return [x for _, x in pairs]

    def bi_any(self, xs):
        return any(truth(x) for x in _as_list(xs, "any"))

    def bi_all(self, xs):
        return all(truth(x) for x in _as_list(xs, "all"))

    def bi_abs(self, x):
        _num(x, "abs")
        return abs(x)

    def bi_if(self, cond, a, b):
        return a if truth(cond) else b

    # --- remember / recall ---------------------------------------------------------
    def remember(self, name: str, value, line: int = 0) -> None:
        if not self.enabled_tier("remember") and "remember" not in self.unlocked:
            raise EngineError("remember is not unlocked at this level",
                              code="slot_locked", line=line)
        self.memory[name] = value

    def bi_recall(self, name):
        if not (self.enabled_tier("remember") or "recall" in self.unlocked):
            raise EngineError("recall is not unlocked at this level",
                              code="slot_locked", line=0)
        key = name.value if isinstance(name, NameVal) else name
        if not isinstance(key, str):
            raise _type("recall needs a name", None)
        return self.memory.get(key, None)

    # --- reserve tier ---------------------------------------------------------------
    def bi_earliest_fit(self, job):
        j = _job_of(job)
        run = runtime_used(j)
        compat = self.cluster.compatible_nodes(
            partition=j.partition, cpus=j.cpus_req, mem=j.mem_req,
            gpus=j.gpus_req, tags=j.tags)
        if len(compat) < j.nodes_req:
            raise PolicyError(f"job {j.id} can never fit: only {len(compat)} compatible nodes",
                              code=sim_errors.NO_NODES)
        cands = {self.now}
        for n in compat:
            cands.update(a.end for a in n.allocations if a.end > self.now)
        for t in sorted(cands):
            if self.cluster.first_fit(j.nodes_req, t, run, partition=j.partition,
                                      cpus=j.cpus_req, mem=j.mem_req,
                                      gpus=j.gpus_req, tags=j.tags) is not None:
                return t
        # No candidate admitted it within the visible timeline — deterministic fallback.
        return self.now + max(1, run)

    def bi_reserve(self, job, t):
        j = _job_of(job)
        if not isinstance(t, (int, float)) or isinstance(t, NameVal):
            raise _type("reserve needs an integer time", None)
        if t < self.now:
            raise PolicyError("cannot reserve in the past", code=sim_errors.PAST_TIME)
        # Simplification (Stage 2): record the intent, do not touch the node timeline.
        self.reservations[j.id] = int(t)
        return None

    def bi_reservation_start(self, job):
        j = _job_of(job)
        t = self.reservations.get(j.id, None)
        return None if t is None else int(t)

    # --- fairness tier ---------------------------------------------------------------
    def _usage_by_user(self) -> dict[str, int]:
        sched = self.ctx._sched
        usage: dict[str, int] = {}
        for j in sorted(sched.jobs, key=lambda x: x.id):  # deterministic walk
            if j.start_time is None:
                continue
            end = j.end_time if j.end_time is not None else self.now
            delivered = max(0, min(end, self.now) - j.start_time) * j.nodes_req
            usage[j.user] = usage.get(j.user, 0) + delivered
        return usage

    def bi_user_usage(self, user):
        return self._usage_by_user().get(_user_name(user), 0)

    def bi_user_share(self, user):
        usage = self._usage_by_user()
        total = sum(usage.values())
        if total <= 0:
            return 0.0
        return float(usage.get(_user_name(user), 0)) / float(total)

    # --- sensor tier -----------------------------------------------------------------
    def bi_est_runtime(self, job):
        return _job_of(job).walltime_req

    # --- preempt / route tiers (stubs until their levels land) -------------------------
    def bi_preempt(self, job):
        raise PolicyError("preemption lands in a later level", code="slot_locked")

    def bi_route(self, job, site):
        raise PolicyError("multi-site routing lands in a later level", code="slot_locked")

    def bi_transfer_cost(self, job, site):
        return 0  # single-site: every transfer is free

    def bi_sites(self):
        return [SiteRec(s) for s in self.cluster.sites]

    def bi_current_site(self):
        return SiteRec(self.cluster.sites[0])

    # --- record field access -------------------------------------------------------------
    def getattr(self, base, attr: str, line: int = 0):
        if isinstance(base, JobRec):
            return self._job_field(base, attr, line)
        if isinstance(base, NodeRec):
            return self._node_field(base, attr, line)
        if isinstance(base, UserRec):
            if attr == "name":
                return NameVal(base.name)
            raise _no_field(attr, line)
        if isinstance(base, SiteRec):
            if attr in ("id", "name"):
                return NameVal(getattr(base.site, attr))
            raise _no_field(attr, line)
        if isinstance(base, TupleRec):
            raise _type("tags are a list of names; use has_tag(...) instead", line)
        raise _type(f"cannot read .{attr} of that value", line)

    def _sensor_ok(self, name: str, line: int) -> None:
        if not (self.enabled_tier("sensor") or name in self.unlocked):
            raise EngineError(f".{name} is hidden at this level",
                              code="sensor_locked", line=line)

    def _job_field(self, rec: JobRec, attr: str, line: int):
        j = rec.job
        if attr == "id":
            return NameVal(str(j.id))
        if attr == "user":
            return NameVal(str(j.user))
        if attr in ("submit_time", "nodes_req", "walltime_req", "priority"):
            return int(getattr(j, attr))
        if attr == "state":
            return NameVal(j.state.value)
        if attr == "partition":
            return None if j.partition is None else NameVal(str(j.partition))
        if attr == "tags":
            return TupleRec(tuple(j.tags))
        if attr == "sla":
            return None if j.sla is None else int(j.sla)
        if attr in ("actual_runtime", "est_runtime"):
            self._sensor_ok(attr, line)
            return int(j.actual_runtime) if attr == "actual_runtime" else int(j.walltime_req)
        if attr in ("deps", "cpus_req", "mem_req", "gpus_req"):
            return int(getattr(j, attr)) if attr != "deps" else TupleRec(tuple(j.deps))
        raise _no_field(attr, line)

    def _node_field(self, rec: NodeRec, attr: str, line: int):
        n = rec.node
        if attr in ("id", "name"):
            return NameVal(str(getattr(n, attr)))
        if attr in ("cpus", "mem", "gpus"):
            return int(getattr(n, attr))
        if attr == "partition":
            part = self.cluster.partitions.get(n.partition_id)
            return None if part is None else NameVal(str(part.name))
        if attr == "tags":
            return TupleRec(tuple(n.tags))
        if attr == "free":
            return bool(n.free_at(self.now))
        raise _no_field(attr, line)


# --- helpers -------------------------------------------------------------------

class StepBudget_:
    """Tiny indirection so the raised class reads well at the call site."""

    @staticmethod
    def error(line: int, budget: int):
        from scheduler_dojo.kata.errors import StepBudgetError
        return StepBudgetError(f"your kata ran out of breath on line {line}",
                               code="step_budget", line=line)


def _type(msg: str, line: int | None):
    return EngineError(msg, code="type", line=line)


def _no_field(attr: str, line: int):
    return EngineError(f"no such field .{attr}", code="no_such_field", line=line)


def _num(x, what: str):
    if not isinstance(x, (int, float)) or isinstance(x, NameVal):
        raise _type(f"{what} needs a number", None)
    return x


def _as_list(x, what: str):
    if isinstance(x, (list, tuple)):
        return list(x)
    if isinstance(x, TupleRec):
        return list(x.items)
    raise _type(f"{what} needs a list", None)


def _job_of(x):
    if isinstance(x, JobRec):
        return x.job
    raise _type("expected a job", None)


def _user_name(x) -> str:
    if isinstance(x, NameVal):
        return str(x.value)
    if isinstance(x, UserRec):
        return x.name
    if isinstance(x, JobRec):
        return str(x.job.user)
    if isinstance(x, str):
        return x
    raise _type("expected a user", None)


def truth(x) -> bool:
    """Kata truthiness: nil/false/zero/empty are false, everything else true."""
    if x is None:
        return False
    if isinstance(x, (bool, int, float)):
        return bool(x)
    if isinstance(x, NameVal):
        return True
    if isinstance(x, (list, tuple)):
        return len(x) > 0
    if isinstance(x, TupleRec):
        return len(x.items) > 0
    return True  # records are truthy


def _extreme(args, what: str, *, want_low: bool):
    if len(args) == 1:
        items = _as_list(args[0], what)
    else:
        items = list(args)
    if not items:
        raise EngineError(f"'{what}' needs at least one value", code="arity", line=None)
    best = items[0]
    for x in items[1:]:
        try:
            lt = _plain(x) < _plain(best)
        except TypeError:
            raise _type(f"{what} cannot compare mixed types", None) from None
        if lt if want_low else not lt:
            if _plain(x) == _plain(best):
                continue
            best = x
    return best


def _plain(v):
    return sortable(v)
