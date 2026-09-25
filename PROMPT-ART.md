# Scheduler Dojo, phase two: the campus — build brief for an autonomous agent

You are the lead engineer for the second major phase of **Scheduler Dojo**. Phase one (`PROMPT.md`)
built a correct, deterministic, fully playable game: a Python simulator running in the browser via
Pyodide, the Kata policy language, nine calibrated levels, progression, share cards, CI, GitHub Pages.
It is live at https://gusellerm.github.io/scheduler-dojo/ and it works.

It also throws the player into an admin console with no context. Jobs are grey chips with ids, nodes
are empty rows, the only picture is a Gantt chart of a finished run, upgrades live in a shop dialog,
and nothing teaches you how to play or why you would want the next feature. The lessons are all in
the numbers, and numbers do not build intuition.

Phase two replaces the presentation, the interaction model, the progression rhythm and the
onboarding with a **spatial, calm, glanceable game in the spirit of Mini Motorways**, while keeping the
engine, the Kata language, the scoring and the share cards underneath. You are not changing what the
game teaches. You are changing how it shows, how it feels, and how it teaches.

## 0. Autonomy

You run **fully autonomously**. There is no human in the loop. Do not ask questions, do not pause for
approval, do not present options and wait. When a decision is needed, make it, record it in
`docs/vault/Decision Log.md` tagged `[agent decision]` with the alternatives and the reason, and
continue. Stop only when the Definition of Done (§10) is met, or when you are blocked by something
only a human can supply, such as credentials; in that case finish everything that does not depend on
it and state the blocker plainly in your final report. Long sessions and context resets are expected:
the vault is your memory, so keep `Home.md` current enough that a fresh session can resume from it.

---

## 1. Learn the codebase first

In this order:

1. `AGENTS.md` — the livedocs gate you commit through. Never `--no-verify`.
2. `docs/vault/Home.md`, then `Concepts/Determinism.md`, `Levels.md`, `Kata.md`, `Scoring.md`,
   `Progression.md`, `Pyodide Bridge.md`.
3. `PROMPT.md` — the phase one brief. Its constraints still hold: static hosting, one Python engine,
   Kata is purpose-built, determinism, livedocs, sub-agents.
4. The web app under `web/src/`, and the bridge `src/scheduler_dojo/bridge.py` (every fact the
   browser can currently see).
5. Play the current game from a local dev server (`cd web && npm run dev`) with a browser tool.
   Screenshot every screen and level. Write `Sessions/<date> Phase 2 audit.md`: what each screen
   shows, what it fails to show, where the eye goes first, and what a new player is not told.

Known facts you will confirm:

- `bridge.run` returns each job's node *count*, not the nodes it ran on; `render/timeline.ts` re-packs
  lanes by first-fit, so the current picture is an approximation. The live `_snapshot` does carry
  `placed_nodes` for running jobs.
- Queue chips show only an id. Hand placement is click job, click lanes, click Place, with no
  feedback about fit.
- There is no present-tense view, no onboarding, and no playtest evidence: phase one's playtester
  sub-agents were never run.

Housekeeping before anything else: move the untracked `screenshots/` to `docs/screenshots/` with a
curated subset committed, add `screenshots/` to `.gitignore`.

---

## 2. The game, reframed

### 2.1 The picture

A calm top-down **campus**. Around the edge are **neighbourhoods**, one per user, each with its own
color. Neighbourhoods emit **vehicles**: jobs, drawn as simple geometric shapes in the neighbourhood's
color and sized by what they ask for. Width is nodes requested, length is walltime requested. A
one-node ten-minute job is a short pill. A four-node six-hour job is a wide long block that must
park in four adjacent bays at once. Vehicles are shapes, not literal cars; the campus reads as a
map, not a traffic simulator.

In the middle are the **lots**: parking bays, one per node, grouped into lots by partition. A lot of
a different material is a different partition (GPU, high-memory). A second campus joined by a
motorway is a second site. A vehicle drives in, occupies its bays for its runtime, and leaves.

