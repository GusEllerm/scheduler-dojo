# Scheduler Dojo — build brief for an autonomous agent

You are the lead engineer on a new product. This document is your complete brief. Read all of it
before doing anything. You are expected to work for a long time without a human in the loop:
make decisions, record them, and keep going. Stop only when the Definition of Done at the end is
met, or when you are blocked by something only a human can supply (credentials, a paid account).
Do not stop to ask whether to proceed.

---

## 1. What you are building

**Scheduler Dojo** is a browser game that teaches the patterns of batch job scheduling by making
the player *be* the scheduler, and then letting them automate themselves out of the job.

- At first the player places jobs on cluster nodes by hand and feels the classic pains:
  fragmentation, a big job starving while small jobs slip in, a walltime request that lied.
- They then unlock a small purpose-built policy language, **Kata**, and write policies (katas)
  that make the decisions for them. Each scheduling concept (FIFO, shortest-first, reservations,
  backfill, fair share, preemption, heterogeneous partitions, multi-site placement) is something the
  player discovers by suffering, then encodes.
- Progression is an upgrade path with an idle-game flavour: good scheduling earns credits, credits
  buy automation tiers, sensors (information the player did not previously have), and cluster
  growth. Once a kata is good enough the cluster runs itself while the player is away, but arrival
  patterns drift over time, so a kata that was great last week starts bleeding score and the player
  comes back to fix it.
