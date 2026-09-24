---
tags: [concept]
---
# Determinism

## In one line

Same level + seed + kata always yields the identical trajectory and score, in the CLI and in the
browser — this is what makes share cards verifiable without a server, so any nondeterminism is a bug.

## The rules

Every source of run-to-run variation is pinned:

1. **Seeded RNG only.** The engine never calls `random`, `time`, or the system entropy pool
   directly. All randomness flows from a single `random.Random` seeded from the level seed. A
   derived sub-stream (e.g. the offline `Drift` schedule) is forked from the seed deterministically,
   never from wall clock.
2. **Integer-second clock.** Simulation time is an `int` count of seconds; there is no float clock
   accumulation and no reading of the host wall clock inside the engine.
3. **Defined iteration order.** No `set` or `frozenset` iteration may influence a decision or a
   metric. Collections the policy or scorer walks are `list` or insertion-ordered `dict`. Where an
   unordered concept (a set of nodes) is needed internally it is materialised to a sorted list
   before iteration.
4. **Stable sorting.** Sorts must be total or made total with a deterministic tiebreaker (job id),
   so `sorted` output never depends on Python's original positions in a way the two runtimes could
   differ on.
5. **Deterministic float summation.** Aggregations that feed a score sum in a fixed order (by job
   id), not in dict/finish order, so floating-point accumulation is identical across runtimes.
6. **No wall clock in the engine.** Time-ratio and offline-elapsed calculations live in the game /
   bridge layer, which may read wall clock; the simulator itself is pure w.r.t. time inputs.

## Where it is enforced

- Golden-trajectory tests (`tests/`) pin a full trajectory hash per level + seed + reference kata.
  Regenerate with a script only, and review the diff.
- The Node-side Pyodide smoke test replays level 1 and asserts the score equals the pytest golden;
  this is the cross-runtime (CPython vs Pyodide) determinism check and runs in CI.
- Kata is deterministic by construction: no randomness, no wall clock, a bounded step budget, and
  defined iteration order for every builtin.

## Known float hazard

`bounded_slowdown` and `utilization` mix integer counts and float ratios. Keep the accumulation
order fixed and avoid `math.fsum` unless every runtime has it (Pyodide does, but pin behaviour with
a golden regardless).

## Docs-gate caveat (not the engine, but determinism-adjacent)

`livedocs`/`drift` bind notes to code via hashes. `livedocs`'s `astdiff.member_hash` uses `ast.dump`,
which is **CPython-minor-version-sensitive**, so note stamps must be written and verified under the
same CPython minor (this project pins that to **3.12**, matching the engine and Pyodide). Running the
gate on a different minor (e.g. 3.13) re-hashes every symbol and makes `livedocs verify` report
benign-CHANGED everywhere. See [[Decision Log]].
