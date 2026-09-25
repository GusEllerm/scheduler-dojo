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

`ci.yml` installs the `drift` fingerprinter from `https://drift.fp.dev/install.sh` (**pinned to
`v0.10.1`** via `--version`) and `livedocs` from PyPI (`uv tool install livedocs`, stdlib-only).
The brief first suggested a git install from `GusEllerm/vault-drift`, but that repo is **private**,
so the Actions runner's token cannot fetch it (`could not read Username … terminal prompts
disabled`). Making it public or adding a PAT secret are account/security changes only a human
should make, so we switched to the public sources instead.

**Why pin drift + why livedocs is pinned to Python 3.12:** CI initially reported all 12 code-mentioning
notes CHANGED (all *benign*, members unchanged) where a clean local checkout reported fresh — the
totals matched (23 notes, snapshot 6, unknown 5), only fresh→changed differed. `drift` was ruled out
(it recomputes 0/96 non-fresh identically on macOS and Linux). The real cause: `livedocs` computes
`astdiff.member_hash` via `ast.dump`, which is **CPython-minor-version-sensitive** — the same source
hashed `4cf0419e…` on 3.12 vs `04d98fa8…` on 3.13. My stamps were written by a livedocs running on
3.13 while CI ran livedocs on 3.12, so every symbol hash mismatched (but the symbol *signature*
hashed equal → classified benign). Fix: run livedocs on the project's Python (**3.12**) in CI
(`uv tool install --python 3.12 livedocs`) and re-stamp every note under 3.12. drift is also pinned to
`v0.10.1` for hygiene. **Golden rule:** always run `livedocs` (stamping and verifying) under the same
CPython minor the project targets, or the hashes diverge. See [[Determinism]].

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

## 2026-09-24 — Kata fills engine slots; silent slots use defaults `[agent decision]`

Kata is a set of **slot modules** (`order`/`place`/`preempt`/`route`) the `Scheduler` consults at
decision points, not a program that owns the loop. A missing slot falls back to the built-in default
(FIFO order, first-fit place), so a one-line `order by shortest_first:` kata is already a complete,
runnable policy. **Why:** this is the teaching gradient — level 2 is one line, and each level adds a
slot/builtin — and it means the interpreter never has to reimplement placement. The `order` module's
key is applied by `Env.queue()` so the `place` module sees the chosen order for the *same* decision
(no order/place desync). See [[Kata]].

## 2026-09-24 — reserve()/earliest_fit() record intent, don't touch the timeline `[agent decision]`

`reserve(job, t)` validates `t >= now` and stores the intended start in a per-decision dict that
`reservation_start(job)` reads back; it does **not** write a future-dated cluster allocation. A real
reservation would occupy nodes and then block that same job's legal `place()` (the engine has no
reservation→commit step yet), so committing now would break backfill. The spec's `backfill.kata` works
unchanged against the intent model. **Revisit in Stage 3** when levels 3+ make reservations load-bearing
(add an `Allocation` in the future and a commit-on-place path).

## 2026-09-24 — Kata strings: literals only in equality against name-typed fields `[agent decision]`

No general string type (would invite concatenation/prints/IO); but bare comparisons like
`job.partition == "gpu"` are essential to real katas, so STRING literals are admitted **only** on the
`==`/`!=` right side against a `name`/`partition`/`tags` field and are a `type` error everywhere else
(store, arithmetic, non-name compare). Cheapest thing that keeps katas compact without widening the
attack/determinism surface. See `spec.md` §4.

## 2026-09-24 — `check()` lives on the `kata.check` submodule, not the package namespace `[agent decision]`

Python sets a package attribute to a submodule on import, so a package-level `check` **function**
would be shadowed by the `check.py` **module**. The checker is reached via `scheduler_dojo.kata.check`,
and `kata/__init__.py` uses a lazy `importlib`-based `__getattr__` (so the package imports even while a
sibling submodule is mid-build). Same reason `format` (submodule `formatter`) is safe but `check` is not.

## 2026-09-24 — Stage 2 split + adversarial-review outcome `[agent decision]`

Three builders on disjoint files (lexer+parser, interp+builtins+policy, formatter+check); I owned the
contract (`ast.py`, `errors.py`, `spec.md`) and the CLI/level wiring. Adversarial review flagged two
issues: (1) *real* — `dojo kata check <missing-file>` raised a raw traceback, violating "errors are
teaching moments"; fixed to a clean `kata: cannot read …` + exit 2 with a regression test. (2) *false
positive* — a claim that a bare-`Attribute` expression statement formatted to the empty string; it does
round-trip (all `ExprStmt` node types verified to re-parse to an equal AST), so no change. Also fixed
two of my own cross-cutting bugs found while integrating: `EngineError` now stores `self.message` (the
frozen `caret()` needs it) and `run_level`'s source-vs-path detection no longer stats a multi-line
program as a filename (OSError). 158 tests green.

## 2026-09-24 — Levels are fixed-seed puzzles, not seed-averaged `[agent decision]`

Each level carries a single `seed` and calibration solves `score_anchors` **on that seed** so the
`baseline_policy` scores exactly 300 and the `reference_kata` exactly 800. The rejected alternative was
averaging metrics over several seeds: a single play is one seed, and `bounded_slowdown` variance across
seeds is large enough that mean-anchored scores swing 0↔1000 on any one run. A fixed seed makes the
level a deterministic puzzle (same for everyone, replayable from a share card) and pins
`score(baseline)=300`/`score(reference)=800` as exact, goldens-checkable numbers. Calibration is
idempotent (re-run → byte-identical files) and picks the seed where the lesson actually shows. See
[[Levels]].

## 2026-09-24 — Gold is earned: only reference-improved metrics are scored `[agent decision]`

Anchors set at the reference's own values would make `score(reference)=800` *tautological* — true even
if the reference were worse. So calibration Pareto-filters per metric on the level's seed: a metric is
scored only if the reference is **at least as good** as the baseline on it (strictly better on the
`primary_metric`). Consequence: a reference that trades a secondary metric away (shortest-first cuts
slowdown but nudges utilization down) is scored only on what it improves, and a player who also holds
the secondary metric scores above 800. The gold bar is then a real achievement, not an anchor artifact.

## 2026-09-24 — `fits_later(job)`: a capacity ceiling to make backfill honest `[agent decision]`

Level 3's first reference (reserve-based backfill) scored *worse* than FIFO, and calibration rightly
rejected it. Gap-filling needs to tell "this big job will fit eventually" from "it can never run here",
which the time-agnostic `Cluster.can_host` gives as `PolicyContext.fits_later` / the kata `fits_later`
(core tier). The reference became "order short-first, place jobs that `fits_now`, stop at the first job
that only `fits_later`" — which genuinely beats FIFO on slowdown. A real timeline `earliest_fit` is
still deferred (see the reserve/`earliest_fit` decision above).

## 2026-09-24 — Fairness is quiet at util < 1; deferred a real fairness level `[agent decision]`

`fairness` is Jain's index of delivered-vs-entitled share; when all jobs complete (the normal Stage-3
case), delivered ≈ entitled for every user and the index sits near 1 regardless of ordering — so no
ordering kata can move it. Level 5 unlocks and *uses* `user_share` (the machinery is exercised) but is
scored on `bounded_slowdown`, and the story is framed as "keep the queue responsive under a flooding
hog," which the ordering genuinely does. A real fairness lesson needs SLAs or guaranteed shares (later
stages). Documented in [[Levels]] rather than faked with a rigged anchor.

## 2026-09-24 — Stepping reuses the run() loop body, not a second engine `[agent decision]`

The interactive API (`bridge.start/step_n/step_until`) and the CLI/golden `run` both call
`Scheduler._advance` — `run` is just `_advance(until=…) + _result()`. The rejected alternative was a
separate incremental path for the browser, which would have been a *second* thing to keep deterministic.
Because it is literally one loop, draining a stepped run yields the identical `trajectory_hash`
(asserted in `tests/test_bridge.py`). A batch (all events at one timestamp + its one decision) is the
atomic step unit, so pausing never lands mid-decision. See [[Pyodide Bridge]].

## 2026-09-24 — Browser runs the real Python via a pure wheel; smoke-tested in Node `[agent decision]`

Rather than port the sim/Kata to TypeScript, the browser loads the same `scheduler_dojo` wheel
(`py3-none-any`, built by `scripts/build_wheel.sh`) into Pyodide via micropip and calls
`bridge.dispatch`. We pin the Pyodide runtime to the CPython-3.12 stable line (0.29.x) in one file to
match the engine and the `livedocs` stamps. A **Node-side** `node scripts/node_smoke.mjs` loads Pyodide,
installs the wheel, and asserts the run's `trajectory_hash` equals the pytest golden — so CI proves the
browser path without a browser. Trade-off: a heavier first load (mitigated by progress + wheel cache).

## 2026-09-24 — Preemption: no-checkpoint requeue + a FINISH epoch guard `[agent decision]`
`preempt` frees the nodes and returns the job to `QUEUED` to **re-run in full** (no checkpoint/resume).
A no-checkpoint model is honest for batch jobs, keeps scoring simple (`runtime_used` = full re-run),
and avoids a whole resume-state subsystem. The risk was a stale `FINISH` (from the preempted placement)
finishing a re-run job early; we guard it by keying each `FINISH` `id#epoch` and bumping `run_epoch` on
every place/preempt, ignoring a mismatch. Trade-off: preemption looks harsh (progress lost) — acceptable
for teaching why you avoid preempting. See [[scheduler_dojo-sim-scheduler]].