- It is **easy to have a go and hard to master**. Every level has a *pass* bar (you can move on and
  share a card) and a *gold* bar (the optimizer's target). The late levels have no known optimum.
- Players share **cards**: an image plus a URL that encodes the level, seed and kata. Because the
  simulator is deterministic, anyone who opens the URL replays the exact run and sees the same
  score. Scores are verifiable with no server.

The audience is two overlapping groups: people who want to understand what a scheduler does, and
systems researchers (specifically Globus Labs at the University of Chicago, who work on Parsl,
Globus Compute, and HPC workflow systems) who want a readable, shareable, deterministic testbed for
scheduling policies that can also be pointed at real cluster traces.

**The same Python engine serves both.** It runs headless from a CLI for research, and inside the
browser via Pyodide for the game. There is exactly one implementation of the simulator and of Kata.

---

## 2. Hard constraints

1. **Static hosting.** The finished game is a static site deployable to GitHub Pages. No backend,
   no accounts, no database. Persistence is browser localStorage (not cookies).
2. **Python engine, run in the browser via Pyodide.** The simulator, the scoring, the Kata
   interpreter and the level definitions are a Python package. The web front end loads that
   package as a wheel into a Pyodide web worker. Do not port any engine logic to TypeScript.
3. **Kata is a purpose-built language,** not a Python subset. The goal is that players need to know
   the *patterns* of scheduling, not Python syntax. It must be safe to run untrusted (no IO, no
   imports, bounded steps), deterministic, and small enough that a whole competitive kata fits on a
   card.
4. **Determinism.** Same level + seed + kata always yields the same trajectory and score, in the
   CLI and in the browser. This is what makes share cards verifiable. Treat any nondeterminism as a
   bug.
5. **Live documentation with livedocs.** The repo carries an Obsidian vault at `docs/vault`, wired
   in with `livedocs`. Notes mention code symbols in backticks; a git pre-commit gate blocks commits
   that change code a note mentions until the note is updated or acked. You keep the vault current
   as you go (see §6).
6. **Sub-agents manage complexity.** You orchestrate; you spawn sub-agents for parallel builds,
   independent reviews, playtesting and documentation (see §5). Do not try to hold the whole
   system in one context.
7. **Python 3.12+**, `uv` for environments and builds, `pytest` for tests. Front end: Vite +
   TypeScript, Canvas 2D for the timeline, CodeMirror 6 for the kata editor, no UI framework unless
   you can justify it in the Decision Log. Keep dependencies few.

---

## 3. Bootstrap (do this first, exactly)

You start inside the project directory `scheduler-dojo`, which already contains this file
(`PROMPT.md`). Keep it there; it is part of the repo.

```sh
git init -b main
uv init --package --name scheduler-dojo --python 3.12   # creates pyproject.toml, src/scheduler_dojo/
printf '.venv/\ndist/\nnode_modules/\nweb/dist/\n__pycache__/\n*.egg-info/\n.pytest_cache/\n' > .gitignore
git add -A && git commit -m "init"
gh repo create scheduler-dojo --public --source=. --push --description "Be the scheduler. Then automate yourself out of the job."
livedocs new-vault docs/vault --scaffold-modules
git add -A && git commit -m "vault"
```

Then read what `new-vault` produced: `docs/vault/Home.md`, the `Templates/`, `.livedocs/config.json`,
`.githooks/`, and the `AGENTS.md` block it added at the repo root. Those are your conventions for
the vault. If `livedocs` or `drift` is missing, install with
`brew install fiberplane/tap/drift` (or `curl -fsSL https://drift.fp.dev/install.sh | sh`) and
`uv tool install git+https://github.com/GusEllerm/vault-drift`, then continue. If `gh` is not
authenticated, that is a blocker only a human can clear: record it, do everything else that does
not need the remote, and say so plainly in your final report.

Re-run `livedocs new-vault ... --scaffold-modules` is **not** needed later; as you add modules,
add their notes by hand under `docs/vault/Modules/` using the template.

---

## 4. Architecture

Repository layout to converge on:

```
scheduler-dojo/
  pyproject.toml              # package: scheduler_dojo, console script: dojo
  src/scheduler_dojo/
    sim/                      # discrete-event simulator
      events.py               # event queue, clock, arrival/completion events
      cluster.py              # nodes, partitions, sites, allocation state
      jobs.py                 # Job dataclass, states, lifecycle
      scheduler.py            # the scheduling loop: calls the policy at decision points
      scoring.py              # metrics and the 0..1000 score
      trace.py                # importers: synthetic generators, Slurm sacct CSV
    kata/                     # the policy language
      lexer.py  parser.py  ast.py  interp.py  builtins.py  errors.py
      spec.md                 # THE language reference (also mirrored into the vault)
    levels/
      __init__.py             # registry
      *.json                  # one file per level: cluster, trace/generator, weights, unlocks, bars
      reference_katas/        # the katas that set pass/gold bars, one per level
    game/
      progression.py          # credits, upgrades, belts, idle/offline progress
      share.py                # encode/decode share payloads; verification
    bridge.py                 # the single JSON-in/JSON-out API surface the browser uses
    cli.py                    # `dojo run`, `dojo score`, `dojo verify-card`, `dojo import-trace`
  tests/                      # pytest; golden trajectories per level+seed+reference kata
  web/
    index.html  vite.config.ts  package.json
    src/
      worker.ts               # Pyodide worker: loads wheel, dispatches bridge calls
      bridge.ts               # typed client for worker messages
      render/                 # Canvas timeline, queue, gauges
      editor/                 # CodeMirror 6 + Kata syntax mode + error display
      game/                   # screens: level select, play, kata, upgrades, card
      store.ts                # localStorage schema + migrations
    public/wheels/            # built wheel copied here by the build script
  docs/vault/                 # livedocs Obsidian vault
  .github/workflows/          # ci.yml (pytest, livedocs verify, web build), pages.yml (deploy)
  scripts/build_wheel.sh      # uv build → copy wheel into web/public/wheels/
```

### 4.1 Simulator

Discrete-event, integer-second clock. Entities: `Site` → `Partition` → `Node` (with `cpus`, `mem`,
`gpus`, optional `tags`). `Job` has `id, user, submit_time, nodes_req, walltime_req, partition,
priority, deps, actual_runtime (hidden from the policy unless a sensor is unlocked), state`.
Events: `Arrive`, `Start`, `Finish`, `Preempt`, `Tick` (for time-based policies), `Drift` (arrival
pattern changes in idle mode). At each decision point (arrival, finish, tick) the scheduler
invokes the active policy (manual UI, or a kata) which may `place`, `reserve`, `preempt`.
The engine validates every action; an invalid action raises a structured `PolicyError` that the
UI shows against the kata line, never a crash.

Expose a **stepping API**: `bridge.step(n_events)` and `bridge.run_until(t)` returning a compact
state diff, so the browser can animate at any speed and the CLI can run to completion.

### 4.2 Scoring

Score is 0..1000 per level, computed from a weighted blend the level file declares:

- `utilization`: busy node-seconds / available node-seconds
- `bounded_slowdown`: mean of `max(wait+run, 10s) / max(run, 10s)` (lower is better)
- `wait_p95`: 95th percentile queue wait
- `fairness`: Jain's index of (delivered share / entitled share) across users
- `sla`: fraction of jobs that started within their SLA when the level defines SLAs
- `energy` / `transfer`: only in levels that model power price or multi-site transfer

Normalize each metric against the level's *baseline* (plain FIFO) and *reference* (best reference
kata) so that FIFO scores roughly 300 and the reference scores roughly 800. `pass` and `gold`
thresholds are stored in the level file and **must be regenerated by a script** from the reference
katas, never hand-typed. Document the formula in the vault under `Concepts/Scoring.md`.