The **road** between neighbourhoods and lots is the queue. Vehicles wait on it in the order the
active policy ranks them. A jam is the queue growing. A dark bay is wasted capacity. One color
flooding the road is unfairness. The whole state of the scheduler is readable from this one picture
with no numbers.

### 2.2 Pressure

Each neighbourhood has a **patience ring**. It fills while that neighbourhood's jobs wait relative to
what they asked for: this is bounded slowdown, made visible per user. Small jobs that wait long
fill it fast; a big job that waits fills it steadily while small vehicles stream past it, so
starvation is something you watch happen. When any ring overflows, the run ends. The engine's
scoring model stays underneath; the player experiences it as rings and jams.

Ring overflow ending a run changes level dynamics, so **trajectory hashes may change in this phase**.
What may not change: determinism (CLI and browser produce the same hash for the same inputs), the
calibration discipline (bars regenerated by `scripts/calibrate_levels.py`, never hand-typed), and the
guarantee that every level's reference kata reaches gold and FIFO does not. Regenerate goldens by
script and review the diffs.

### 2.3 The booth: where the kata lives

Mini Motorways never lets you automate. Here automation is the whole arc, so the campus has one
building it does not: the **dispatch booth** at the entrance to the lots. Early on it is empty and
the player directs traffic by hand. Then they staff it. The booth's rules are the kata.

When the booth runs, its decisions are visible: the chosen vehicle lights up on the road and is waved
into its bays, and a reservation cone appears when it reserves. Pausing traffic opens the booth and
shows *why*: the ranked queue with each vehicle's order key, the vehicle chosen, the gap it went into,
and any fallback with its reason pinned to the kata line. Step mode advances one decision at a time.

The kata on-ramp is graded (see §4). First **rule cards** the player slots into the booth. Then
editing one line on a card. Then two cards. Then the full editor. Under the hood a card is a
canonical kata snippet, so the card library and the kata library are the same thing.

### 2.4 Buildings, not a shop

Upgrades are buildings and tools that appear on the campus, each introducing the Kata tier it
unlocks:

| Upgrade | On the campus | What it makes visible | Kata tier |
|---|---|---|---|
| Reservations | cones on bays with a countdown | backfill: a short vehicle slipping into coned bays before the convoy arrives | `reserve` |
| Sensors | a weigh station on the road | a vehicle's true length beside the length it claimed | `sensor` |
| Fairness | a ticket booth per neighbourhood | rings become share meters against entitlement | `fairness` |
| Preemption | a tow truck | a running vehicle pulled out and returned to the road, spilling the work it lost | `preempt` |
| Routing | a motorway to a second campus | a vehicle traveling the motorway and the transfer delay it pays | `route` |

### 2.5 Rhythm: days, weeks, cities, endless

Time runs in **days and weeks** with a soft day-night tint. Pick a mapping from simulated seconds
(one simulated day is a fixed number of sim hours; level horizons become a number of weeks) and
record it. At the **end of each week** the game pauses and offers a **choice of two** upgrades drawn
from what the player does not yet own and is eligible for; the player takes one. This replaces the
credit shop. Credits and belts remain as lifetime progression and for share cards; they are no
longer a purchase currency. Record this decision.

**Cities** are the levels: each a different campus shape and job mix, mapped from the existing nine
levels (keep their lessons and their order; retitle if a city name helps). **Endless** is one city
that grows: a new neighbourhood every few days, arrival rates that ramp, until a ring overflows. The
run's score is jobs completed and it is the leaderboard-of-one. Endless needs a deterministic, seeded
growth generator in the engine.

### 2.6 Two views, one language

The campus is the play view. The **strip** (bays over time, the phase one timeline done properly) is
the post-run review, because the top-down view loses the time axis and review is where the player
studies what happened. The two views share colors, vehicle shapes and state treatments. The strip
draws the engine's real placements, reservations as ghosts, requested versus actual extents,
preemptions and transfers, with scrub, zoom and a utilization heat band.

