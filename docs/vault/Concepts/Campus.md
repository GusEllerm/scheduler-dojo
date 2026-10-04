---
livedocs: code
tags: [concept, phase-two]
---
# Campus

> [!abstract] The metaphor
> The scheduler is a **campus**: neighbourhoods (users) emit **vehicles** (jobs) onto a **road**
> (the queue) that park in **bays** (nodes) grouped into **lots** (partitions); a second campus
> across a **motorway** is a site; the **dispatch booth** at the lots' entrance runs the rules —
> the kata. The picture is a rendering *of* the engine snapshot; **nothing that decides lives in
> the renderer** (see [[Pyodide Bridge]]). The two views — campus (play) and strip (review) —
> share colors, shapes and state treatments ([[Art Direction]]).

## Every mapping (the contract)

| Picture | Engine fact | Source |
|---|---|---|
| neighbourhood (shape + label + color) | one per job `user` | snapshot `jobs[].user` |
| patience ring on a neighbourhood | that user's bounded-slowdown pressure, capped at overflow | engine `pressure` per user (§5.3) |
| vehicle = a job on the road | queued job, drawn in **policy-rank order** | engine-ranked queue (trace), not client sort |
| vehicle **width** | nodes requested | `JobSpec.nodes_req` |
| vehicle **length** | walltime requested | `JobSpec.walltime_req` (sensor upgrade reveals *actual* length, §5.5) |
| bay | one node | `Cluster.nodes` |
| lot (material) | one partition | `Cluster.partitions` |
| second campus + motorway | a site + transfer delay | `route`/`transfer_secs` (§2.4 of the brief) |
| dark bay | idle node-seconds | snapshot gaps |
| vehicle parked across k bays | whole-node allocation, k adjacent nodes | `placed_nodes` (§5.1 — must be real ids) |
| jam = road grows | queue length under the active policy | snapshot `queue` |
| one color flooding the road | one user dominating the queue | `user` on ranked queue |
| reservation cone + countdown | a `reserve` **intent**, or a viewer hand hint (Art 5b, below) | snapshot `reserved` (`job -> intended start`) — never guessed bays |
| why-panel line | one decision-trace record | `Scheduler._trace_event` / the `KataPolicy` tracer, via `start(trace=N)` (§5.2) |
| staged bay set | the player's own pick, client-side | `hand_place` is the truth; the ghost is a preview |
| tow-truck pull-out + spilled work | preemption, progress lost (no checkpoint) | `preempt_count`/`run_epoch` |
| rings overflowing ends the run | level-declared rule | engine overflow check (§5.3) |

## The calendar `[agent decision]`

**One sim-day = 86,400 sim-seconds; one week = 7 days** — and **a city's horizon spans exactly one
week**: day *d* of the week is `floor((t - t0) / (duration / 7))`. Weeks for endless use the literal
86,400 s day. The day-night tint maps position-within-day, so short levels still show a full arc.
Alternatives rejected: literal 24 h days (levels are 8–33 h horizons → less than two days per city,
no weekly rhythm) and a fixed compressed-day constant (drifted out of sync with week ends at long
horizons). One function, in the **engine** (bridge exposes day/week), so CLI and browser agree on
when a week ends (§5.6). See [[Decision Log]].

## Patience rings

