"""The campus calendar is one engine function so CLI and browser agree on week ends ([[Campus]])."""

from __future__ import annotations

import pytest

from scheduler_dojo.sim.calendar import DAY_SECONDS, day_clock, day_week, week_end_time


def test_level_starts_on_day_one_of_week_one():
    assert day_week(0, 0, 40000) == (1, 1)
    assert day_week(-5, 0, 40000) == (1, 1)  # before t0 clamps to the first day


def test_day_boundaries_are_exact_on_the_stride():
    # duration 40000, weeks 7 -> stride 40000 // 7 == 5714 s per day
    assert day_week(5713, 0, 40000) == (1, 1)
    assert day_week(5714, 0, 40000) == (2, 1)
    assert day_week(6 * 5714, 0, 40000) == (7, 1)
    assert day_week(7 * 5714, 0, 40000) == (8, 2)  # the week rolls over exactly on the boundary


def test_day_week_offset_by_t0():
    assert day_week(105_714, 100_000, 40000) == (2, 1)


def test_duration_not_divisible_by_seven_still_spans_one_week():
    # 33 // 7 == 4 -> 8 stride-days... every t maps somewhere, last day >= 8 by the horizon
    day, week = day_week(33, 0, 33)
    assert (day, week) == (9, 2)  # 33 // 4 == 8 -> day 9 of week 2 (horizon edge spills over)
    assert day_week(32, 0, 33) == (9, 2)
    assert day_week(28, 0, 33) == (8, 2)
    days = {day_week(t, 0, 40)[0] for t in range(0, 40)}
    assert days == set(range(1, 41 // (40 // 7) + 1))  # contiguous days, no gaps


def test_duration_below_a_week_is_clamped_to_one_second_days():
    assert day_week(0, 0, 0) == (1, 1)     # duration clamped >= 1
    assert day_week(5, 0, 3) == (6, 1)     # duration 3 -> stride max(1, 0) == 1
    assert day_week(1, 0, 1) == (2, 1)


def test_week_end_time_is_the_agreed_boundary_and_monotone():
    assert week_end_time(0, 40000, 1) == 7 * 5714
    assert week_end_time(0, 40000, 2) == 2 * 7 * 5714
    assert week_end_time(100, 40000, 1) == 100 + 7 * 5714
    ends = [week_end_time(0, 40000, w) for w in range(1, 13)]
    assert ends == sorted(ends) and len(set(ends)) == 12  # strictly monotone in week
    # day_week agrees with the boundary: exactly on it, you are already in the next week
    for w in (1, 2, 5):
        t = week_end_time(0, 40000, w)
        assert day_week(t - 1, 0, 40000)[1] == w
        assert day_week(t, 0, 40000)[1] == w + 1


def test_day_clock_position_within_the_sun_cycle():
    # A short level: sun cycle is the (shorter) stride, so the full arc shows inside each day
    idx, frac = day_clock(0, 0, 40000)
    assert (idx, frac) == (0, 0.0)
    idx, frac = day_clock(5713, 0, 40000)
    assert idx == 0 and 0.99 < frac < 1.0
    idx, frac = day_clock(5714, 0, 40000)
    assert idx == 1 and frac == 0.0
    for t in range(0, 40001, 37):
        idx, frac = day_clock(t, 0, 40000)
        assert 0.0 <= frac < 1.0


def test_day_clock_endless_uses_the_literal_day():
    # Endless: a literal 86400 s sun cycle inside a long calendar stride (Campus.md).
    horizon = 30 * DAY_SECONDS  # stride = 2592000 // 7 = 370285 s > one literal day
    idx, frac = day_clock(DAY_SECONDS + 100, 0, horizon)
    assert idx == 0
    assert abs(frac - 100 / DAY_SECONDS) < 1e-12
    idx, frac = day_clock(3 * DAY_SECONDS, 0, horizon)
    assert idx == 0 and frac == 0.0  # a whole number of sun cycles lands at zero
    for t in (1, 86401, 200_000, 368_639):
        assert 0.0 <= day_clock(t, 0, horizon)[1] < 1.0
