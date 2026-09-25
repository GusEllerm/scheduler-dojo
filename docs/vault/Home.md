# scheduler-dojo vault

This vault is the long-term memory for **scheduler-dojo**. Agents and people write it as the code takes shape;
`livedocs` keeps the notes honest: every note that names code in backticks is bound to that code, and a
commit that changes the code is blocked until the note is updated or acknowledged.

## Where things go

| Folder | Holds | Checked against code? |
|---|---|---|
| `Modules/` | one note per module or package: what it does, how it works, what depends on it | yes |
| `Concepts/` | ideas that span modules: an architecture, a lifecycle, an invariant | yes, where they name code |
| `Reference/` | external facts, surveys, dated reviews | reviews (`Review *`) are snapshots |
| `Sessions/` | one log per working session | snapshots (never checked) |
| `Templates/` | note templates (the Templates core plugin points here) | — |

## How to write a note that stays true

- Name code in backticks: `` `module.function()` ``, `` `ClassName` ``, `` `path/to/file.py` ``. Those are the
  claims livedocs checks. Prose that names no code is not checked (and is reported as such).
- Commit the note; the commit stamps it. There is nothing else to run.
- When a commit is blocked, the message shows *was / now* for the code that changed and the note lines
  that mention it. Edit the note and commit again, or `livedocs stamp <note> --ack --reason "…"` if the
  note is still right.
- Dated records go in `Sessions/` or are named `Reference/Review …`; they are snapshots and never block.

## Status

**Stage 7 (Progression) & Stage 6 (Full kata play) — done.** Stage 6 adds a "Write a kata" mode
(CodeMirror editor, lexer-mirrored highlighting, inline `check_kata` errors, kata library, Run/Step).
Stage 7 adds the progression HUD (belt chip, credits, next-belt hint) + upgrade shop, backed by the
progression engine via the bridge and persisted to localStorage. Belts track *lifetime* credits
(spending never demotes); offline **drift** grants a welcome-back on load; owned upgrades
(reserve/sensors/fairness/preempt/route) gate the matching Kata tiers. Both screenshot-verified
(backfill kata → gold 800; buy Reservations 105→45 cr with correct gating; reload restores credits).

**Stage 8 (engine + levels 6–9) — done.** Real **preemption** (`Scheduler.preempt`, epoch-guarded
stale-FINISH), multi-site **routing** (`route`/`transfer_secs`/site-aware `first_fit`), and **trace
import** (`dojo import-trace`, explicit-jobs levels); `dojo verify-card` + `share_encode`/`share_replay`
(Stage 9 engine). Levels 6 (partitions/tags), 7 (preempt), 8 (two-site route), 9 (capstone) are
calibrated fixed-seed puzzles whose reference katas beat FIFO. The Stage-9 share *UI* + PNG card remain.

**Stage 5 (Hand placement) — done.** A manual-placement bridge API (`hand_start/place/tick/result`, a
no-op manual policy with a read-only FIFO `suggestions` hint) drives a click-to-place UI: queue chips,
node lanes, a Place/cancel confirm bar, live utilization + queue gauges, and Finish → scorecard +
painted timeline, with best-score/gold persisted to localStorage. Verified end-to-end by screenshot
(hand-placed job renders as a done-bar; score 440 > pass 350; "saved best" shown).

**Stage 4 (Pyodide bridge & web shell) — engine path done.** `bridge.py` is the single JSON-in/JSON-out
WASM boundary; `Scheduler` gained a stepping API (`step_events`/`run_until`) sharing the exact `run`
loop body so a stepped run ≡ a full run. A pure `py3-none-any` wheel builds via `scripts/build_wheel.sh`
and loads into Pyodide (pinned 0.29.5 / CPython 3.12) via micropip in a Vite worker; a Canvas timeline
plays back level 1. A **Node-side** smoke test (`scripts/node_smoke.mjs`) loads the real wheel in
Pyodide and asserts its `trajectory_hash` equals the pytest golden — CI proves the browser path without
a browser. 188 tests + the smoke test pass.

