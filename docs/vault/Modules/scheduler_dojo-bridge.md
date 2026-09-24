# scheduler_dojo/bridge.py

> [!abstract] Role
> The single JSON-in/JSON-out API surface the browser calls from inside Pyodide. The WASM boundary —
> no engine logic lives in TypeScript; the worker just dispatches `{call, args}` here. See [[Pyodide Bridge]].

## What it does

`dispatch(call, args)` looks up a function in `_DISPATCH` and calls it with positional (list) or
keyword (dict) args, wrapping any exception as `{"error": {"code", "message"}}` so a broken level or
kata is a message the UI shows, never a throw across the boundary. Functions: `ping`, `version`, `run`,
`start`/`step_n`/`step_until`/`step_result` (interactive stepping), `hand_start`/`hand_place`/
`hand_tick`/`hand_result` (hand placement, Stage 5), `progression_view`/`_completion`/`_buy`/`_drift`
(belts/credits/upgrades, Stage 7), `share_encode`/`share_replay` (tamper-evident share cards, Stage 9),
`check_kata`.

`run(level, seed=, policy=, kata=)` validates, runs, and returns a JSON-safe summary: `nodes`, `jobs`
(id/user/nodes/submit/start/end/runtime/state), `metrics`, `score`, `trajectory_hash`, `end_time`,
`bars`. `level` may be a dict or a JSON string.

## How it works

- **Determinism at the boundary:** `run` delegates to `sim.level.run_level`, so a bridge run matches the
  pytest golden byte-for-byte — the Node smoke test asserts exactly this (`bridge.py` hash ==
  `tests/goldens/levels.json` hash). See [[Determinism]].
- **Stepping** (`start`/`step_*`) drives a `Scheduler` kept alive in the `_SESSIONS` handle table via
  `Scheduler.step_events`/`run_until` — the same event-loop body as a full run, so draining a stepped
  run yields the identical `trajectory_hash` (tested). A stepped run is bit-for-bit a full run.
- **Hand placement** (`hand_*`) runs under a no-op *manual* policy: nothing auto-places, the engine still
  validates every `hand_place`, and `hand_tick` advances to the next arrival/finish. `_suggestions`
  answers "what FIFO would do" via a **read-only** `first_fit` (it never mutates state — verified).
- **Progression** (`progression_*`) is a thin pass-through to the pure `scheduler_dojo.progression`
  rules, so the browser HUD and tests share one economy.
- **JSON-safe:** everything returned is dicts/lists/ints/floats/None (no sets/tuples) so `JSON.stringify`
  in the worker never surprises; seconds are ints, metrics are floats.
- Errors carry the structured `code` from `sim.errors`/`kata.errors`.

## Depends on / used by

Uses `sim.level`, `sim.scheduler` (`Scheduler`, `POLICIES`), `sim.scoring`, `sim.trajectory`, `kata`.
Called by `web/src/worker.ts` via Pyodide, and by `scripts/node_smoke.mjs`.
