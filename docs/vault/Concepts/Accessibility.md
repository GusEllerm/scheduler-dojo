---
tags: [concept]
---
# Accessibility

## In one line

Everything the timeline can say with colour and motion, the page must also say in text that a
keyboard and a screen reader can reach — the numeric scorecard is the accessible source of truth and
the Canvas is decoration on top of it.

## Why it matters here

The game's core feedback is visual: a Canvas Gantt lane, coloured bars, a moving playhead, a score
that ticks. Stage 10 made that feedback available without sight, without smooth motion, and without
a mouse, because a scheduling lesson you cannot read is not a lesson.

## The rules

1. **The scorecard is the ground truth.** `web/src/main.ts` renders `renderReadout()` into `#readout`,
   which is `role="status" aria-live="polite"` in `web/index.html`: when a run finishes the score,
   utilization, slowdown, wait p95, fairness, jobs and horizon are *read*, not just painted. Nothing in
   that subtree may be `aria-hidden`.
2. **The canvas explains itself in one sentence.** `labelTimelineRegion()` sets `role="img"` and an
   `aria-label` summarising jobs, lanes, horizon, policy, utilization and score, and names the controls
   the timeline module leaves visually bare (the speed select, the scrub slider). It is decoration for
   AT users, never the only carrier of a number.
3. **Dynamic regions are polite, never assertive.** `mountHud()` paints a `role="status"` HUD (belt,
   credits, next belt) and a toast lane for drift grants; `web/src/share.ts` marks the copy status and
   the replay-verification banner `role="status"`. No `aria-live="assertive"` anywhere — a live region
   that interrupts is worse than none. Per-tick gauges in hand mode are a plain labelled group, not a
   live region, precisely so they do not spam.
4. **Every control has a name.** Icon-only buttons carry `aria-label`: the shop close (`mountShop`) and
   the share controls (`mountShareButton` and its modal). Pickers are `role="group"` with a label
   ("Levels", "Play mode", "Run variants") and mode/level buttons keep `aria-pressed`.
5. **Modals are dialogs and are closable by keyboard.** The upgrade shop, the share modal, the campus
   booth (`web/src/booth.ts` `openBoothDialog`), the week-end offers panel (`web/src/offers.ts`,
   Art 6a — Take/Later are real buttons, the verdict line is `role="status"`, and a focusable
   pending-offers button in the campus controls reopens it while traffic is frozen) and the tutorial
   callouts (`web/src/tutorial.ts`, and the booth dialog in `web/src/booth.ts` via the shared
   `trapDialog`)
   are `role="dialog" aria-modal="true" aria-labelledby=<their heading>`;
   Escape closes them, Tab is kept inside the panel (`trapDialog` is the shared trap), and focus
   returns to the control that opened them. The tutorial's "Skip tutorial" button sits above the
   callout overlay in z-order so the escape hatch is reachable while a callout is open.
6. **Focus is always visible.** `web/src/style.css` puts a 3 px amber (`#ffd479`) `:focus-visible` ring
   on every link/button/input/select and on the CodeMirror kata editor (which otherwise suppresses the
   native ring). The ring colour clears AA on every surface in the theme. A skip link jumps to the
   timeline (`#timeline`, `tabindex="-1"`, with a `:focus` ring) so keyboard users need not tab through
   nine level buttons.
7. **Reduced motion is honoured.** A `prefers-reduced-motion: reduce` block kills transitions and
   animations, and `web/src/main.ts` reads the same query to pass `autoplay: false`, so the timeline
   waits for an explicit Play instead of running a canvas animation. The Art 5b misfit shake is an
   `animation` (so the block neutralises it) and `CampusPlay.showMisfit` additionally skips the shake
   outright when the player asked for reduced motion — the red edge and the reason line carry the
   message alone.
8. **Contrast is checked, not assumed.** Text sits on `--text: #dbe2ec` / `--muted: #9aa7b8`
   (≈7:1 on the panels), the amber/green/red states are ≥4.5:1, and dimmed cards use `opacity: 0.85`
   rather than a lower value that would push their text under AA.
