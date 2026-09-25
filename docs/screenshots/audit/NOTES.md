# Visual audit — phase-one UI (dev server :5199, 1280x720 unless noted)

Captured via agent-browser; Pyodide warm after first load (a `script`-mode side session twice
overwrote a shot with a blank page — both recaptured clean; final set has no blank files).

| file | shows | fails to show | eye lands first |
|---|---|---|---|
| 00-first-paint.png | Reload with warm cache — loader screen never visible; page arrives already painted on Level 3 with an auto-replay in progress. | The `#loader` progress screen itself (warm HTTP cache makes load <1 round-trip; cold-load paint unobservable). | Bright green score `800`, then the half-painted timeline. |
| 01-loaded-level1.png | Fully loaded app on Level 1 "Warm-up: four nodes, one big job": scorecard + seed hash, level/mode buttons, complete kata timeline. | No present-tense/live view — you land on a finished-run replay, not "now"; no user/account colors (all blocks uniform). | Green `1000 SCORE`, then the dense green timeline. |
| 02-level1-watch.png | Watch replay mid-paint on Level 1 (Pause state, playhead at ~16m, `j000002` running on n0, future faded). | Same: replay scrubber instead of a present-tense view; job blocks carry no per-user color. | The blue `running` block under the white playhead. |
| 03-level2-watch.png | Level 2 "You cannot keep up by hand": 16 lanes of short green jobs, mid-replay at ~1h28m. | Queued jobs aren't visible (arrivals appear only as the playhead passes); no color by user. | The wall-to-wall green (all jobs done). |
| 04-level3-watch.png | Level 3 "The big job that never starts": backfill gaps (dark) between short jobs on 4 lanes, replay near end. | The star of the story — the big job — isn't visually distinct; no present-tense view. | The dark gaps in the green rows. |
| 05-level4-watch.png | Level 4 "Trust, but verify": orange `timeout` blocks appear for the first time; playhead ~1h51m. | No explanation of why a block is orange beyond the legend chip; estimate-vs-actual not shown. | The bright orange timeout row segment. |
| 06-level5-watch.png | Level 5 "Everyone at the table": 4x16c lanes, fairness 0.976; lanes labelled `8c/16c` only. | No per-user/account color on chips or blocks — "everyone at the table" is invisible. | The long continuous green bands. |
| 07-level6-watch.png | Level 6 "Special machines": heterogeneous lanes (`a0 8c 2g` GPU nodes, mixed 4c/8c/16c). | GPU constraint shown only as an `ng` text tag; no fit/capacity feedback on lanes. | The visually odd short GPU rows. |
| 08-level7-watch.png | Level 7 "Triage line": job ids `b00` (short, green) vs `q00` (long, orange/timeout); playhead ~1h58m. | Priority/triage classes not color-coded; chips/blocks share the same two colors by state only. | The orange tail blocks. |
| 09-level8-watch.png | Level 8 "Data doesn't move": 8 lanes labelled `n0 16c` with no locality/scope hint; dense replay. | Data-locality invisible — lanes look identical to any other level. | The repeating green pattern. |
| 10-level9-watch.png | Level 9 "The whole campus at 5 o'clock": wide mixed run, score 2500, playhead ~2h31m. | Same gaps: no present-tense view, no user colors, fairness/queue pressure not legible from the picture. | Green flood on n3 with an orange island. |
| 20-hand-level1-initial.png | Hand mode on Level 1: `queued: [j000000]` chip, 4 empty lane buttons, Next/Finish, hint toggles, gauges 0/0%. | Clock already reads `t=2m01s` at run start (odd, worth a check); no capacity/fit affordance on empty lanes; chip has no owner color. | The lone blue chip `j000000`. |
| 21-hand-staged.png | Staging a placement: chip selected, `n0` dashed-highlighted, bar `place j000000 → n0` with Place/cancel. | No fit feedback — n0 could be full or huge, the UI doesn't say; the engine may still reject after Place. | The dashed n0 lane, then the Place button. |
| 22-hand-running.png | Mid-hand run at `t=11m38s`: two queued chips, completed badge on n0, gauges. **Bug: gauge says `Utilization 100%` while `0 busy now`** — contradictory. | Running jobs show only as lane badges, no in-lane blocks until Finish; no present-tense node view. | Green "done" badge, then the 100%-gauge vs "0 busy now" contradiction. |
| 23-hand-finished.png | Finished hand scorecard (700, 62.6%, seeds, `pass 360 · gold 720`, Share) + complete replay timeline. | Hand-run result jumps straight to replay; no review of your own placements vs a reference; uniform block colors. | Green `700 SCORE`, then the Share button. |
| 30-kata-editor.png | Kata mode on Level 3: library (starter/shortest_first/backfill/...), Check/Run/Step, syntax-highlighted editor, `reference_kata.gata` chip; notice `Reservation is locked — buy it in Upgrades`. | Library shows ~5 of presumably more entries (list clips); editor height forces scroll; right side cut — editor overflows 1280px (see NOTES bottom). | The bright keyword soup in the editor. |
| 31-kata-run.png | `backfill` kata loaded from library, Run pressed: readout `run ok — seed 1`, score 800, editor still on screen. | The resulting timeline is pushed below the fold — you must scroll to see what your kata did; no diff vs reference. | Green `800` scorecard at top. |
| 40-shop.png | Upgrades dialog: 10 items, all priced 150, owned/lock states, Close (x). | No art, no effect demo, no "why" — every price identical; locked items indistinguishable at a glance from affordable ones. | The 9-column wall of identical `150` Buy buttons. |
| 41-share.png | Share modal: "Run shared", URL + copy, Download PNG, and the share-card canvas art. | The card art is an abstract placeholder diagram, not your actual timeline — misleading share preview. | The big abstract red/blue card art. |
| 50-small-viewport-kata.png | 390x844 kata mode: readout + buttons wrap fine, but **editor and library overflow the viewport horizontally (clipped, no visible scroll cue)**; locked-tier banner spills right. | Any way to see the rest of the editor on a phone; the timeline entirely. | The red `BLUE 964 cr` banner, then the cut-off editor. |
| 51-small-viewport-watch.png | 390x844 watch mode: scorecard wraps cleanly, buttons stack, legend visible. | The timeline itself is still below the fold at this scroll position. | `pass 360 · gold 720` row + Share. |
| 52-small-viewport-timeline.png | 390x844, timeline in view: 4 lanes fit, scrubber + legend usable. | Job-id labels crowd at narrow widths; horizontal lane detail suffers but survives. | The dense lane stripes. |

## Missing / broken
- **No loader screenshot**: with a warm cache the loader screen paints for less than one
  round-trip (two reload attempts both arrived already loaded). First-paint on a cold cache
  is unverified; `00-first-paint.png` shows the loaded app mid-replay instead. Everything else captured.
- **Suspected bugs**: (1) hand-mode gauge `Utilization 100%` with `0 busy now` (22); (2) hand run
  clock starts at `t=2m01s` rather than 0 (20); (3) kata editor horizontally overflows both 1280px
  (30) and 390px (50) viewports; (4) kata Run result hides its timeline below the fold (31).
- **Common phase-two gaps visible everywhere**: no present-tense/live view (everything is a
  scrubbed replay of a finished run); job chips/blocks never colored by user or account (state-only
  palette); no fit/capacity feedback when staging by hand or reading lanes; share-card art
  disconnected from the real timeline.