### 4.3 Kata, the policy language

A kata is a set of **modules**, each filling a **slot** the engine consults:

```
# Level 3 style kata: reserve the head of the queue, backfill around it.

order by shortest_first:
  key = (job.walltime_req, job.submit_time)

place by easy_backfill:
  head = first(queue)
  reserve(head, earliest_fit(head))
  for job in rest(queue):
    if fits_now(job) and end_if_started_now(job) <= reservation_start(head):
      place(job)

preempt by never:
  pass
```

Slots: `order` (produces a sort key per queued job), `place` (walks the ordered queue and calls
actions), `preempt` (optional, later unlock), `route` (multi-site, later unlock). A missing slot
uses the level's default (FIFO order, first-fit place, no preemption).

Design rules for Kata:

- **Readable on a card.** Indentation-based blocks, no semicolons, no type annotations. A strong
  competitive kata for a mid-game level should fit in 25 lines.
- **Values:** ints, floats, booleans, tuples, lists, and opaque `job`, `node`, `user`, `site`
  records with dotted fields. No strings beyond equality comparison of names. No dicts at first;
  add `map` only if a level needs it.
- **Control:** `if / elif / else`, `for x in xs`, `while` (bounded by the step budget),
  `def name(args):` helper functions with recursion (a later unlock), `return`.
- **Builtins** (grow by unlock tier; the level file says which are available):
  `queue, running, now, nodes, free_nodes(), fits_now(job), earliest_fit(job), place(job),
  place(job, nodes), reserve(job, t), reservation_start(job), end_if_started_now(job),
  first(xs), rest(xs), len, min, max, sum, sorted(xs, key=...), any, all, abs,
  user_usage(user), user_share(user), est_runtime(job)  # sensor
  preempt(job), route(job, site), transfer_cost(job, site)`.
- **Safety:** no IO, no imports, no attribute assignment, no global mutation across calls except an
  explicit `remember`/`recall` pair that the level may unlock (a bounded per-kata memory).
  A per-decision **step budget** (default 20,000 interpreter steps). Exhausting it raises a friendly
  error ("your kata ran out of breath on line 7") and the engine falls back to the default for that
  decision.
- **Determinism:** no randomness, no wall clock. Iteration order over any collection is defined.
- **Errors are teaching moments.** Every error has a one-line explanation and a pointer to the
  relevant concept note. Parse errors show the line and a caret.
- **Tooling:** a `dojo kata check <file>` command, a formatter that canonicalizes whitespace (so
  share payloads are compact and two identical katas compare equal), and a syntax mode for
  CodeMirror generated from the same token list the lexer uses.

Write `src/scheduler_dojo/kata/spec.md` **before** the interpreter, with a grammar in EBNF, and
treat it as the contract between the language sub-agent and the UI sub-agent.

### 4.4 Levels

A level file declares: title, one-paragraph brief (what pain this level teaches), cluster shape
(sites/partitions/nodes), the arrival source (a seeded generator spec or a trace file), duration,
score weights and SLAs, which Kata slots and builtins are unlocked, which sensors are available,
`pass` and `gold` bars, and the reference kata path. The ladder to ship:

| # | Title | Cluster | New pain | New tool |
|---|---|---|---|---|
| 1 | Hand placement | 8 nodes, 1-node jobs | fragmentation, wait time | drag jobs onto nodes |
| 2 | First rule | same | you cannot keep up by hand | `order` slot, one-line key |
| 3 | The big job | 16 nodes, multi-node jobs | starvation | `place` slot, `reserve`, backfill |
| 4 | Liars | same | walltime requests are wrong | `est_runtime` sensor |
| 5 | Fair share | 32 nodes, 6 users, one hog | fairness in the score | `user_usage`, `user_share` |
| 6 | Partitions | GPU + highmem partitions | mismatched placement | node fields, `place(job, nodes)` |
| 7 | Workflows | DAG arrivals, deps | idle gaps waiting on parents | `def` helpers, recursion, `preempt` |
| 8 | Two sites | 2 sites, transfer cost | data gravity | `route` slot, `transfer_cost` |
| 9 | Endless | drifting arrival mix | your kata rots | `remember`/`recall`; no gold bar, leaderboard-of-one |
| T | Trace mode | imported sacct CSV | reality | any unlocked kata; research use |