Per user, at every event/tick batch (`Scheduler._compute_pressure`): `ring = max over unfinished
jobs of clamp(wait / grace, 0, 1)` where `grace = (cap - 1) x est`, `est = walltime_req` (what the
job *claimed* — the same estimate the picture shows), and `cap` is the level's declared overflow
threshold (`pressure.cap`, default 2, so cap=2 means "a job that has waited as long as it said
it would run has popped its neighbour's patience"). Ring ≥ 1 ⇒ `overflow_user` is set; every city
and endless declare `end_on_overflow: true`, so the run stops there and unfinished jobs score as
unfinished. A user's ring relaxes only when their queue drains. Deterministic: integer tick, fixed
job-id order, one float division ([[Determinism]]). Levels without a `pressure` block never compute
rings and their hashes are byte-identical to phase one.

## Days, weeks, offers

At each week boundary the engine freezes (the run pauses at that sim time); the offer pair is
`deterministic_save_city_week_offers(save, city, week)` — the eligible, unowned, prereq-satisfied
upgrades sorted by id, seeded draw of two — **in the engine/progression module**, so a share card
replays the upgrade path (§5.8). Credits/belts stay lifetime record, not currency
([[Progression]], [[Decision Log]]).

## Week end and buildings on the campus (Art 6a)

**The freeze is the campus's, not a timer's.** `CampusPlay` asks `calendar_at` once at run start
(where week 1 ends) and watches every snapshot's `week`/`now` (`weekTick`): at the boundary
traffic freezes (live: the rAF loop parks; hand: `Time \u25b6` disables, and pressing it re-opens the
choice), the two offers open via the ONE offers overlay component (`web/src/offers.ts`, reused
verbatim by the tutorial's `pick_of` beats), and taking one is the FREE `offer_accept` — the
engine refuses an id that boundary never offered (`not_offered`) or a week that already chose
(`accepted`). Credits never move. "Later" closes the panel but leaves the week unresolved — the
pair is recomputable — and a focusable **pending-offers hatch** button stays in the campus
controls so a freeze can never trap the player (it also reopens the panel if the tutorial is
skipped across a frozen week: `tutorialManaged(false)`). Resolving moves the cursor to
`frozenWeek + 1` and asks `calendar_at` where the NEXT boundary is; a run that finished while the
choice was pending lands its result then (`pendingFinish`), so no turn ends broken. The freeze
itself also fires the `week_end` tutorial event: hand snapshots pin `week: 1` (hand sessions
register no level for the snapshot calendar), so a runner watching snapshots alone could miss the
boundary its beats gate on. The whole feature is inert in the manual visual harness
(`manual: true`), which is why the Art 3 baselines are byte-identical after Art 6a.

**Buildings are sprites, not a shop.** `progression_view.buildings` (owned upgrades, one table
with the offer cards — `BUILDINGS`) feeds `LayoutInput.buildings`; `campus.ts` resolves each
engine `anchor` (`lot`/`road`/`neighbourhood`/`edge`) to a deterministic box and
`campus-render.ts` paints a flat token sprite per id (cone locker rack, weigh-station scale hut,
community board, tow truck on its pad, motorway gate), dimmed + `?` while a tutorial has not
revealed it (non-tutorial owns \u21d2 revealed). A new sprite lands with a caller-side pop
(`pulseAnchor("building:<id>")`, CSS \u21d2 reduced-motion is static), and hit-testing a building
shows its name + blurb + `buildingHint` ("how it shows up"). **First-use guidance** is one-shot:
when a revealed building's mechanic first appears in the scene (a cone, a timeout vehicle, a moved
ring, a transferring vehicle — never a timer), its callout shows once and the
`buildingSeen:<id>` pref suppresses it forever. Accepted weeks live in the save's `weeks` ledger
(v3); `persistence.save`'s merge is additive, so the ledger survives every UI write (verified
round-trip; see `Sessions/2026-10-02 Phase 2 Art 6.md`).

## The fairness rail, the chain, and 820 px (Art 6b)

**The community board is a rail, not a paint.** `CampusPlayOptions.rail` is an optional element the
shell mounts beside the canvas column (`main.ts`: `.campus-body` = stage + rail), and it is
**never** passed by the visual harness — the canvas's `parentElement` geometry is untouched, which is
why the Art 3 baselines are still byte-identical. Inside it `paintFairness` keeps one
`.campus-fairness` card: a `role="list"` of `li` rows, each with the OWNER token swatch, the label, a
served-share bar with the entitlement tick at the submitted share, and a text sentence carrying every
number (`fairnessShares` in `web/src/campus.ts` does the only fairness arithmetic on the client:
`served = min(end, now) - start` vs `claimed = est` per job, summed over sorted user ids, integer
seconds — pure, no clock, no decisions; the engine's `fairness` metric stays the score's truth). The
bars are `aria-hidden`; a neighbour served **under half** its submitted share gets the `warn` token
marker (a ◆ glyph *and* the word "starved" — colour never carries it alone, [[Accessibility]]). The
rail is structural DOM, not a live region: per-snapshot text that never interrupts (rule 3).

