"""The week-boundary two-offer draw is a pure engine function of (save, city, week) ([[Campus]])."""

from __future__ import annotations

import copy

from scheduler_dojo.progression import UPGRADES, new_state, offers

# Expected lists pinned from one computation of the seeded draws (Python 3.12, the pinned runtime).
# Eligible = unowned, prereqs owned, sorted by id: {} -> [reserve, sensors] (only 2, all offered);
# {reserve} -> [fairness, sensors, preempt]; {reserve, sensors} -> [fairness, preempt].


def test_fresh_save_offers_the_two_root_upgrades():
    assert offers(new_state(), 1, 1) == ["reserve", "sensors"]


def test_seeded_pair_pinned_for_an_intermediate_save():
    assert offers({"upgrades": ["reserve"]}, 1, 1) == ["fairness", "sensors"]
    assert offers({"upgrades": ["reserve"]}, 1, 2) == ["sensors", "preempt"]
    assert offers({"upgrades": ["reserve", "sensors"]}, 2, 1) == ["fairness", "preempt"]


def test_owned_and_prereq_failing_upgrades_are_never_offered():
    state = {"upgrades": ["reserve"]}
    for city in range(1, 4):
        for week in range(1, 6):
            pair = offers(state, city, week)
            assert "reserve" not in pair                      # owned
            assert "route" not in pair                        # requires fairness (unowned)
            assert set(pair) <= set(UPGRADES)
            assert len(pair) == 2


def test_repeat_stable_and_sensitive_to_the_draw_key():
    state = {"upgrades": ["reserve"]}
    assert offers(state, 1, 1) == offers(state, 1, 1)  # same save/city/week -> same pair
    seen = {tuple(offers(state, 1, w)) for w in range(1, 10)}
    assert len(seen) > 1  # the week actually feeds the seed, the draw is not constant


def test_fewer_than_two_eligible_returns_all_eligible():
    # Everything but fairness owned -> fairness is the only eligible upgrade.
    assert offers({"upgrades": ["reserve", "sensors", "preempt", "route"]}, 3, 1) == ["fairness"]


def test_nothing_eligible_returns_empty():
    full = sorted(UPGRADES)
    assert offers({"upgrades": full}, 5, 3) == []
    assert offers({"upgrades": []}, 1, 1) == ["reserve", "sensors"]  # empty owned = fresh


def test_offers_never_mutates_the_state():
    state = {"version": 1, "credits": 100, "upgrades": ["reserve"], "levels": {}}
    before = copy.deepcopy(state)
    offers(state, 2, 4)
    assert state == before