---

## 3. What stays fixed

- The Python engine is the only simulator; the browser runs it through Pyodide and the one JSON
  bridge. Nothing that decides is reimplemented in TypeScript.
- Kata's syntax and semantics. You may add builtins only if a campus feature needs one, with a spec
  update, tests and a Decision Log entry.
- Share cards verify with `dojo verify-card` and replay in the browser. Redraw them in the new art;
  do not weaken the tamper evidence.
- Static hosting on GitHub Pages, localStorage persistence with a versioned save and a migration
  from the phase one save.
- Accessibility: keyboard path for every interaction, names and roles, live regions for state
  changes, `prefers-reduced-motion` honored completely, contrast validated in both themes.

---

## 4. The tutorial and progression specification

The player must never see a feature before the game has made them want it. Every feature is
introduced as: a pain the player has just felt, then the tool, then a guided first use. Build this
as data (a scripted sequence of triggers and callouts per city) so it can be tuned without code.

**City 1, "Four bays".** One neighbourhood, four bays, slow arrivals. A guided hand shows tap
vehicle, tap bay (drag also works). Nothing else is on screen: no booth, no rings, no HUD beyond a
clock. The first convoy arrives and needs all four bays; the player learns adjacency by trying.

**City 1, day 3.** A second neighbourhood appears; rings appear with a one-line explanation the first
time one moves. Arrivals speed up until the player falls behind. Only then does the booth appear:
"Staff the booth." The player opens it and finds three rule cards: oldest first, shortest first,
biggest first. They slot one and watch the traffic change. The week ends; the first upgrade choice
is offered with a two-sentence explanation of each.

**City 2, "You cannot keep up".** The booth is staffed from the start. The player may swap cards and,
mid-week, is invited to edit the one line on a card (the order key). The full text of the card is
shown beside the line so they see it is the same thing.

**City 3, "The convoy that never parks".** Starvation. Reservations arrive as the weekly choice
(offered first). The player places a cone by hand once, guided, then the `place` card unlocks with a
second module. The editor opens in full for the first time, prefilled with the two cards they have
been using as text.

**Cities 4 to 9.** Each introduces its building the same way. Every new builtin is introduced by the
building that unlocked it, with the booth's why-panel showing it in use on the first decision.

**Endless** unlocks after city 3 and is surfaced on the city board with the player's best.

Also: a persistent, unobtrusive **help drawer** listing every concept and builtin the player has
unlocked, each with a one-paragraph explanation and a "show me" that highlights it on the campus;
tooltips for every metric on the review screen; copy that names the pain before the tool and never
assumes the player has heard the word "backfill".

---

## 5. Engine and bridge additions

Add, do not rewrite. Each is livedocs-gated; update module notes as you go and run the full suite
plus the Node smoke test after each.

1. **Placements in the run record**: node ids (and site) per job in `bridge.run` and `step_result`.
2. **Decision trace**: at each decision point record the module and slot that acted, the job chosen,
   the action (`place`, `reserve`, `route`, `preempt`, fallback with reason) and, for kata order
   modules, the computed key per queued job. Expose the last N through the snapshot, off by default
   so headless runs pay nothing.
3. **Per-user pressure** computed in the engine (deterministic): a ring value per user derived from
   that user's queued jobs' bounded slowdown, an overflow threshold per level, and the run-ending
   rule. Levels declare whether overflow ends the run (it does in every city and in endless).
4. **Reservations, preemptions and transfers** in the snapshot with enough data to animate them.
5. **Requested versus actual runtime** for finished jobs, respecting the same visibility rules the
   sensor builtin uses during the run.
6. **Calendar**: sim-time to day and week in one place in the engine so the CLI and the browser agree
   on when a week ends.
7. **Endless growth generator**: seeded, deterministic, declared in the level file.
8. **Upgrade offers**: a deterministic function of (save state, city, week) that yields the two
   offered upgrades, so a share card can reproduce a run's upgrade path.