**When it shows** (§2.4 "rings become share meters"): `fairnessPinned` is true when the save owns
`fairness` *and* the sprite is revealed (free play ⇒ owned ⇒ revealed), or when a script's
`reveal {building: fairness}` beat has flashed it (city 5 hangs the board). Otherwise the rail stays
`hidden`, which also means the canvas keeps its full width.

**Campaign chaining is the script's ending, not the picker's.** `TutorialRunner.finish(…, completed)`
calls `TutorialOptions.onEnd` with the script's `end.next` / `end.endless_unlock` — and ONLY for a
real ending: skipping out of a script or a teardown `destroy()` ends a script without finishing a
city, so neither offers the chain. `main.ts` answers with a "Next city ▸" chip in the campus toolbar
that sets `campusCity` + `campusVariant = "hand"` + `campusTutorial = true` and calls
`startCampusRun()`: a fresh hand campus on the *edition* of the next level with its script re-attached
— no level picker, `prefs.city` remembers where the chain got to. `endless_unlock` (city 3, city 9)
flips an availability chip instead; Endless itself is Art 7. A hand city whose script hands off to the
kata editor (cities 1-2 have no kata mode) gets a "◀ Back to campus" chip so the hand-off cannot
strand the chain ([[Tutorial]]).

**820 px.** `.campus-body` is a row at desktop widths and stacks under 860 px (rail under canvas);
the campus control/hand/variant bars wrap, the offers panel goes one card per row and narrows. No
behaviour, no canvas geometry — verified with measured boxes and a clipped-text sweep at 820 and
1280 (`Sessions/2026-10-02 Phase 2 Art 6.md`).

## The endless campus and the review screen (Art 7a)

**Endless is one LEVEL the engine builds.** `main.ts` hands the growth curve (one neighbourhood,
+4 days per new neighbour, +60 % arrivals per literal week, a 30-day horizon, `cap: 6`) to
`bridge.endlessLevel` (§5.7) — `bridge.endless_level` returns a plain stepable inline level (the
materialized stream, `duration` = horizon, `pressure.end_on_overflow`) that `CampusPlay` drives
like a city run, recognized by `id === "endless"` (`endlessMode`). Its clock labels **literal**
86,400 s days and 7-day weeks (the city mapping stays the compressed one-week one); a week
boundary advances the calendar and does NOT freeze — `progression.offers` is keyed by integer
city with no endless key, and the generator's ramp IS the curve (§2.5). The booth runs the
engine's `shortest_first` policy. The stream is seeded from the save (`prefs.endlessSeed`, first
launch `20261002`); "New seed ▸" rerolls with a UI-side LCG step from the shown integer —
`Math.random` never touches a sim-bound stream ([[Determinism]]).

**Pacing is presentation.** The watch plan's cadence (`step` × 60) suits a compressed city week
but crushes a literal 30-day stream into ~40 s of watching, so the endless campus passes a
`simRate` override to `CampusPlay` (3,600 sim-s per wall-s at 1× — one literal day ≈ 24 s;
review F3). The stream, the hashes, and the city pacing are untouched.

**A step target never caps below the engine's horizon.** Step snapshots publish `horizon_end`
(t0 + horizon) and `simTarget` takes `max` of its cap and it — the fixed `duration + 2·step` cap
could sit below the horizon on t0>0 levels and pin the clock (the endless stall, review F1). On
the engine side stepped runs END at the horizon, and even when the LAST EVENT predates it
(empty heap at/after `t0 + horizon`) done lands the observed clock ON the horizon — a city run's
week-end offer ritual depends on `now` reaching the boundary ([[scheduler_dojo-sim-scheduler]],
[[Pyodide Bridge]]).

**The overflow moment.** `step_n`/`step_until` report `done` on the stop frame; `afterDone` holds
one ring-pulse flash of the overflowing neighbour's road vehicles (`overflowMoment`, the
`.campus-overflow-flash` CSS pulse in the `overflow` token, ~0.9 s) before `finish`. The visual
harness never flashes and reduced motion finishes instantly — the Art 3 baselines are
byte-identical (verified, level1/level3, after this slice).