Levels 1 and 2 must be completable in under five minutes by someone who has never seen a scheduler.
Level 3's gold bar must be genuinely hard to hit without backfill. Level 9 must show visible
score decay over simulated weeks for any static kata.

### 4.5 Progression, idle mode, persistence

- **Credits** accrue as score-rate × simulated time while a kata is active. **Belts** (white → black)
  are milestones: first pass, first gold, first recursive kata, first trace-mode run, etc.
- **Upgrades** (bought with credits, per save): automation tiers (more slots, more builtins,
  higher step budget), sensors, cluster growth (extra nodes for the endless level), cosmetics.
- **Offline progress:** on return, simulate the elapsed real time at the game's time ratio
  (choose one and document it; 1 real minute ≈ 1 simulated hour is a reasonable start), capped at 8
  real hours, using the saved kata and a `Drift` schedule derived from the save's seed. Show the
  player what happened while they were away.
- **Persistence:** one localStorage key holding a versioned JSON save; write a migration function
  the first time you change its shape; export/import as a file for backup.

### 4.6 Share cards

- Payload: `{v, level, seed, kata (formatted), score, unlocks}` → JSON → deflate → base64url →
  URL fragment `#c=...`. The page detects the fragment, replays the run in the worker, and shows the
  score with a "verified locally" badge, plus a diff if the claimed score does not match.
- Card image: Canvas render at 1200×630 with level, score, belt, kata line count, a small timeline
  thumbnail, and the URL. Offer "copy link" and "download PNG".
- `dojo verify-card <url>` does the same verification headless.

### 4.7 Pyodide bridge

- The worker imports `loadPyodide` from the jsDelivr CDN (`https://cdn.jsdelivr.net/pyodide/v<VERSION>/full/pyodide.mjs`).
  Check the current stable version on https://pyodide.org and pin it in one place. Then
  `await pyodide.loadPackage("micropip")` and `micropip.install("<relative URL>/wheels/scheduler_dojo-<ver>-py3-none-any.whl")`.
  The engine must be pure Python with no compiled dependencies so the wheel is `py3-none-any`.
- Protocol: `{id, call, args}` → `{id, result | error}`. `bridge.py` exposes a handful of functions
  that take and return JSON-serializable dicts only. Do not pass PyProxy objects to the main
  thread; convert with `.toJs()` and destroy proxies, or (simpler) have Python return JSON strings.
- Show a loading screen with real progress (Pyodide runtime, then wheel). Cache the wheel with a
  content hash in its filename.
- Add a **Node-side smoke test** that loads Pyodide in Node (the `pyodide` npm package), installs
  the wheel, and runs level 1 with the reference kata, asserting the score equals the pytest golden.
  This is your determinism check across runtimes; run it in CI.

---

## 5. How to work: sub-agents, stages, reviews

You are the orchestrator. For every stage:

1. **Plan** the stage in a short note under `docs/vault/Sessions/` (goal, interfaces, acceptance).
2. **Write the contracts first** (module signatures, JSON schemas, the Kata spec) so builders can
   work in parallel.
3. **Spawn builder sub-agents** for independent pieces, each with a precise brief: the files it
   owns, the contract it must satisfy, the tests it must add, and what it must not touch. Give each
   builder the relevant vault notes to read first. Run them concurrently when their file sets are
   disjoint.
4. **Integrate** yourself. Run the full test suite.
5. **Spawn a reviewer sub-agent** with a fresh context to review the stage's diff for correctness,
   determinism hazards, and drift from the brief. Fix what it finds. For the language and the
   scoring, spawn a second reviewer that only tries to break things (adversarial katas, degenerate
   traces, huge queues).
6. **Spawn playtester sub-agents** from stage 4 onward. A playtester gets only the player-facing
   text and the levels, and must try to pass and then gold each level, writing katas as a player
   would. It reports where it was confused, where the difficulty curve broke, and what it wished
   the error messages said. Treat its confusion as bugs.
7. **Update the vault** (Modules notes for changed modules, Concepts notes for design, Decision Log
   for every choice a human might have wanted to make, Session log for the stage).
