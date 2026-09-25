"""Endless growth: one seeded stream, deterministic like every other trace source ([[Determinism]])."""

from __future__ import annotations

from scheduler_dojo.sim.endless import (DAY_SECONDS, arrival_window, generate_endless_jobs,
                                        jobs_on_day)

GROWTH = {
    "base": {
        "users": [{"name": "alice", "weight": 1.0}, {"name": "bob", "weight": 1.0}],
        "arrival": [600, 1200],
        "nodes": [1, 2],
        "walltime": [600, 3600],
        "jobs_per_day": 20,
    },
    "growth": {
        "new_user_every_days": 2,
        "max_users": 4,
        "arrival_ramp_pct_per_day": 10,
        "rate_ramp_pct_per_week": 25,
        "cap_jobs_per_day": 40,
        "horizon": 10 * DAY_SECONDS,
    },
}


def _rows(jobs):
    return [(j.id, j.user, j.submit_time, j.nodes_req, j.walltime_req, j.actual_runtime)
            for j in jobs]


def test_same_seed_produces_identical_jobs_twice():
    assert _rows(generate_endless_jobs(7, GROWTH)) == _rows(generate_endless_jobs(7, GROWTH))
    assert _rows(generate_endless_jobs(7, GROWTH)) != _rows(generate_endless_jobs(8, GROWTH))


def test_new_users_move_in_every_n_days_up_to_the_cap():
    jobs = generate_endless_jobs(11, GROWTH)
    users = {j.user for j in jobs}
    assert {"alice", "bob"} <= users
    assert users <= {"alice", "bob", "user2", "user3"}  # max_users = 4, no user4 ever
    assert "user2" in users and "user3" in users
    # user{k} appears only from the day it moves in: day = k - 2 base users, every 2 days.
    for k in (2, 3):
        first = min(j.submit_time for j in jobs if j.user == f"user{k}")
        assert (k - 2) * 2 * DAY_SECONDS <= first < (k - 2) * 2 * DAY_SECONDS + 3 * DAY_SECONDS


def test_arrival_windows_shrink_monotonically():
    base = GROWTH["base"]["arrival"]
    windows = [arrival_window(base, d, 10)[1] for d in range(8)]
    assert all(a > b for a, b in zip(windows, windows[1:]))  # strictly shrinking hi bound
    assert arrival_window(base, 0, 0)[1] == base[1]          # no ramp -> base window
    jobs = generate_endless_jobs(3, GROWTH)
    for day in range(10):  # observed within-day gaps respect the day's (ramped) window
        subs = sorted(j.submit_time for j in jobs
                      if day * DAY_SECONDS <= j.submit_time < (day + 1) * DAY_SECONDS)
        gaps = [b - a for a, b in zip(subs, subs[1:])]
        if gaps:
            assert max(gaps) <= arrival_window(base, day, 10)[1] + 1


def test_ids_are_sequential_in_submit_order_and_sorted():
    jobs = generate_endless_jobs(5, GROWTH)
    assert [j.id for j in jobs] == [f"e{i:06d}" for i in range(len(jobs))]
    assert jobs == sorted(jobs, key=lambda j: (j.submit_time, j.id))


def test_horizon_is_respected_and_defaulted():
    jobs = generate_endless_jobs(2, GROWTH)
    assert jobs and all(0 <= j.submit_time <= 10 * DAY_SECONDS for j in jobs)
    short = generate_endless_jobs(2, {"base": GROWTH["base"],
                                      "growth": {"horizon": 2 * DAY_SECONDS}})
    assert short and all(j.submit_time <= 2 * DAY_SECONDS for j in short)
    assert all(j.submit_time <= 30 * DAY_SECONDS
               for j in generate_endless_jobs(2, {"base": GROWTH["base"]}))  # default 30 days


def test_rate_ramp_grows_weekly_and_the_cap_holds():
    assert jobs_on_day(20, 0, 25, 40) == 20
    assert jobs_on_day(20, 6, 25, 40) == 20                   # same week, no growth yet
    assert jobs_on_day(20, 7, 25, 40) == 25                   # one week of 25 % growth
    assert jobs_on_day(20, 14, 25, 40) == 31                  # compounded weekly
    assert jobs_on_day(20, 21, 25, 40) == 39
    assert jobs_on_day(20, 21, 100, 40) == 40                 # capped at cap_jobs_per_day


def test_job_fields_stay_in_the_declared_windows():
    jobs = generate_endless_jobs(9, GROWTH)
    assert all(1 <= j.nodes_req <= 2 for j in jobs)
    assert all(600 <= j.walltime_req <= 3600 for j in jobs)
    assert all(j.actual_runtime == j.walltime_req for j in jobs)  # honest walltimes
