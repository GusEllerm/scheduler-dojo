"""`KataPolicy` — a `sim` Policy that runs a parsed kata `ast.Program` at each decision.

Per decision (spec §8):
1. run the `order` module once per queued job (with `job` bound) to build each job's sort key,
   then install that key on the Env so `queue()` yields the chosen order (stable; ties -> id);
2. run the `place` module — or, if absent, the default *first-fit in the current queue order*
   (which is exactly `scheduler.fifo` when no order module moved anything);
3. run `preempt` / `route` only if the module exists AND its tier is unlocked (stubs until
   Stages 7-8).

Any `EngineError` (including `StepBudgetError` and `PolicyError`) raised inside the kata is
caught here: the kata is abandoned **for that decision**, `.fallbacks` increments,
`.last_fallback` records the error code (the UI shows "fell back: <code>"), and the default
FIFO first-fit policy finishes the decision. Exceptions never escape and behaviour is
deterministic.

`remember` memory is per RUN: the same dict is threaded through every decision's Env and is
cleared if the clock ever moves backwards (a new `Scheduler.run` on a reused policy).
"""

from __future__ import annotations

from scheduler_dojo.kata import ast
from scheduler_dojo.kata.builtins import Env, JobRec, sortable
from scheduler_dojo.kata.errors import EngineError
from scheduler_dojo.kata.interp import Interp, run_module

_FIFO_KEY = lambda j: (j.submit_time, j.id)  # noqa: E731 — the default order slot


class KataPolicy:
    """Run a kata program as a scheduler policy; fall back to FIFO first-fit on any error."""

    def __init__(self, program: ast.Program, *, unlocked=frozenset(),
                 step_budget: int = 20000) -> None:
        self.program = program
        self.unlocked = frozenset(unlocked)
        self.step_budget = step_budget
        self.slots = program.slots()
        self.defs = {d.name: d for d in program.defs}
        self.fallbacks = 0
        self.last_fallback: str | None = None
        self.memory: dict = {}
        self._last_now: int | None = None

    # --- the Policy surface ------------------------------------------------------
    def __call__(self, ctx) -> None:
        if self._last_now is not None and ctx.now < self._last_now:
            self.memory.clear()  # a fresh run reuses this policy object
        self._last_now = ctx.now
        env = Env(ctx, unlocked=self.unlocked, step_budget=self.step_budget,
                  memory=self.memory)
        ok = False
        try:
            self._apply_order(ctx, env)
            module = self.slots.get("place")
            if module is not None:
                run_module(module, env, self.defs)
            else:
                self._default_place(env)
            ok = True
        except EngineError as e:
            self._note_fallback(e.code)
        except Exception:  # never crash the engine on a kata bug
            self._note_fallback("internal")
        if not ok:
            self._default_safe(ctx)
        self._run_optional_slots(ctx, env)

    # --- internals ----------------------------------------------------------------
    def _note_fallback(self, code: str) -> None:
        self.fallbacks += 1
        self.last_fallback = code

    def _apply_order(self, ctx, env: Env) -> None:
        """Order-slot contract: run the order body per job; queue() honours the resulting keys."""
        module = self.slots.get("order")
        if module is None:
            env.set_queue_order(_FIFO_KEY)
            return
        interp = Interp(env, self.defs)
        keymap: dict[str, tuple] = {}
        for job in ctx.queued:  # id order; the sort below is stable so ties keep it
            res = interp.run_module(module, scope={"job": JobRec(job)})
            k = res.value if res.value is not None else res.scope.get("key", None)
            if k is None:  # module bound nothing for this job -> FIFO position
                keymap[job.id] = (job.submit_time, job.id)
            else:
                keymap[job.id] = sortable(k)

        def order_key(j):
            return keymap.get(j.id, (j.submit_time, j.id))

        env.set_queue_order(order_key)

    def _default_place(self, env: Env) -> None:
        """Default place slot: first-fit over the queue in its current (or FIFO) order."""
        ctx = env.ctx
        if not ctx.has_free_node():
            return
        for job in env.queue_jobs():
            if ctx._deps_done(job) and ctx.fits_now(job):
                ctx.place(job)

    def _default_safe(self, ctx) -> None:
        env = Env(ctx, unlocked=self.unlocked, step_budget=self.step_budget,
                  memory=self.memory)
        env.set_queue_order(_FIFO_KEY)
        try:
            self._default_place(env)
        except EngineError:
            pass  # the engine already committed what it could; nothing else to do

    def _run_optional_slots(self, ctx, env: Env) -> None:
        for slot, tier in (("preempt", "preempt"), ("route", "route")):
            module = self.slots.get(slot)
            if module is None or not env.enabled_tier(tier):
                continue  # absent module or locked slot -> the default (no-op)
            try:
                run_module(module, env, self.defs)
            except EngineError as e:
                self._note_fallback(e.code)
            except Exception:
                self._note_fallback("internal")