8. **Commit** with a message naming the stage. When the livedocs gate blocks a commit, that is the
   system working: read the `CHANGED: <note> … was / now` report, fix the note if the code change
   made it wrong, or `livedocs stamp <note> --ack --reason "…"` if it is still correct, then commit
   again. Never use `--no-verify`.
9. **Tag** the stage (`stage-N`) and push.

Keep sub-agent briefs self-contained: a sub-agent does not share your context. Prefer several
small, focused sub-agents to one large one. If a sub-agent's output does not meet its contract, do
not patch around it in your own context; send it back with the failing test.

---

## 6. The vault

`livedocs new-vault` gives you `Home.md`, `Modules/`, `Concepts/`, `Reference/`, `Sessions/`,
`Templates/`. Use them as:

- `Home.md`: current status, reading order, links to everything below. Update at the end of each stage.
- `Modules/<module>.md`: what the module is for, its public symbols in backticks (this is what
  binds it to the code), invariants, and the tests that guard them. One note per Python module and
  per TypeScript directory.
- `Concepts/`: `Kata Language.md` (mirrors `spec.md`), `Scoring.md`, `Level Design.md`,
  `Progression.md`, `Determinism.md`, `Pyodide Bridge.md`, `Share Cards.md`.
- `Reference/`: the level ladder table, builtin reference, trace import format
  (for Slurm: `sacct -a -S <start> -E <end> --duplicates -P -o JobID,User,Partition,Submit,Start,End,NNodes,Timelimit,State`;
  note that without `--duplicates` requeued jobs are undercounted), the localStorage schema.
- `Decision Log.md` (create it if the scaffold did not): dated entries, each tagged
  `[agent decision]`, stating the choice, the alternatives, and why. A human will read this to
  find the decisions they might want to reverse.
- `Sessions/`: one snapshot note per stage (these are `snapshot` notes and never block).

Write notes as if for a colleague who will maintain this after you: facts, invariants, and the
reasons behind non-obvious choices. Do not paste code into notes; mention symbols in backticks.

---

## 7. Stages and acceptance criteria

Work through these in order. Do not start a stage until the previous one's acceptance criteria are
met and tagged. Within a stage, parallelize.

### Stage 0 — Bootstrap
§3 exactly. Plus: `uv add --dev pytest pytest-cov`, a `ci.yml` that runs `uv run pytest` and
`livedocs verify --repo . --vault docs/vault`, and a `Concepts/Determinism.md` note stating the
rules (seeded RNG only, integer clock, defined iteration order, no wall clock in the engine).
**Accept:** CI green on the remote; vault committed; `Home.md` describes the plan.

### Stage 1 — Simulator core (headless)
Builders in parallel: (a) `sim/events.py + cluster.py + jobs.py`, (b) `sim/scoring.py`,
(c) `sim/trace.py` synthetic generators (Poisson arrivals with configurable size/walltime
distributions and user mix; a DAG generator for later). Then integrate `sim/scheduler.py` with two
built-in policies, FIFO first-fit and shortest-first, as plain Python (these become the defaults
Kata falls back to). `cli.py`: `dojo run --level <json> --seed N --policy fifo`.
**Accept:** golden-trajectory tests for 3 seeds × 2 policies on a fixture level; scoring unit
tests against hand-computed cases; a 10,000-job run completes in under 5 s natively.

### Stage 2 — Kata
Write `spec.md` first (grammar, semantics, builtins by tier, error catalogue). Builders in
parallel: (a) lexer + parser + AST with error reporting, (b) interpreter + step budget + builtins
bound to the simulator, (c) formatter + `dojo kata check`. Adversarial reviewer afterwards.
**Accept:** the reference katas for levels 2–5 parse, run, and beat FIFO; 100% of the error
catalogue has a test; a kata with an infinite loop is stopped by the budget within one decision;
the formatter is idempotent; property test that formatting then parsing round-trips.

### Stage 3 — Levels 1–5 defined and calibrated
Level JSON schema (validate it), level files, reference katas, and `scripts/calibrate_levels.py`
that regenerates pass/gold bars from FIFO and the reference katas. `Concepts/Level Design.md`
explains the ladder and the pain each level teaches.
**Accept:** `dojo run --level 3 --policy levels/reference_katas/03.kata` reaches gold; FIFO fails
level 3's pass bar; bars in the files match the calibration script's output (test).