---

## 6. Art direction

In the spirit of Mini Motorways, not a copy of it: flat geometry, a restrained palette, thin lines,
generous space, soft ambient motion, a calm day-night tint across the week. Original shapes for
vehicles, bays, the booth and each building. Everything is procedural, vector or CSS, generated in
repo; no downloaded asset packs, no raster sprites you did not generate, no fonts beyond Google
Fonts. Light and dark themes through CSS tokens on `:root`.

Color is information. Define the roles once in `Concepts/Art Direction.md` and generate the CSS
tokens and the Canvas color table from one source file:

- neighbourhood identity: categorical, at most eight, colorblind-safe, plus a label so color never
  carries meaning alone
- vehicle state: queued, chosen, reserved (ghost), running, done, timed out, preempted, transferring
- bay material: default, GPU, high-memory, remote site
- judgement: pass, gold, warning, overflow
- the clock, the week boundary, the playhead on the strip

Motion rules: every animation has a purpose you can state in one sentence, lasts under 400 ms
unless it is ambient, and has a reduced-motion equivalent that is an instant state change. Moments
that deserve more: a ring overflow, a gold score, the first time each building appears, a belt
promotion. Keep each under four seconds and skippable.

Sound is optional and last: a handful of synthesized Web Audio cues (placement, ring warning, week
end, gold), off by default, one toggle.

Produce **two mockups** (static HTML under `web/mockups/`, not shipped) of the campus at city 3 mid-
week, one warmer and one cooler, via two design sub-agents, render them, choose, and record the
decision with both screenshots in the vault.

---

## 7. Rendering and interaction requirements

- One Canvas 2D scene renderer for the campus, driven by the engine snapshot at a fixed tick rate
  with interpolation between snapshots; `requestAnimationFrame` only while something moves;
  devicePixelRatio-correct; resize-aware; 60 fps at endless scale on a laptop; measured.
- Hit testing for vehicles, bays, buildings and rings; hover and focus detail cards; touch works
  (tap vehicle, tap bay) since the whole interaction model is tap-first; test at 1280 px and 820 px.
- Hand placement: tap or drag a vehicle onto bays; it snaps, shows fit or misfit and the reason
  (not enough adjacent free bays, wrong lot, wrong campus), and a short shake on misfit. Keyboard:
  select vehicle, arrows to choose bays, Enter to place.
- The booth: a panel that opens over the campus; cards as draggable tiles into slots; the constrained
  one-line editor; the full CodeMirror editor with the existing Kata highlighting and inline errors;
  the why-panel reading the decision trace; step mode.
- Week end: traffic freezes, the two offers appear as buildings you can inspect, one is chosen, the
  building lands on the campus with its guided first use.
- The city board: nine city tiles with a live thumbnail of the campus, best score, belt marks, locks;
  endless with its best.
- Review screen: the strip, the metric reveal anchored on the strip (idle cells for utilization,
  longest waits, per-user share bars, the short jobs that waited longest), pass and gold bars on the
  gauge, share button.
- Share card in the new art with a campus thumbnail and the verification badge.

---

## 8. How to work

You orchestrate; sub-agents do the parallel and the independent work. Per stage: plan in a session
note, write contracts (snapshot schema, scene model, tutorial data format) first, spawn builders on
disjoint file sets, integrate, spawn a fresh-context reviewer, spawn playtesters, update the vault,
commit through the gate, tag `art-N`, push, confirm the Pages deploy.

- **Design sub-agents** for the two mockups and for the tutorial script.
- **Builder sub-agents** for engine additions, the scene renderer, the booth, the tutorial engine,
  the city board and review screen.
- **Reviewer sub-agents** with fresh context per stage; an adversarial one for the engine additions
  (determinism, hash stability where rules did not change, snapshot size bounds).
