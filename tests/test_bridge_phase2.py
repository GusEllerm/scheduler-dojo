"""Phase-two bridge surface: calendar, offers, city editions, endless (§5.6-5.8 at the boundary)."""

from __future__ import annotations

from scheduler_dojo import bridge

_LVL = {"id": "t", "title": "t", "duration": 700,
        "cluster": {"nodes": [{"id": "n0", "cpus": 8}]},
        "jobs": [{"id": "A", "user": "u", "submit_time": 0, "nodes_req": 1,
                  "walltime_req": 100, "actual_runtime": 100}]}


def test_calendar_agrees_with_engine_week_math():
    c = bridge.calendar_at(0, _LVL)
    assert c["day"] == 1 and c["week"] == 1
    # stride = 700//7 = 100 s/day; day 4 starts at t=300
    c4 = bridge.calendar_at(300, _LVL)
    assert c4["day"] == 4
    # the week ends at 700 (== the horizon) and t=700 is week 2 day 1
    assert c["week_end"] == 700
    assert bridge.calendar_at(700, _LVL)["week"] == 2


def test_offers_are_deterministic_and_replayable():
    st = bridge.progression_view()["belt"] and {}  # fresh state
    a = bridge.offers_list(st, city=1, week=1)
    b = bridge.offers_list(st, city=1, week=1)
    assert a == b and len(a["offers"]) == 2
    # owning one changes the draw deterministically (eligible set shrinks)
    st2 = dict(st)
    st2["upgrades"] = [a["offers"][0]]
    c = bridge.offers_list(st2, city=1, week=1)
    assert a["offers"][0] not in c["offers"]


def test_tutorial_run_uses_the_city_edition_not_the_file():
    out = bridge.tutorial_run("city1", policy="idle")
    users = {j["user"] for j in out["jobs"]}
    assert users == {"alice"}          # level1.json has alice+bob; the patch narrows to one
    assert out["level_id"] == "level1"  # still the canonical level identity
    # repeated runs are byte-identical
    out2 = bridge.tutorial_run("city1", policy="idle")
    assert out["trajectory_hash"] == out2["trajectory_hash"]


def test_tutorial_load_returns_script_data():
    t = bridge.tutorial_load("city3")["tutorial"]
    assert t["city"] == 3 and t["level"] == "level3"
    assert t["steps"] and t["end"]["next"] == 4


def test_endless_run_is_seeded_and_overflows_eventually():
    growth = {"base": {"users": ["a", "b"], "arrival": [1800, 3600], "nodes": [1, 1],
                        "walltime": [600, 1800], "jobs_per_day": 12},
              "growth": {"new_user_every_days": 5, "max_users": 4,
                          "arrival_ramp_pct_per_day": 6, "rate_ramp_pct_per_week": 25,
                          "cap_jobs_per_day": 240, "horizon": 10 * 86400}}
    a = bridge.endless_run(growth, seed=7, policy="idle")
    b = bridge.endless_run(growth, seed=7, policy="idle")
    assert a["trajectory_hash"] == b["trajectory_hash"]
    assert a["overflow"] != ""                     # idle must pop a ring eventually
    users = {j["user"] for j in a["jobs"]}
    assert len(users) > 2                          # neighbourhoods moved in over days


def test_watch_plan_advises_the_renderer():
    plan = bridge.watch_plan(_LVL)
    assert plan["step"] == max(1, 700 // 2400) and plan["duration"] == 700
    assert plan["stride"] == 100  # 700 // 7 seconds per (cosmetic) day
    lvl = dict(_LVL, pressure={"cap": 2})
    assert bridge.watch_plan(lvl)["tick"] == bridge._tick_for(lvl)
