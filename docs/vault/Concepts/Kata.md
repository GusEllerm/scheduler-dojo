# Kata

> [!abstract] What it is
> A small, safe, deterministic language for writing *scheduling policies*. You fill engine **slots**
> (`order`, `place`, `preempt`, `route`); the engine consults them at decision points and uses a
> built-in default wherever your kata is silent.

## The slot model

A kata is not "a program that runs the scheduler" — the engine runs the scheduler; your kata answers
four questions:

- **order** — in what order should I consider queued jobs? Its body binds `key` per job; the engine
  sorts `queue()` stably by it (tie → job id). One line can teach shortest-job-first.
- **place** — given that order, what do I place now? May `place(job)`, `reserve(job, t)`, backfill.
- **preempt** — whom do I bump? (locked until its level).
- **route** — which site runs a job? (multi-site levels).

Every decision is **visible** (phase two): the engine's `place`/`preempt`/`route` commits emit decision-
trace records, and a kata adds per-decision `order` records (the computed key per queued job) and
`fallback` codes — this is what the booth's why-panel and step mode read. See [[Campus]].

Missing a slot ⇒ the default (FIFO order, first-fit place). This is why a one-module kata still runs.

## Why it is safe to run untrusted

No IO, no imports, no clock, no randomness, no attribute writes, no global mutation (only
`remember`/`recall`, bounded and per-run). A runaway loop dies on the **per-decision step budget** and
the engine silently falls back to FIFO for that decision — so a kata can be *wrong* but never *break
a run*. See [[scheduler_dojo-kata-policy]].

## Why it is deterministic

Every ordered view (`queue`, `running`, `nodes`, `sorted`) has a defined order with a stable tie on
job id; iteration never comes from a set/dict; arithmetic is fixed-order. So the same (kata, level,
seed) replays byte-identically, which is what makes replayable share cards possible. See
[[Determinism]] and [[scheduler_dojo-kata-builtins]].

## Reading

The surface grammar lives in `src/scheduler_dojo/kata/spec.md`. See also [[Concepts/Scoring|Scoring]]
for how a kata's choices turn into a score.