**The review screen** (`web/src/review.ts`, §2.6) opens itself at the end of a campus run (live,
hand, endless); every other finished run gets a "Review ▸" button on the readout
(`mountReviewButton`) instead of a page-load modal. It recomputes nothing: the strip is the
phase-one `mountTimeline` mounted paused, the share rows are the rail's `fairnessShares`, and the
mistake lines are *derived* — timeouts, never-parked, starved shares, and the overflow line
timed at `overflow_time` (the ring-FILL instant — `end_time` is the last FINISH and trails it,
review F5). `shareJobs` null-normalizes `start`/`end` because **Pyodide turns Python `None` into
`undefined`** (the same quirk phase one guards at `main.ts`/`timeline.ts`) and `fairnessShares`
recognizes only `null` — unnormalized, one unfinished job poisons every share with NaN. Endless
adds the best-score line instead of belt logic: literal days survived (`floor(end_time/86400)`)
+ vehicles served, persisted in `prefs.endlessBest` (days first, served as tie-break) and shown
on the "Endless ▸" chip. Evidence (default seed `20261002`): the run overflows at
**t = 1,905,852 s — day 22.05, `user4`**, the screen reads 22 days / 928 served; week traffic
density goes 0-on-campus (day 2) to ~10 queued at the day-16 jam at 60 fps —
`Sessions/2026-10-02 Phase 2 Art 7.md`.

## The city board and the share card (Art 7b)

**A tile is an engine frame, not an icon.** `web/src/board.ts` (`openCityBoard`) puts nine city tiles
plus Endless in one dialog, and each tile's thumbnail is produced by `web/src/campus-thumb.ts`:
`start(level, policy)` → **`SLICES` (6) × `step_until`** up to 30 % of the level's horizon → the same
job-union `collect` the live loop does → `buildScene` → `CampusRenderer`. The slices are not
politeness — `_snapshot.unseen` only lists jobs that have not submitted *yet*, so a single jump
leaves every job that submitted between 0 and the frame as an unknown-owner, zero-length shell (the
`user: "?"` fallback) and the tile would draw a campus the live view never shows. The frame is
painted into an **offscreen** canvas at 640×320 (`campus.ts`' layout needs that much room: its lots
start at `width - PAD - 300` and its road band at `height - PAD - 150`) and `drawImage`d into the tile, so the
board never mounts a canvas `CampusPlay.resizeNow()` could measure — the Art 3 baselines are
byte-identical with the board shipped (verified, level1/level3). Frames are cached per page session
by everything that can move a pixel, and the stepping handle is freed with `step_result` (the bridge
has no other close; a drain costs about one watch-mode run of that level, which is cheaper than
leaking a scheduler per tile — if the run already ended at the frame the handle is simply left
behind: ≤ 10 per page, gone on reload). Tiles that are still drawing say "drawing…", and a failed
frame says so; there is no placeholder art anywhere in the board.

