# Scheduler Dojo

**Be the scheduler. Then automate yourself out of the job.**

A small game about batch scheduling, drawn as a campus. Neighbourhoods are people, vehicles are
jobs, bays are machines, and the dispatch booth at the centre is the rules that pick who parks next.
You start by parking vehicles yourself in a guided city, then you staff the booth with a few rule
cards — which compile into a *kata*, a small policy language — and when the cards are good you stop
touching the mouse and watch the city run itself. That is the lesson: a scheduler is a policy, and a
policy you can write beats one you cannot.

**Play here →** <https://gusellerm.github.io/scheduler-dojo/> (GitHub Pages — no install, no account).

Phase two replaced the old console-looking shell with this campus. If you played phase one, nothing to
do: the save migrates itself (`src/scheduler_dojo/progression.py` `SAVE_VERSION` 3 adds the week-offer
ledger), so an old save opens on its city with its belts, credits and upgrades intact.

## How you play

- **The cities campaign** — nine cities, each a fixed, deterministic cluster. A city arrives as a
  short script that teaches one idea as you hit it (park a vehicle, fill a gap, notice a starved
  neighbour), then hands you the next city. Cities 1–3 are guided hand play; from city 4 the weeks
  start ending and you take one of two offers.
- **Watch** — any city replayed under its default policy and its reference kata, as a scrubbable
  timeline strip. The reference kata is the bar; the default policy is what "no policy" looks like.
- **Play by hand** — you are the scheduler: pick a queued vehicle, pick its bays, confirm. Levels 1–2
  do this on the old strip; the campus hand variant does it on the campus itself.
- **The booth (kata)** — the campus's card slots: drop an *order* card (and optionally a *place*
  card) and the booth runs the city with them. Cards serialise into real kata text, so "Open the
  full editor" hands the same text to the kata editor with syntax checking, Step, and the library.
- **Endless** — the growing city: one seeded street whose arrivals thicken weekly until a patience
  ring overflows. Same save, same seed, same growth. Your best is days survived + vehicles served.
- **City board** — nine tiles plus endless, each showing a *real* campus frame of that city, your
  best, and what a lock wants. Tiles start cities through the same chain as "Next city ▸".
- **Review** — after a run: the strip, the per-user fairness bars, and one calm line per mistake
  (timeouts, the overflow, a starved neighbour). Derived from the finished run, never from a mood.
- **Share cards** — the review's Share mints a card in the campus art: a campus thumbnail, the
  metrics, and a `#card=…` link (a hash, so Pages needs no server rewrite). Opening it re-runs the
  level in *your* browser and prints **verified ✓** or **card tampered ✗** — the engine decides, the
  page only displays.

Every run is scored 0–1000 off utilization, wait, slowdown, timeouts and fairness, with a pass bar
and a *earned* gold bar (only metrics where the reference beats the baseline are scored), so "my
policy is better" is a claim you can check. Levels are calibrated by `scripts/calibrate_levels.py`.

## Why a replay needs no server

The simulator (`src/scheduler_dojo/sim/`) is pure Python on an integer clock: no floats, no wall
clock, no dict-order dependence, so a run has a `trajectory_hash`. It ships as a `py3-none-any`
wheel (`scripts/build_wheel.sh`) that Pyodide installs in the browser — the same code the CLI runs,
behind one JSON boundary (`src/scheduler_dojo/bridge.py`). That is what makes a share card
verifiable, an offer reproducible from a save, and a replay reviewable offline: the browser is the
engine. `scripts/node_smoke.mjs` loads the real wheel in Node and asserts its hash equals the pytest
golden, so the page cannot quietly ship a different engine.

## Play it locally

```bash
uv sync                                     # Python 3.12, no runtime dependencies
uv run dojo run --level levels/level3.json  # headless: metrics, score, trajectory_hash
bash scripts/build_wheel.sh                 # stage the pure wheel the browser installs
cd web && npm ci && npm run dev             # http://127.0.0.1:5173
```

