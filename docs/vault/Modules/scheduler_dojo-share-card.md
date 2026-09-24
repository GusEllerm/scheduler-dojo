# scheduler_dojo/share/card.py

> [!abstract] Role
> Self-describing, replayable, **serverless** share cards (Stage 9) — a `#c=` payload that replays a
> run in the browser and proves it via a hash.

## What it does

`encode_card(level=|level_id=, seed, policy=|kata=, result=)` → a `#c=`+base64url payload;
`decode_card(payload)` → the dict; `replay_card(card|payload, level=)` → `{ok, score?, metrics,
trajectory_hash, expected_hash}`. Inline cards carry their own level; a `level_id` card needs the
shipped level passed in.

## How it works

- **No server:** the payload is base64url of a canonical, sorted-key JSON object tagged with
  `CARD_VERSION`. It embeds the seed, the policy *or the full kata source*, and the run's
  `trajectory_hash`. The browser decodes and re-runs — nothing is fetched.
- **Tamper-evident:** `replay_card` re-runs the engine and compares the trajectory hash, so a card
  cannot lie about its score; a changed seed/kata flips the hash and `ok=False`.
- **Canonical/stable:** sorted-key compact JSON means two players' identical katas produce byte-identical
  cards (stable share links). Reuses `trajectory_hash`. See [[Determinism]], [[scheduler_dojo-sim-trajectory]].
- `replay_card` runs with `validate=False` (the hash, not the schema gate, is the integrity check).

## Depends on / used by

Uses `sim.level.run_level`, `sim.scoring`, `sim.trajectory`. Used by `dojo verify-card` and the share UI
(Stage 9).