**Stage 3 (Levels 1–5) — done.** A validated level schema (`validate_level`), five calibrated
levels — each a fixed-seed deterministic puzzle with a `baseline_policy` scoring 300 and a
`reference_kata` scoring 800 (gold *earned* via a Pareto metric filter, not baked in),
`scripts/calibrate_levels.py`, per-level goldens, and a `fits_later` capacity ceiling for honest
gap-filling. Fairness is honestly quiet at util < 1 (deferred real lesson). 177 tests passing.

**Stage 2 (Kata language) — done.** A small, safe, deterministic policy language: `lexer.py` +
`parser.py` → AST, a tree-walking `interp.py` with a per-decision step budget, tier-gated `builtins.py`
bound to the scheduler, `KataPolicy` (plugs into `Scheduler` with a clean FIFO fallback on any error),
a canonical `formatter.py` (idempotent + round-trip), and `check.py`/`dojo kata check|format|run`.
Reference katas beat FIFO; the step budget stops infinite loops without crashing. 158 tests passing.

**Stage 1 (Simulator core) — done.** Deterministic integer-clock, whole-node discrete-event
simulator with FIFO + shortest-first, scoring (metrics + 0..1000 score), seeded synthetic trace
generators, `dojo run`, golden-trajectory + hardening tests. Reviewed (correctness +
adversarial) and hardened. Repo live at https://github.com/GusEllerm/scheduler-dojo ; CI green.

## The plan (stage ladder)

| Stage | Deliverable | State |
|---|---|---|
| 0 | Bootstrap: repo, package, CI, vault, Determinism note | ✅ done |
| 1 | Simulator core (headless): events/cluster/jobs, scoring, trace generators, FIFO + shortest-first, `dojo run` | ✅ done |
| 2 | Kata language: spec → lexer/parser/AST, interpreter + step budget + builtins, formatter, `dojo kata check` | ✅ done |
| 3 | Levels 1–5 defined and calibrated (schema, reference katas, `scripts/calibrate_levels.py`) | ✅ done |
| 4 | Pyodide bridge + web shell: `bridge.py`, wheel build, Vite app, worker, timeline, Node smoke test | ✅ done |
| 5 | Hand placement playable (levels 1–2), drag-and-drop, gauges, localStorage | ✅ done |
| 6 | Full kata play (levels 3–5): syntax editor, inline errors, step/run, kata library | ✅ done |
| 7 | Progression: credits, belts, upgrade shop, offline progress + drift, save migrations | ✅ done |
| 8 | Levels 6–9 + trace mode: partitions, DAG/recursion/preempt, two-site route, endless, `dojo import-trace` | ✅ engine + levels done (share/PNG UI is Stage 9) |
| 9 | Share cards: encode/decode, replay-verify, PNG card, `dojo verify-card` | planned |
| 10 | Polish, a11y, Pages deploy, README/researchers page, final vault sweep | planned |

## Deferred

- **Browser-interactive stages (5–10) need live verification.** Stages 0–4 are verified headlessly (the
  Node smoke test drives real Pyodide and matches the golden). From Stage 5 on, the deliverables are
  DOM/UI (drag-and-drop, the kata editor, progression shop, share-card PNG), which I verify by
  screenshotting a real dev server with `agent-browser` — good for structure/paint, weaker for feel and
  edge-case UX than a human playtest. The brief also asks for **playtester sub-agents from Stage 4 on**;
  those produce subjective feedback best paired with a human looking at builds.
- **O(n²) FIFO rescan on over-subscribed loads**: non-blocking FIFO rescans the whole queue each
  decision; an over-subscribed (util > 1) load has an unbounded backlog and is slow. Levels are
  provisioned to util < 1 so it does not bite; revisit with an incrementally-maintained free-set
  before Stage 7's endless mode if a level ever runs hot. See [[Decision Log]].

## Decisions a human should review

See [[Decision Log]]. Currently only the bootstrap choices in §3 of `PROMPT.md`.

## Reading order

1. [[Determinism]] — the invariant every other note assumes.
2. `PROMPT.md` (repo root) — the full product brief.
3. Stage session logs under [[Sessions]].

## Map

- [[Modules]] · [[Concepts]] · [[Reference]] · [[Sessions]]
