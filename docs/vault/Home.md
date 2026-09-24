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

**Stage 1 (Simulator core) — done.** Deterministic integer-clock, whole-node discrete-event
simulator with FIFO + shortest-first, scoring (metrics + 0..1000 score), seeded synthetic trace
generators, `dojo run`, golden-trajectory + hardening tests (74 passing). Reviewed (correctness +
adversarial) and hardened. Repo live at https://github.com/GusEllerm/scheduler-dojo ; CI green.

## The plan (stage ladder)

| Stage | Deliverable | State |
|---|---|---|
| 0 | Bootstrap: repo, package, CI, vault, Determinism note | ✅ done |
| 1 | Simulator core (headless): events/cluster/jobs, scoring, trace generators, FIFO + shortest-first, `dojo run` | ✅ done |
| 2 | Kata language: spec → lexer/parser/AST, interpreter + step budget + builtins, formatter, `dojo kata check` | planned |
| 3 | Levels 1–5 defined and calibrated (schema, reference katas, `scripts/calibrate_levels.py`) | planned |
| 4 | Pyodide bridge + web shell: `bridge.py`, wheel build, Vite app, worker, timeline, Node smoke test | planned |
| 5 | Hand placement playable (levels 1–2), drag-and-drop, gauges, localStorage | planned |
| 6 | Full kata play (levels 3–5): syntax editor, inline errors, step/run, kata library | planned |
| 7 | Progression: credits, belts, upgrade shop, offline progress + drift, save migrations | planned |
| 8 | Levels 6–9 + trace mode: partitions, DAG/recursion/preempt, two-site route, endless, `dojo import-trace` | planned |
| 9 | Share cards: encode/decode, replay-verify, PNG card, `dojo verify-card` | planned |
| 10 | Polish, a11y, Pages deploy, README/researchers page, final vault sweep | planned |

## Deferred

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
