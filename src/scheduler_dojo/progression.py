"""Progression — belts, credits, upgrades, and offline drift (Stage 7).

Pure functions over a serializable `state` dict: the engine owns the *rules*, persistence (localStorage
/ file) lives in the caller. Everything here is deterministic and unit-testable; the web layer just
loads a state, calls these, and saves the result.

State shape (v1):

```
{ "version": 1,
  "credits": int,
  "levels": { level_id: {"best": int, "gold": bool, "passes": [seed...] } },
  "upgrades": [upgrade_id...],           # purchased
  "last_seen": int                        # unix-ish seconds; drives offline drift
}
```

Belts are a pure function of lifetime credits (no hidden counters). Upgrades cost credits and gate the
later Kata tiers, so the economy and the language unlock curve are one system. Offline drift rewards
returning without ever going negative. See [[Concepts/Progression|Progression]].
"""

from __future__ import annotations

from typing import Any

SAVE_VERSION = 1
CREDIT_DIVISOR = 10  # credits = floor(score / CREDIT_DIVISOR); score 0..1000 -> 0..100 credits
GOLD_BONUS = 25

# Belt ladder: (min lifetime credits, name). Ordered; the belt is the highest threshold reached.
BELTS: list[tuple[int, str]] = [
    (0, "White"), (120, "Yellow"), (300, "Orange"), (560, "Green"),
    (900, "Blue"), (1350, "Purple"), (1900, "Brown"), (2500, "Black"),
]

# Upgrade tree: id -> {cost, requires:[ids], unlocks:[tiers]}. `requires` are prerequisites.
UPGRADES: dict[str, dict] = {
    "reserve": {"cost": 60, "requires": [], "unlocks": ["reserve"]},
    "sensors": {"cost": 120, "requires": [], "unlocks": ["sensor"]},
    "fairness": {"cost": 180, "requires": ["reserve"], "unlocks": ["fairness"]},
    "preempt": {"cost": 320, "requires": ["reserve"], "unlocks": ["preempt"]},
    "route": {"cost": 480, "requires": ["fairness"], "unlocks": ["route"]},
}

# Offline drift: credits-per-hour while idle, capped. A gentle "welcome back," never punishing.
DRIFT_CREDITS_PER_HOUR = 2
DRIFT_CAP_HOURS = 12.0


def new_state(*, now: int = 0) -> dict:
    return {"version": SAVE_VERSION, "credits": 0, "lifetime": 0, "levels": {},
            "upgrades": [], "last_seen": now}


def belt(credits: int) -> str:
    """The highest belt whose credit threshold is reached (monotone in credits)."""
    name = BELTS[0][1]
    for threshold, belt_name in BELTS:
        if credits >= threshold:
            name = belt_name
        else:
            break
    return name


def next_belt(credits: int) -> tuple[str, int] | None:
    """(next belt name, additional credits needed), or None at the top belt."""
    for threshold, belt_name in BELTS:
        if credits < threshold:
            return belt_name, threshold - credits
    return None


def apply_completion(state: dict, level_id: str, score: int, *, seed: int) -> dict:
    """Record a level run: award credits (score/10, + gold bonus on a first gold), update best/gold."""
    st = _migrate(dict(state))
    entry = dict(st["levels"].get(level_id, {"best": 0, "gold": False, "passes": []}))
    was_gold = bool(entry.get("gold"))
    entry["best"] = max(entry.get("best", 0), score)
    gold = score >= _GOLD_THRESHOLD
    passed = seed not in entry.get("passes", [])
    if passed:
        entry["passes"] = sorted(set(entry.get("passes", [])) | {seed})
    awarded = score // CREDIT_DIVISOR
    if gold and not was_gold:
        entry["gold"] = True
        awarded += GOLD_BONUS
    st["levels"][level_id] = entry
    st["credits"] = st["credits"] + awarded
    st["lifetime"] = st.get("lifetime", 0) + awarded
    st["_last_award"] = awarded
    return st


_GOLD_THRESHOLD = 720  # default; the authoritative gold bar lives in the level file


def can_buy(state: dict, upgrade_id: str) -> bool:
    if upgrade_id not in UPGRADES or upgrade_id in state.get("upgrades", []):
        return False
    if state.get("credits", 0) < UPGRADES[upgrade_id]["cost"]:
        return False
    return all(req in state.get("upgrades", []) for req in UPGRADES[upgrade_id]["requires"])


def buy(state: dict, upgrade_id: str) -> dict:
    st = _migrate(dict(state))
    if not can_buy(st, upgrade_id):
        raise ValueError(f"cannot buy {upgrade_id!r}")
    st["credits"] -= UPGRADES[upgrade_id]["cost"]
    st["upgrades"] = sorted(set(st["upgrades"]) | {upgrade_id})
    return st


def unlocked_tiers(state: dict) -> set[str]:
    """Kata tiers the player's purchased upgrades enable (core is always on)."""
    tiers = {"core"}
    for up in state.get("upgrades", []):
        tiers.update(UPGRADES.get(up, {}).get("unlocks", []))
    return tiers


def apply_drift(state: dict, *, now: int) -> dict:
    """Award idle credits for time away (capped, monotone); advance `last_seen`. Never negative."""
    st = _migrate(dict(state))
    last = st.get("last_seen", now)
    elapsed_h = max(0.0, min(DRIFT_CAP_HOURS, (now - last) / 3600.0))
    award = int(elapsed_h * DRIFT_CREDITS_PER_HOUR)
    st["credits"] = st["credits"] + award
    st["lifetime"] = st.get("lifetime", 0) + award
    st["last_seen"] = max(last, now)
    st["_drift_award"] = award
    return st


def _migrate(state: dict) -> dict:
    version = state.get("version", 0)
    if version < SAVE_VERSION:
        state.setdefault("version", SAVE_VERSION)
        state.setdefault("credits", 0)
        state.setdefault("lifetime", state.get("credits", 0))
        state.setdefault("levels", {})
        state.setdefault("upgrades", [])
        state.setdefault("last_seen", 0)
        state["version"] = SAVE_VERSION
    return state