Other CLI entry points: `uv run dojo kata check|format|run <file>`,
`uv run dojo import-trace <sacct.csv> --out <level.json>` (a real Slurm export becomes a playable
level), `uv run dojo verify-card '<#c=…>'`. Handy URLs: `?city=N` boots straight into city N's guided
script, `#card=…` opens a share card.

## Developing it

```bash
uv run pytest                              # 327 tests: sim, kata, levels, bridge, progression, share
uv run python scripts/calibrate_levels.py  # baseline/reference scores (add --write to re-bar)
uv run python scripts/check_tutorials.py   # every city script validates against the engine schema
node scripts/node_smoke.mjs                # the browser's compute path vs. the pytest goldens, in Node
bash scripts/build_wheel.sh                # must stay py3-none-any or Pyodide cannot import it
cd web && npm run typecheck                # tsc --noEmit
```

The browser-facing rigs are committed too — all of them run against a built site, so
`cd web && npm run build && npm run preview` first (they default to `http://127.0.0.1:4173`):

| Rig | What it proves |
|---|---|
| `node scripts/campus_visual.mjs` | all nine cities render non-flat canvases and the render loop sustains ≥45 fps; writes `docs/screenshots/campus/levelN.png` |
| `node scripts/check_contrast.mjs` | the palette's text pairs clear WCAG in both themes |
| `node scripts/art6b_evidence.mjs` | the campaign chain city 1→6 driven only by in-game buttons, offer reproducibility, save migration |
| `node scripts/art7a_evidence.mjs` | endless ramps weekly until overflow; review screen + best scores |
| `node scripts/art7b_evidence.mjs` | the city board's real thumbnails; cards verify both ways, tampered cards fail |
| `node scripts/art8_a11y.mjs` | the accessibility audit: names, contrast, focus traps, static chrome, touch targets — and it *presses* every key the help drawer promises |
| `node scripts/art9_playthrough.mjs` | one fresh save, end to end: welcome → city 1 → skip → board → a watched run → review → share → verified card → help/keyboard |

Each writes its screenshots into `docs/screenshots/campus/`. CI (`.github/workflows/ci.yml`) runs
pytest, `livedocs verify`, the contrast gate and the Node smoke test; `.github/workflows/pages.yml`
deploys `web/dist` to Pages on push.

## Repo map

| Path | What lives there |
|---|---|
| `src/scheduler_dojo/sim/` | the engine: events, cluster, jobs, scoring, trace/endless generators, the trajectory hash |
| `src/scheduler_dojo/kata/` | the policy language: lexer → parser → AST → interpreter with a per-decision step budget, tier-gated builtins, formatter, checker |
| `src/scheduler_dojo/bridge.py` | the single JSON-in/JSON-out boundary the browser and CLI share |
| `src/scheduler_dojo/progression.py` | belts, credits, upgrades, week-end offers, drift, save migrations |
| `src/scheduler_dojo/share/` | card encode/decode + replay-verify |
| `levels/`, `levels/tutorials/` | the nine calibrated cities and the city scripts (`scripts/check_tutorials.py` validates them) |
| `web/src/` | the page: `main.ts` shell, `campus*.ts` the campus view, `booth.ts`, `tutorial.ts`, `board.ts`, `review.ts`, `share*.ts`, `worker.ts` |
| `web/scripts/` | the browser rigs in the table above |
| `tests/`, `scripts/` | pytest (327) and the headless tools |
| `docs/vault/` | long-term memory — start with `Concepts/Determinism.md`, then `Concepts/Campus.md` |

The web tier is plain TypeScript + Canvas, no framework; CodeMirror is the only editor dependency and
Pyodide is pinned. Notes under `docs/vault/` are bound to the code they name: `uv run livedocs verify`
runs in CI, and a commit that moves anchored code is blocked until the note is reconciled.