**Tile frames read the LEVEL's bars, not the belt** ([agent decision], Art 7b): `tileVerdict` maps
the save's best for that level against that level's own `pass_score`/`gold_score` — gold bar ⇒
`--sd-gold`, pass bar ⇒ `--sd-ok` (the palette's *pass* role), played below pass ⇒ `--sd-warn`, never
played ⇒ dim dashed. The lifetime belt was rejected: it is a function of credits across every level
([[Progression]]) and would paint a city the player never finished in the colour of an unrelated
record. `--sd-ok`/`--sd-warn` rather than invented silver/bronze hues, because those two verdicts are
already judgement roles in the one-source palette ([[Art Direction]]). Every colour is restated as
text ("gold bar" / "pass bar" / "below pass" / "not played · 🔒 locked").

**Locks are the owned frontier:** `frontierCity` is the first city with no recorded pass; a tile is
locked when its level has never been completed *and* it is not that frontier. A locked tile stays a
focusable button that answers in the board's `role="status"` line with the way out ("complete city 3,
the next city in the chain") instead of doing nothing. Tapping an unlocked tile starts the city
through the SAME Art 6b chaining rules as "Next city ▸" (its edition, hand traffic, script attached,
`prefs.city` remembered) — the board is a shortcut to the chain, never a second way through it.

**Share cards in the new art** (`web/src/share-scene.ts`, §5.8/§7). The review screen's "Share this
run" mints with one engine call, `share_encode(level, seed, policy|kata)`, which *runs* the level and
embeds that run's `trajectory_hash`; the card element carries a compact text card plus a **campus
thumbnail** drawn by the same painter at 55 % of the run's own traffic. The link is
`<origin><pathname>#card=<base64url body>` — the **hash**, not the query, because Pages serves any
hash with no server rewrite (phase one's `?c=` needed the query). Opening one decodes it client-side
for metadata, then lets the engine decide: `share_replay` re-runs and compares hashes, so the badge
says "verified replay ✓" or the banner says "card tampered ✗" with both hashes spelled out, and only
a verified card offers "Watch the replay ▸".

- **The envelope did not change** (`CARD_VERSION` 1, `share/card.py` untouched). A city run rides it
  because `encode_card` embeds the dict it is handed, and the mint hands it the **city edition** (the
  patched `duration`/`generator` of the level the tutorial system loads), so the card replays the
  week the player watched. Phase-one cards still verify, both directions (evidence: a literal card
  minted before Art 7b, replayed on the old `?c=` route).
- **Explicit-`jobs` levels (7 and 8) cannot carry their jobs in a URL.** On replay the shipped
  `levels/levelN.json` is merged **UNDER** the card's embedded fields — jobs from the file, every
  asserted fact from the card. The merge drops the card's `null`s (`withoutNulls`): `encode_card`
  writes `level.get("sensors")`, so a level without sensors embeds `sensors: null`, which
  `replay_card` tolerates (it runs `validate=False`) but `run` rejects outright — a card that
  *verified* and then died on "sensors must be a subset of …" was the honest way this was found.
- **A hand-played city shares the city, not the placements**: the envelope has no room for them, so
  the card replays that level's own policy at the same seed and says so in its tag line (the phase-one
  precedent, `shareContextFor`).
- **Endless shares nothing** ([agent decision], Art 7b): its stream is materialized (a 30-day horizon,
  ~1.9 k jobs) and no URL-sized card can carry it, so the endless review and the endless tile offer
  no share button at all, and the tile says "no share card (the stream is not URL-sized)". A minted
  `level_id: "endless"` card would also break `share_encode`'s level_id branch (it cannot hash a
  level it was not given).
- **A card view never completes a level**: the boot path nulls the pending watch-run record, so
  opening someone's link cannot farm credits or move the board's frontier.

Evidence: `web/scripts/art7b_evidence.mjs` (board with a gold + a pass + six locked tiles and ten
pixel-checked thumbnails; mint → fresh browser → badge → hash equality logged as
`dojo-share-mint`/`dojo-share-replay` → replay opened in watch mode; a one-character flip; and a
committed phase-one card literal) — `Sessions/2026-10-02 Phase 2 Art 7.md`.

## Scene vocabulary (renderer contract)

The TS scene layer owns *sprites and layout only*: `vehicle` (job + state: queued/chosen/reserved/
running/done/timeout/preempted/transferring), `bay`, `lot`, `neighbourhood`, `ring`, `booth`,
`building`, `road`, `motorway`. `buildings` (Art 6a) is `{id, name, blurb, anchor, revealed,
box}[]` — empty by default, so the visual harness never sprouts sprites. It builds from bridge
snapshots, **interpolates** between ticks, and derives no judgement. Hit-test targets: vehicle, bay, building, ring → detail cards. If the snapshot
lacks a fact (e.g. true placements), that is an engine bug to fix in [[scheduler_dojo-bridge]], not
a renderer workaround — the phase-one lane repack is the cautionary tale.

## Hand play on the campus (Art 4)

`CampusPlay.create({ mode: "hand" })` runs the same engine through `hand_start`/`hand_place`/
`hand_tick`/`hand_result` ([[scheduler_dojo-bridge]]): nothing auto-places, the engine still
validates every `hand_place` (a `PolicyError` is a red campus toast, never a crash), and parked
vehicles show as running in the same snapshot — the scene is built from step snapshots exactly like
the live view, and `chosen` is null while the booth is unstaffed (nothing was "picked"). Hand
additions to the scene model are optional fields (`selectedId`, `staged {bays, fits, user}`,
`booth.revealed`) so live frames are pixel-identical: a staged ghost is owner color at low alpha
edged `ok`/`overflow` (a client-side guess; `hand_place` is the truth), an unrevealed booth is
dimmed and refuses taps. Tap geometry: `vehicleBox` mirrors the renderer's `roadSlots` exactly, and
the road band paints **before** the queued vehicles (Art 3 painted it after, which hid the queue —
fixed in Art 4). A hand-mode canvas resize re-projects the scene (the live loop self-heals every
frame; the hand view has no frames). `hand_start` has already processed the first arrival batch, so
those jobs are in no `unseen` list: the viewer seeds its job union from a decide-nothing idle
`start` of the same level (arrival data is engine data, not a decision). See
`Sessions/2026-10-02 Phase 2 Art 4.md`.