9. **The campus canvas is a keyboard target (Art 5b).** In hand play `web/src/campus-play.ts` gives
   the canvas `tabindex="0"` and an aria-label that states the keys (live play leaves it unfocusable
   decoration — there is nothing there to choose). With focus on it: arrow keys cycle the selected
   vehicle in engine road order, then slide its staged bay window along the lot (a k-bay vehicle
   needs k bays side by side, which is the lesson); Enter attempts the park — the engine decides via
   `hand_place`; Escape clears the bays then the vehicle. The canvas takes the same
   `:focus-visible` ring as every other control (`web/src/style.css`).
10. **The campus rail is structure, not paint (Art 6b).** The fairness meters
(`web/src/campus-play.ts` `paintFairness`, `fairnessShares` in `web/src/campus.ts`) are a
`role="list"` of `li` rows — owner swatch, label, a served-share bar with the entitlement tick, and a
sentence carrying every number (`43% served of 12% submitted · 11m parked, 3h54m claimed · 20
waiting`). The bars are `aria-hidden`, the block is **not** a live region (it repaints per snapshot —
rule 3), and the `warn` state is a ◆ glyph plus the word "starved", never hue alone. The campaign
chips ("Next city ▸", "Endless ▸", "◀ Back to campus") are plain buttons in the labelled
`role="group"` toolbar, so they sit in tab order where the campus controls are; the Endless chip is
`aria-disabled` while the mode does not exist yet, never `display: none`, so its unavailability is
discoverable.
11. **Hand-play state changes have exactly one polite channel each (Art 5b).** Selection, staged
    bays and the cone hint are announced through the campus toast (`role="status"`,
    `aria-live="polite"`); a `hand_place` refusal goes to the reason line under the hand bar
    (`role="status"`, `aria-live="polite"`, the engine's `PolicyError` code kept verbatim —
    `misfitReason` in `web/src/campus-why.ts` says the plain words, never a paraphrase away); the
    booth's why-panel list is `role="log" aria-live="polite"` and appends only NEW decision records
    keyed by the engine's `seq`, so a stepping player hears what changed rather than the whole
    panel per frame. Per-frame canvas motion stays out of live regions entirely.

## Verifying an a11y change

`cd web && npx tsc --noEmit` must stay clean (these are ARIA-only edits), then with `agent-browser` (all verified against `npm run dev` on a free port; see `screenshots/stage10-*.png`):

- `stage10-1-focus-skiplink.png` — first Tab reveals the skip link, ringed.
- `stage10-2-focus-upgrades.png` — Tab reaches the HUD's Upgrades button (ring visible).
- `stage10-3-shop-dialog.png` — Enter opens the shop as a labelled dialog with focus on the close
  button; Escape closes it and focus returns to Upgrades (checked via `document.activeElement`).
- `stage10-5-share-dialog.png` — the share modal opens with focus in the link field; Escape closes it
  and focus returns to the Share button.
- `stage10-6-kata-mode.png` / `stage10-7-focus-kata-editor.png` — Tab into the CodeMirror kata editor
  computes `outline: 2px solid #ffd479` on the `.cm-focused` editor.
- `stage10-4-reduced-motion.png` — with `set media reduced-motion` + reload, the playhead sits at 0s
  and the control reads "Play" (no autoplay), and the loader fill's computed transition is ~0s.

A `MutationObserver` on `#readout` fires once per run-variant switch, which is the announcement the
screen reader would make.

## Known gaps

- Hand/kata modes mount their own timelines (`web/src/hand.ts`, `web/src/kata-play.ts`) and do not read
  the reduced-motion query, so their autoplay still animates. The watch path is covered.
- The campus canvas explains itself through announcements, not structure: a screen reader hears the
  selection/staging state and the booth's decisions, but there is no per-vehicle list to browse (the
  strip's job table would be that). The Art 6b fairness rail is the first *structural* campus readout.
- The 820 px pass (Art 6b) is measured — boxes and a clipped-text sweep at 820 and 1280 — but the
  campus has had no screen-reader reader test; the offers dialog's focus order was checked with Tab
  only (`Sessions/2026-10-02 Phase 2 Art 6.md`).
- The hand campus is keyboard-playable; the *live* campus intentionally has no focus target (nothing
  to choose while the booth decides), so its only controls are the Pause/Step/speed buttons.
- Share-card PNGs are images with an `aria-label` summary; the card's own text is not selectable.

## Related

[[Determinism]] (why the scorecard numbers are trustworthy), [[Scoring]], [[Kata]], [[Levels]].
