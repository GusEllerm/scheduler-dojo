---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 4 — Pyodide bridge & web shell

## Goal

One Python engine, run in the browser. Build the WASM boundary (`bridge.py`), a pure wheel build, and a
Vite + worker + Canvas shell that plays back level 1 — with a **Node-side** test proving the Pyodide run
equals the pytest golden.

## Interfaces

- `bridge.py` — the only JS-callable API: `dispatch(call, args) -> {result|error}` over
  `run`/`start`/`step_n`/`step_until`/`step_result`/`check_kata`/`ping`/`version`. JSON-in/JSON-out.
- `Scheduler.step_events`/`run_until` share the `run` loop body (`_advance`) → stepping ≡ full run.
- `scripts/build_wheel.sh` → pure `py3-none-any` wheel staged to `web/public/wheels/`.
- `web/` — Vite app: `worker.ts` (loadPyodide v0.29.5 + micropip wheel), `bridge.ts` (typed client),
  `render/timeline.ts` (Canvas playback). Pyodide version pinned in `web/src/version.ts`.

## Split

- `bridge.py` + stepping + wheel script + tests: **orchestrator** (determinism/serialization-critical).
- `web/**` + `scripts/node_smoke.mjs`: **builder** (coherent subtree: worker ↔ client ↔ timeline types).

## Acceptance

- `bridge.run(level1, idle)` hash == the pytest golden hash; score 300. Reference kata → 800.
- A stepped run drains to the same hash as a full run (tested).
- `node scripts/node_smoke.mjs` installs the wheel in real Pyodide and the hash matches the golden.
- The timeline paints level 1 under idle and the reference. See [[Pyodide Bridge]].

## Outcome

Shipped. `bridge.py` (dispatch over run/start/step_*/check_kata) with `tests/test_bridge.py` (stepping ≡
full run, error envelopes, golden match). `Scheduler._advance` refactor gives `step_events`/`run_until`
for free. `scripts/build_wheel.sh` stages the pure wheel. The `web/` builder delivered the Vite app +
worker + `bridge.ts` + Canvas `timeline.ts` (Pyodide pinned 0.29.5 in `version.ts` only) and
`scripts/node_smoke.mjs`, which loads the real wheel in Pyodide and asserts `trajectory_hash` == the
pytest golden (300 idle / 800 kata) — verified passing locally and in a real Chromium render. CI gained
a `smoke` job. 188 pytest tests + the smoke test green. Notes: [[Pyodide Bridge]] + [[scheduler_dojo-bridge]].
