---
livedocs: code
tags: [concept, phase-two]
---
# Art Direction

> [!abstract] The rule
> **Color is information.** Every hue on the campus answers a question ([[Campus]]): who owns it,
> what state it is in, what a bay *is*, or what the verdict was. Flat geometry, restrained palette,
> thin lines, generous space; ambient motion only where it says something. Original, procedural
> vector/Canvas/CSS — no asset packs, no raster sprites, no fonts beyond Google Fonts (we ship none).

## One source of truth

`web/tokens/palette.json` is the only file that names colors. It generates both consumers:

- `web/scripts/gen_tokens.mjs` → `src/tokens.css` (`--sd-*` custom properties on `:root`, light +
  `data-theme="dark"`) for DOM, and `src/tokens.ts` (`readTokens()` — the Canvas table reads the
  *live CSS variables*, so theme switching repaints the campus with no second palette).
- `web/scripts/check_contrast.mjs` → the WCAG gate: every pair in `contrast_pairs` must pass in
  **both themes** (text ~4.5:1, shape fills ~3:1, large flat areas ~1.6:1). Run in CI; fails the build.

## Color roles

- **Neighbourhood identity** — `nb-1..8`, categorical, colorblind-safe (checked in both themes);
  always doubled with a **distinct shape** (hexagon, diamond, pentagon, triangle, octagon…) and a
  **text label**, so color never carries meaning alone.
- **Vehicle state** — queued / chosen / reserved (ghost) / running / done / timeout / preempted /
  transferring. State is fill *treatment* (solid, outlined, hatched ghost, dashed while transferring)
  as much as hue; `veh-chosen` also gets the wave-mark.
- **Bay material** — default (asphalt), GPU (fine hatch), high-mem (dots), remote-site, idle, plus
  the **dark bay** = wasted capacity (the game's most important negative space).
- **Judgement** — pass/gold/warning/overflow, used only on verdicts: rings, bars, week pips.
- **Chrome** — clock, week band, review playhead.

## Type & scale

System stack (no webfont): UI 13–15 px, labels 11 px uppercase letterspaced, numbers on the review
screen only. Canvas text mirrors the DOM scale. Spacing on a 4 px grid; bays are the unit: vehicle
widths are exactly 1–4 bays wide (nodes requested), matching [[Campus]]'s mapping table.

## Motion rules

Every animation states its purpose in one sentence, runs < 400 ms, and has a
`prefers-reduced-motion` equivalent that is an *instant* state change (a 0 ms transition, not a
fade):

| Moment | Says | Duration |
|---|---|---|
| vehicle slides to bays | a placement happened | 300 ms |
| ring fills | patience draining | ambient, linear |
| chosen-vehicle wave-mark | the booth just picked | 250 ms |
| misfit shake | this placement cannot work | 200 ms |
| cone appears | the future is booked | 200 ms |
| tow pull-out | progress was lost | 400 ms |

Four moments may exceed the budget (never 4 s, always skippable): ring overflow, a gold score,
the first appearance of each building, a belt promotion. Ambient-only: day-night tint, sun cue.

## Decision (mockups)

Two mockups of "City 3, mid-week" were built and rendered (`web/mockups/warm.html`,
`web/mockups/cool.html`; shots in `docs/screenshots/art1/`). **Cool won** — its feeder→road→booth→lots
composition is readable at a glance, nothing clips at 1600 px, and both themes held contrast; warm's
vertical road crowded the lots. Warm's legend discipline and annotation style were kept. See
[[Decision Log]].