## The booth's *why*, step mode, and cones (Art 5b)

**The why-panel** (`web/src/campus-play.ts` + `web/src/campus-why.ts`) is a collapsible `<details>`
in the campus stage over the engine's decision trace. A live campus run asks for it —
`bridge.start(..., trace=24)` (`start_run` → `_trace_event`), and every `step_n`/`step_until` result
carries the ring buffer (`_step_out`); `run`, `hand_start` and the CLI pay nothing. Rows are keyed by
the record's `seq`, appended only when new and dropped when they fall out of the ring, so the
`role="log"` region announces what happened rather than re-reading the panel. Phrasing is per
action: `place` ("j00004 parked on n0 n1 — shortest first", transfer noted when non-zero), `preempt`,
`route`, and `fallback` ("no fit — kept FIFO order (`no_nodes`)" — an unmapped code prints the
engine's own word). The **one inference** is naming an order key: the `order` record carries the
computed key per queued job, so the first key component is compared against that vehicle's own engine
facts (`est`, `submit`, `nodes` — an exact match, in a fixed candidate order) and "shortest / longest
/ biggest / smallest / oldest / newest first" is what the key *demonstrates*, else "an order key of
its own". No policy label is consulted; nothing is decided client-side. Owner color rides on a small
bar rather than the sentence, because palette tokens are tuned for the canvas, not 12 px text
([[Art Direction]], [[Accessibility]] rule 8).

**Step mode** is the campus control row's `Step ▸` (live runs only — a hand campus has no booth to
step, and its clock is `Time ▶`). Pressing it pauses the rAF loop; each press is
`bridge.step_n(handle, 1)`, i.e. **one EVENT batch** (`Scheduler.step_events` — every event at one
timestamp plus its one decision, which is exactly the unit trace records come from), then
`step_once` + a why-panel refresh + one settled frame. `Resume` re-bases the wall clock and the loop
restarts; the tutorial's `set_mode "step"` routes to `setStepMode(true)`.

**Cones** come in two kinds and the painter tells them apart by data, never by guessing:

- *Engine cones* — `reserved` in the snapshot is a **`reserve` intent** (`job -> intended start`) and
  carries no bays, so the cone hangs on the vehicle, never on a bay the engine did not name, and the
  countdown reads `t - now` in sim time.
- *Viewer hand cones* (`Cone.from` added so the countdown bar spans its own window instead of a
  guessed constant) — the "Cone it" button on the hand bar. It draws a `Cone` over the bays the
  ENGINE's own FIFO hint (`suggestions` from `hand_start`/`hand_tick`) would hand that vehicle — the
  player's staged bays win when they are the right size — and decays at the later of "those bays are
  free" and the vehicle's claimed length, pruned by sim time inside `step_once` (never a timer, so a
  paused campus holds its cones and a catch-up step drops expired ones). **It books nothing**: the
  bridge has no hand-mode `reserve`, so the button, the toast and the note all say it is a hint on
  the map. It fires the `cone_placed` tutorial event and is what city 3's guided cone beat completes
  on.

**Misfit feedback** (hand): a `hand_place` refusal maps its `PolicyError` code (`no_nodes`,
`mismatch`, `already_running`, `deps_unmet`, `unknown_job` from `scheduler_dojo.sim.errors`) to a
campus sentence with the code still visible, a red edge plus one short shake on the bar (reduced
motion: the edge only), and a reason line under the bar — see [[Accessibility]].

Keyboard play, the canvas's `tabindex`, and which live regions announce what: [[Accessibility]]. See
`Sessions/2026-10-02 Phase 2 Art 5.md`.