### Stage 4 — Pyodide bridge and web shell
`bridge.py` (JSON API), `scripts/build_wheel.sh`, the Vite app skeleton, `worker.ts`, `bridge.ts`,
loading screen, and a timeline renderer that plays back level 1 under FIFO. Node-side smoke test
per §4.7 in CI.
**Accept:** `npm run build` produces a static `web/dist` that works when served from a subpath;
the Node smoke test's score equals the pytest golden; the first paint of the timeline happens
within 10 s on a cold cache on a laptop.

### Stage 5 — Hand placement (levels 1–2 playable)
Drag-and-drop placement onto the node grid, queue panel, live gauges, pause/speed controls,
level brief and pass/gold reveal, level select screen, and the level 2 kata editor with a single
`order` slot. Save progress to localStorage.
**Accept:** two playtester sub-agents pass levels 1 and 2 from the brief alone in under five
simulated-play minutes each; their confusion reports are triaged and the blocking ones fixed.

### Stage 6 — Full kata play (levels 3–5)
Editor with syntax mode, inline errors, "run to end" and "step" modes, a kata library per level
(player's saved katas), fallback-to-default visibility (show when the engine had to fall back).
**Accept:** playtesters reach pass on 3–5 and gold on at least one; the reviewer confirms every
`PolicyError` path renders in the UI; no engine exception reaches the console.

### Stage 7 — Progression, upgrades, idle
Credits, belts, upgrade shop, offline progress with drift, save migrations, export/import.
**Accept:** returning after a simulated 8-hour absence shows a coherent "while you were away"
summary; a static kata on the endless level demonstrably decays over simulated weeks; a save from
stage 6 migrates cleanly.

### Stage 8 — Levels 6–9 and trace mode
Partitions, DAG workflows with `def`/recursion/`preempt`, two sites with `route`, endless mode,
and `dojo import-trace` for sacct CSV plus the UI to load a trace file. Ship one anonymized
synthetic "realistic" trace so trace mode works without real data.
**Accept:** reference katas hit gold on 6–8; the level 7 reference uses recursion meaningfully;
trace import round-trips a fixture CSV; all levels pass calibration.

### Stage 9 — Share cards
Encode/decode, replay-and-verify view, PNG card renderer, `dojo verify-card`.
**Accept:** a card URL from the browser verifies with the CLI and vice versa; tampering with the
score in the payload is detected and shown.

### Stage 10 — Polish, docs, deploy
Pages deploy workflow, README with a screenshot and a 60-second "how to play", a "for
researchers" page (headless CLI, trace import, how to add a level), accessibility pass (keyboard
placement for level 1, reduced motion), final vault sweep, `livedocs coverage` reviewed and
dangling mentions fixed.
**Accept:** the site is live on GitHub Pages; CI green; `livedocs verify` clean; a final
playtester run over all levels with a written report in `Sessions/`.

---

## 8. Quality bar

- Tests are the acceptance mechanism. A feature without a test is not done.
- Golden files are regenerated only by a script and reviewed in the diff.
- Player-facing text is written for someone who has never heard the word "backfill". Every
  concept is introduced by a level brief before it is required.
- Every choice that a product owner might want to revisit goes in the Decision Log.
- Performance: level 9 should sustain at least 50 simulated minutes per real second in the browser
  at the default speed; profile before optimizing.
- No dead code, no TODOs left in `main`. If something is deferred, it is in `Home.md` under
  "Deferred", with a reason.

## 9. When things go wrong

- A dependency is unavailable: pick the closest alternative, record the decision, continue.
- Pyodide cannot load a wheel: check that the wheel is pure (`py3-none-any`), that the URL is
  relative to the page, and that the file name follows PEP 427. Test in Node first.
- Determinism drifts between CLI and browser: bisect with the Node smoke test; the usual causes
  are set iteration, float summation order, and dict ordering across Python versions. Pin the
  Python minor version the wheel targets to Pyodide's.
- A stage's acceptance cannot be met: do not lower the bar silently. Record what blocked it in the
  Session note and `Home.md`, finish everything else in the stage, and continue.

## 10. Definition of done

All ten stages tagged and pushed; the site live on GitHub Pages; CI green; `livedocs verify`
clean; the vault's `Home.md` reads as a complete, current map of the project with a "Deferred"
list and a "Decisions a human should review" list; and a final report (in your last message and in
`Sessions/Final Report.md`) covering: what was built, the live URL, the test and playtest evidence,
the decisions you made on the human's behalf, and what you would build next.
