# Decision Log

Dated entries, each tagged `[agent decision]`, recording choices a human might want to revisit —
the alternatives considered and why. Newest at the top.

## 2026-09-24 — Console script named `dojo` `[agent decision]`

`uv init` generated a `scheduler-dojo` script pointing at `scheduler_dojo:main`. The brief's layout
(§4) names the command `dojo` (`dojo run`, `dojo score`, …), so the entry point is
`dojo = scheduler_dojo.cli:main` and `main()` lives in `src/scheduler_dojo/cli.py`. The package
`__init__` still re-exports a `main()` for convenience. Alternative: keep the long script name —
rejected, the brief uses `dojo` everywhere.

## 2026-09-24 — Python floor is 3.12, wheel targets Pyodide's minor `[agent decision]`

`requires-python = ">=3.12"`. The wheel is pure `py3-none-any` so it runs on any CPython/Pyodide
that satisfies the floor. If cross-runtime determinism ever diverges we will pin the wheel's
language features to Pyodide's bundled CPython minor (see [[Determinism]]). Alternative: pin `==3.12`
— rejected for now to keep native installs flexible; revisit at Stage 4 if Pyodide's version needs it.

## 2026-09-24 — CI installs drift (public installer) + livedocs (PyPI) `[agent decision]`

`ci.yml` installs the `drift` fingerprinter from `https://drift.fp.dev/install.sh` (public,
installs to `~/.local/bin`) and `livedocs` from PyPI (`uv tool install livedocs`, stdlib-only).
The brief first suggested a git install from `GusEllerm/vault-drift`, but that repo is **private**,
so the Actions runner's token cannot fetch it (`could not read Username … terminal prompts
disabled`). Making it public or adding a PAT secret are account/security changes only a human
should make, so we switched to the public sources instead. Pin a version (drift via `--install-dir`,
livedocs `==<ver>`) if a future release changes the stamp/hash format — note the local dev install is
an editable checkout, so its subcommand surface must stay compatible with the pinned PyPI version.

## 2026-09-24 — Whole-node allocation model `[agent decision]`

A job occupies `nodes_req` **whole** nodes for its runtime; a node hosts at most one running job.
Alternatives: bin-packing over `cpus`/`mem` (rejected — far more machinery, and it hides the exact
pain the ladder teaches: fragmentation from whole-node requests and a big job unable to find enough
whole nodes). Occupancy is stored as `Allocation` intervals `[start,end)` per node rather than a
current-state flag, so `earliest_fit`/backfill/reservations are expressible without a model change.
Resource requests (`cpus_req`/`gpus_req`/`tags`/`partition`) only gate *compatibility*, not sharing.

## 2026-09-24 — Event-loop semantics: batch-per-timestamp, deterministic precedence `[agent decision]`

The loop handles all events at one timestamp (finishes before arrivals before preempts/ticks/drifts)
then runs exactly one decision. Alternatives: interleaving policy calls per event (rejected — more
decisions, noisier). Precedence is the `EventKind` IntEnum value, so freed capacity is available
before new demand. Jobs still running at the horizon are reported unfinished, not force-completed.

## 2026-09-24 — Policy = a callable over `PolicyContext`; built-ins mirror Kata slots `[agent decision]`

The engine calls `policy(ctx)`; the policy calls `ctx.place`. Built-in `fifo`/`shortest_first` are
plain Python that mirror the future Kata `order`+`place` slots, so Kata falls back to exactly them.
Invalid actions raise `PolicyError` (never a crash). Deps are enforced by the *engine*; built-in
policies also pre-check `deps` so a normal run never raises. Alternative: let policies mutate node
state directly — rejected (validation/determinism must live in the engine).

## 2026-09-24 — Scoring metrics measured over all jobs at the horizon `[agent decision]`

`bounded_slowdown`/`wait_p95` cover every submitted job at `run.end_time`, penalizing unfinished
ones, rather than averaging only completed jobs. The adversarial reviewer showed completed-only lets
a run where nothing finishes score ~600 (best slowdown/wait) versus ~0 for a working run. Measured
-at-horizon removes that exploit. Alternative: return `+inf` when nothing completes — rejected as
awkward in the normalizer; the horizon measure is a real, ordered number.

## 2026-09-24 — Perf: prune-on-finish, lazy first-fit, saturated fast-path `[agent decision]`

10k jobs run in ~0.6 s on a provisioned cluster after three fixes: `Node.release` prunes finished
allocations (so `free_for` doesn't rescan history), `first_fit` iterates a lazily-sorted node source
and early-exits at `count`, and `ctx.has_free_node()` lets a place-only policy skip its whole scan
when the cluster is saturated. **Known limit (deferred):** non-blocking FIFO rescanning the whole
queue each decision is `O(decisions × backlog)`; an *over-subscribed* (util > 1) load has an
unbounded backlog and is slow (8k jobs ≈ 32 s). Levels are provisioned to util < 1 so this does not
bite; revisit before Stage 7's endless mode. Alternative: an incrementally maintained per-node free
set — deferred until profiling says it is needed.

## 2026-09-24 — Orchestrator wrote the sim core, not a builder `[agent decision]`

The brief suggested a builder own `events+cluster+jobs`; I wrote the coherence-critical core myself
and delegated the separable `scoring` and `trace` modules instead. Rationale: determinism/coherence
of the event loop is worth more than parallelizing it, and a shared-vocabulary mismatch between
builders would cost more than the speedup. Reviewers (one correctness, one adversarial) still
reviewed the whole Stage-1 diff.