## 2026-09-24 — Multi-site routing = `run_site` + a `data_mb/rate` transfer delay `[agent decision]`
Rather than a full data-placement model, `route(job, site)` records a `run_site`; `place` then restricts
`first_fit` to that site and lengthens the run by `ceil(data_mb / transfer_rate_mbs)` when it leaves the
data's `home_site`. It captures the co-location lesson (p95 wait collapses) in ~40 lines and stays
trajectory-neutral when single-site (no `home_site`). Trade-off: transfer is a flat per-job delay, not a
bandwidth-saturated network model. See [[scheduler_dojo-sim-scheduler]].

## 2026-09-24 — Explicit `jobs` lists make trace/handcrafted levels runnable & calibratable `[agent decision]`
A level may carry an explicit `jobs` list *or* a `generator` (`validate_level` accepts either;
`load_jobs` prefers the explicit list). This lets `dojo import-trace` wrap a sacct CSV directly, and lets
calibrated puzzles (preempt/route, where priority/`home_site`/`submit_time` must be hand-controlled) be
honest puzzles rather than awkward generator draws. Trade-off: two level sources to validate. See
[[scheduler_dojo-sim-level]], [[Concepts/Levels]].

## 2026-09-24 — Belts track lifetime credits, not balance `[agent decision]`
The belt is a function of *lifetime* credits, so spending on upgrades never demotes you. Spending is a
choice that should not punish progress. Balance (spendable) and lifetime (belt) are separate counters.

