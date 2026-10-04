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

## Art 7b: the same envelope, three client edges

`CARD_VERSION` is still 1 and this module did not change — a city run rides the v1 envelope because
`encode_card` embeds the dict it is handed, and the browser hands it the **city edition** (the level
plus the tutorial's whitelisted patch), so the card replays the week that was played. The three
edges the browser now handles (`web/src/share-scene.ts`; see [[Campus]]):

- levels whose `jobs` are an explicit list (7, 8) cannot fit them in a URL, so the shipped
  `levels/levelN.json` is merged **under** the card's embedded fields — and the card's `null`s are
  dropped first (`withoutNulls`), because `encode_card` writes `level.get("sensors")` and a
  `sensors: null` fails `validate_level` even though `replay_card` tolerates it;
- **endless runs are not minted at all** — a 30-day materialized stream (~1.9 k jobs) is not
  URL-sized, and `share_encode` cannot hash a `level_id`-only card in the first place;
- the link lives in the **hash** (`#card=…`), which Pages serves with no server, where phase one used
  the `?c=` query. Both routes still work, and a pre-Art-7b card literal is replayed in CI evidence to
  prove the envelope never broke. Minting it needs `kata` OMITTED, not null ([[Pyodide Bridge]]).

## Depends on / used by

Uses `sim.level.run_level`, `sim.scoring`, `sim.trajectory`. Used by `dojo verify-card` and the share UI
(Stage 9).
