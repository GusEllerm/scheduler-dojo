# Progression

> [!abstract] The loop
> Play a level → earn credits from your score → buy upgrades that unlock new Kata capabilities → clear
> harder levels → rank up a belt. Offline time trickles a little back. One economy, one unlock curve.

## The pieces

- **Score → credits**: `credits = floor(score / 10)` (score is 0..1000, see [[Concepts/Scoring|Scoring]]),
  plus a one-time gold bonus for a level's first gold. Gold bars are *earned*, so credits reward genuine
  skill, not grinding the same easy run.
- **Belts** are a pure function of *lifetime* credits (`progression.belt`) — an achievement ladder
  (White→Black) that spending never walks back.
- **Upgrades gate Kata tiers**: buying `reserve`/`sensors`/`fairness`/`preempt`/`route` enables those
  builtins (via `unlocked_tiers`), so the shop *is* the language unlock curve. Prerequisites force a
  sensible order. See [[Kata]].
- **Offline drift**: a small, capped, non-negative trickle of credits for time away — a "welcome back,"
  never a punishment or an exploit. See `scheduler_dojo-progression`.

## Where it lives

The *rules* are pure Python in [[scheduler_dojo-progression]] (deterministic, unit-tested); the *state*
is a plain dict persisted to localStorage (client) and surfaced to the UI through
[[scheduler_dojo-bridge|bridge.progression_*]] so there is still exactly one engine.

## Design note

Keeping the economy in Python (not TypeScript) means a save is replayable/validatable and the same rules
apply in tests and the browser — the same single-engine invariant as [[Pyodide Bridge]].