## 2026-09-24 — Owned upgrades are the source of truth for Kata tiers `[agent decision]`
Kata play enables tiers as `level.unlocks ∩ owned` (owned tiers come from the progression shop), so a
level listing a tier is a *ceiling*, and the upgrade shop actually gates the language. Keeps the level
JSON declarative while making the economy meaningful. See [[scheduler_dojo-progression]].

## 2026-10-01 — Phase two keeps the engine as the only decider; the campus is presentation `[agent decision]`
The campus (neighbourhoods/vehicles/lots/booth) is a rendering *of* the engine snapshot; nothing that
decides moves to TypeScript (§2.6/§3 of `PROMPT-ART.md`). New deciding facts the UI needs — per-user
pressure rings, week boundaries, offer choices, decision traces — are added *to the engine and bridge*
(§5), not computed in the renderer. Trade-off: every campus feature pays a bridge round-trip and a
livedocs gate.

## 2026-10-01 — Weekly two-offer choices replace the credit shop; credits/belts survive as lifetime record `[agent decision]`
End of week = freeze + pick 1 of 2 eligible upgrades (drawn deterministically from (save, city, week)
so a share card can replay an upgrade path). Credits stop being purchase currency but remain the
lifetime score record behind belts and share cards, exactly as `progression.credits_for` already
computes them; the old shop dialog retires behind a save migration. Trade-off: players lose
"save up and buy what I want" agency; in exchange every purchase moment is a taught moment. See
[[Concepts/Progression]].

## 2026-10-01 — Rule cards are canonical kata snippets, not a DSL of their own `[agent decision]`
The tutorial's rule cards (order-only katas) compile to text via `kata.formatter`, so card library and
kata library are one store and the editor hand-off (card text → full editor) is lossless by
construction. Trade-off: a card's editable "one line" must stay parseable in isolation — the line
always renders as its full module. See [[Kata]], [[scheduler_dojo-kata-formatter]].

## 2026-10-01 — Cool direction wins the campus mockdown `[agent decision]`
Two independent mockups of "City 3, mid-week" (warm vs cool), same scene contract. Cool's
feeder-road-booth-lots composition reads at a glance and never clips; warm's vertical road crowded
the lots and clipped its GPU/high-mem lots at 1600 px. Cool's `:root` role tokens became
`web/tokens/palette.json` (with lightened bay-material floors to pass the WCAG gate); warm's legend
and annotation discipline were kept. Shots: `docs/screenshots/art1/`.

## 2026-10-01 — Tutorial city editions are deterministic patches, not forked levels `[agent decision]`
City 1's "one neighbourhood until day 3" is a `level_patch` over the canonical `level1` (whitelisted
generator knobs), so calibration, goldens and share cards keep referring to the one level; the
patched variant is pinned by its own tutorial golden. Alternatives (recalibrate levels to tutorial
pacing / separate tutorial ids) fork the calibration story for no pedagogical gain. See [[Tutorial]].
