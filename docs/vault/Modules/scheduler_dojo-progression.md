# scheduler_dojo/progression.py

> [!abstract] Role
> The game's glue — belts, credits, the upgrade tree, and offline drift (Stage 7). Pure functions over a
> serializable state dict; the engine owns the rules, persistence lives in the caller. See
> [[Concepts/Progression|Progression]].

## What it does

`new_state`, `apply_completion(state, level_id, score, seed)` (credits = `score//10`, a first-gold bonus),
`belt`/`next_belt` (from *lifetime* credits), `can_buy`/`buy` (the `UPGRADES` tree with prerequisites),
`unlocked_tiers` (which Kata tiers the purchases enable), `apply_drift(state, now)` (capped idle
credits), and `_migrate` (versioned saves).

## How it works

- **Belts are lifetime achievements:** `credits` is the spendable balance; `lifetime` only ever grows, so
  buying an upgrade never demotes you. `BELTS` is an ordered `(threshold, name)` ladder.
- **One economy with the unlock curve:** upgrades cost credits and gate Kata tiers (`unlocked_tiers`
  starts at `{core}` and adds each purchase's tier), so credit-grinding and language progression are the
  same system. See [[Kata]].
- **Offline drift is gentle & safe:** `(now - last_seen)` hours, capped, non-negative, monotone
  (`last_seen` only advances) — time-travel can't farm or punish.
- Every function copies its input (`_migrate(dict(state))`), so state updates are pure and testable.

## Depends on / used by

Depends on nothing (pure). Reached by the web HUD via `bridge.progression_*` (Stage 7 UI).