- **Playtester sub-agents** from stage 3 onward, every stage. Each gets only the game and a browser
  tool, plays from the start with no other instructions, and reports what they looked at first, what
  they misread, where they got stuck, what they wished they had been told, and which animations
  helped or annoyed. Their confusion is a bug. Record every report under `Sessions/`.
- **Visual regression harness**: render the campus and the strip for each city's golden run at fixed
  times to PNG (headless browser), commit baselines under `web/visual-baselines/`, diff in CI with a
  tolerance. Regenerate by script and review the diffs.
- **Performance log**: frame time on endless at 1x and 8x before and after each renderer change, in
  the session note.

---

## 9. Stages and acceptance criteria

### Art 0 — Audit and housekeeping
The audit note; screenshots moved; a ranked list of the ten most valuable changes.
**Accept:** note committed; `screenshots/` ignored; CI green.

### Art 1 — Direction, mockups, tutorial script
Two campus mockups, the decision, `Concepts/Art Direction.md` with palette, token source, type scale,
motion rules; the tutorial script for cities 1 to 3 as data with a schema; `Concepts/Campus.md`
describing the metaphor and every mapping in §2.
**Accept:** both themes pass contrast checks; the tutorial data validates; decisions logged.

### Art 2 — Engine additions and harness
§5 items 1 to 8; visual harness with baselines of the current UI so stage 3 has a diff target.
**Accept:** determinism tests pass; hashes unchanged for levels whose rules did not change and
regenerated by script where they did, with a reviewed diff; reference katas gold, FIFO not; decision
trace absent when disabled; harness in CI.

### Art 3 — The campus renderer
Scene model, renderer, hit testing, vehicles, bays, lots, road, rings, booth silhouette, day-night,
driving the Watch view for all nine cities.
**Accept:** everything drawn matches the snapshot (test on placements and ring values); 60 fps at
endless scale; reduced-motion path verified; baselines regenerated and reviewed.

### Art 4 — Hand play and the tutorial for city 1
Tap and drag placement with fit feedback, the guided sequence for city 1, the first booth reveal,
rule cards.
**Accept:** three playtesters with no instructions finish city 1 and staff the booth; their reports
show no step where two of three were confused.

### Art 5 — The booth, cards to editor, cities 2 and 3
Card slots, one-line editing, the full editor hand-off, the why-panel, step mode, reservations as
cones, guided cone placement.
**Accept:** a playtester who does not know the word backfill uses step mode on city 3 and explains in
their report why the reference kata beats FIFO; every `PolicyError` renders in the booth.

### Art 6 — Weeks, offers, buildings, cities 4 to 9
Week end and offers, each building with its first-use guidance, sensors, fairness meters, tow truck,
motorway and second campus, save migration from phase one.
**Accept:** playtesters reach city 6 unaided; offers are reproducible from the save (test); the
phase one save migrates.

### Art 7 — Endless, city board, review, share
Growth generator wired, endless on the board, the strip review with metric reveal, redrawn share
cards.
**Accept:** endless runs visibly harder each week until overflow; cards verify both ways; tiles show
real thumbnails.

### Art 8 — Onboarding polish, accessibility, help drawer, sound
Help drawer, tooltips, copy pass, keyboard and screen-reader pass on everything new, 820 px and
touch pass, optional sound.
**Accept:** a fresh playtester reaches city 3 and edits a card with no instructions; an automated
accessibility audit reports no serious issues.

### Art 9 — Ship
Pages deploy, README with screenshots and a short GIF, vault sweep, `livedocs coverage` clean,
final all-cities playtest with a report, `Sessions/Phase 2 Final Report.md`.

---

## 10. Definition of done

All stages tagged and pushed; the site live with the campus; CI green including the visual harness
and the Node smoke test; determinism tests pass; `livedocs verify` clean; `Home.md` updated with
phase two status, a Deferred list and a "Decisions a human should review" list; and a final report,
in your last message and in `Sessions/Phase 2 Final Report.md`, covering what changed, before and
after screenshots, playtest evidence per stage, frame-time numbers, every decision made on the
human's behalf, and what you would do next.
