"""Progression rules: belts, credits, the upgrade tree, offline drift, and save migration."""

from __future__ import annotations

import pytest

from scheduler_dojo import progression as prog


def test_new_state_is_valid():
    st = prog.new_state(now=1000)
    assert st["version"] == prog.SAVE_VERSION
    assert prog.belt(0) == "White"


def test_belt_ladder_is_monotone():
    assert prog.belt(119) == "White"
    assert prog.belt(120) == "Yellow"
    assert prog.belt(300) == "Orange"
    assert prog.belt(999_999) == "Black"
    assert prog.next_belt(0) == ("Yellow", 120)
    assert prog.next_belt(999_999) is None


def test_completion_awards_credits_and_gold_bonus():
    st = prog.new_state()
    st = prog.apply_completion(st, "level1", 500, seed=1)
    assert st["credits"] == 50  # 500 // 10
    # Same level, same score again: no extra gold bonus, credits only.
    st = prog.apply_completion(st, "level1", 500, seed=2)
    assert st["credits"] == 100
    # A gold run the first time adds the bonus.
    st = prog.apply_completion(st, "level2", 800, seed=1)
    assert st["_last_award"] == 80 + prog.GOLD_BONUS


def test_gold_bonus_only_first_time():
    st = prog.new_state()
    st = prog.apply_completion(st, "level2", 800, seed=1)  # first gold
    first = st["credits"]
    st = prog.apply_completion(st, "level2", 800, seed=2)  # already gold
    assert st["credits"] == first + 80  # no bonus second time


def test_upgrade_requires_prereq_and_credits():
    st = prog.new_state()
    assert not prog.can_buy(st, "reserve")  # broke
    st["credits"] = 100
    assert prog.can_buy(st, "reserve")
    assert not prog.can_buy(st, "fairness")  # needs reserve first
    st = prog.buy(st, "reserve")
    assert "reserve" in st["upgrades"]
    st["credits"] = 200
    st = prog.buy(st, "fairness")
    assert prog.unlocked_tiers(st) >= {"core", "reserve", "fairness"}


def test_buy_guard_and_double_buy():
    st = prog.new_state()
    st["credits"] = 100
    st = prog.buy(st, "reserve")
    with pytest.raises(ValueError):
        prog.buy(st, "reserve")  # already owned
    with pytest.raises(ValueError):
        prog.buy(st, "route")  # missing prereq / credits


def test_unlocked_tiers_default_core():
    assert prog.unlocked_tiers(prog.new_state()) == {"core"}


def test_drift_capped_and_nonnegative():
    st = prog.new_state(now=0)
    st = prog.apply_drift(st, now=int(prog.DRIFT_CAP_HOURS * 3600) + 99999)
    assert st["_drift_award"] == int(prog.DRIFT_CAP_HOURS * prog.DRIFT_CREDITS_PER_HOUR)
    # Time travel backwards never removes credits.
    credits_before = st["credits"]
    st = prog.apply_drift(st, now=0)
    assert st["credits"] == credits_before


def test_migration_pads_old_state():
    old = {"credits": 5}  # version-less v0
    st = prog.apply_completion(old, "level1", 100, seed=1)
    assert st["version"] == prog.SAVE_VERSION
    assert st["credits"] == 5 + 10


def test_belts_track_lifetime_not_balance():
    st = prog.new_state()
    st["lifetime"] = 300
    assert prog.belt(st["lifetime"]) == "Orange"
    st["credits"] = 300
    st = prog.buy(st, "reserve")  # spend 60 -> balance 240, lifetime unchanged
    assert prog.belt(st["lifetime"]) == "Orange"  # buying never demotes
    assert st["credits"] == 240


def unlocked(state):
    return set(state.get("upgrades", []))
