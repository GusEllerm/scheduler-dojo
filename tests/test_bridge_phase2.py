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


def test_snapshot_carries_tutorial_counters() -> None:
    """`placed_total`/`week` are the tutorial runner's deterministic predicate sources."""
    h = bridge.start(_LVL, policy="fifo")["handle"]
    st = bridge.step_until(h, 10_000)["state"]
    assert st["placed_total"] > 0 and st["week"] >= 1
    later = bridge.step_until(h, 20_000)["state"]
    assert later["placed_total"] >= st["placed_total"]  # a count, never a set size
    assert later["week"] >= st["week"]


def test_hand_place_bumps_placed_total() -> None:
    lvl = {"id": "t", "title": "t", "duration": 5000,
           "cluster": {"nodes": [{"id": "n0", "cpus": 8}]},
           "jobs": [{"id": "A", "user": "u", "submit_time": 0, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100}]}
    h = bridge.hand_start(lvl)["handle"]
    before = bridge.hand_tick(h)["state"]["placed_total"]
    res = bridge.hand_place(h, "A")
    assert res["ok"], res
    assert res["state"]["placed_total"] == before + 1


def test_hand_snapshots_track_the_week_calendar():
    """Art 6a root-cause fix: hand mode must see week transitions, not a pinned week 1."""
    lvl = {"id": "hw", "title": "hw", "duration": 7000,
           "cluster": {"nodes": [{"id": "n0", "cpus": 8}]},
           "jobs": [{"id": "A", "user": "u", "submit_time": 0, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100},
                    {"id": "B", "user": "u", "submit_time": 6500, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100},
                    {"id": "C", "user": "u", "submit_time": 7200, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100}]}
    h = bridge.hand_start(lvl)["handle"]
    st = bridge.hand_tick(h)["state"]
    assert st["week"] == 1 and st["now"] < 7000  # still week one (stride 1000, 7 days)
    st = bridge.hand_tick(h)["state"]            # the t=7200 arrival crosses the boundary
    assert st["week"] == 2, st


def test_endless_level_is_stepable_and_matches_endless_run():
    """Art 7: the campus steps endless — the builder must feed validate/start and replay identical
    to the one-shot endless_run."""
    growth = {"base_qps": 0.001, "growth_per_day": 1.5, "growth": {"days": 3, "horizon": 6000}}
    lvl = bridge.endless_level(growth, seed=2)
    bridge.validate_level(lvl)  # raises LevelError if the builder emitted a bad level
    one = bridge.endless_run(growth, seed=2, policy="fifo")
    h = bridge.start(lvl, seed=2, policy="fifo")["handle"]
    done = False
    for _ in range(2000):
        done = bridge.step_n(h, 1)["done"]
        if done:
            break
    assert done, "the stepped endless level never finished"
    final = bridge.step_result(h)
    assert final["trajectory_hash"] == one["trajectory_hash"]
    assert final["end_time"] == one["end_time"]


def _t0_pressure_level(id_: str, end_on_overflow: bool) -> dict:
    """t0=900 level: A/B long, C needs both nodes and waits; overflow ring fills at 1068."""
    return {"id": id_, "title": "t0", "duration": 2000,
            "cluster": {"nodes": [{"id": "n0", "cpus": 8}, {"id": "n1", "cpus": 8}]},
            "jobs": [
                {"id": "A", "user": "u", "submit_time": 900, "nodes_req": 1,
                 "walltime_req": 900, "actual_runtime": 900},
                {"id": "B", "user": "v", "submit_time": 950, "nodes_req": 1,
                 "walltime_req": 900, "actual_runtime": 900},
                {"id": "C", "user": "w", "submit_time": 1000, "nodes_req": 2,
                 "walltime_req": 50, "actual_runtime": 50}],
            "pressure": {"cap": 2, "end_on_overflow": end_on_overflow}}


def test_step_slice_at_horizon_end_finishes_t0_shifted_run():
    """Review F1: a driver slice at/after `horizon_end` ends the run (no clock pin), and the
    snapshot publishes `horizon_end` so the browser driver can aim there."""
    lvl = _t0_pressure_level("f1", False)
    st = bridge.start(lvl, seed=0)
    assert st["state"]["horizon_end"] == 900 + 2000
    out = bridge.step_until(st["handle"], 3000)
    assert out["done"] and out["state"]["now"] >= 900 + 2000 - 100


def test_pressure_stop_reports_done_and_never_raises_next_call():
    """Review F2: overflow sets `_finished`; the post-flash stepping call reports done=true."""
    h = bridge.start(_t0_pressure_level("f2", True), seed=0)["handle"]
    for _ in range(50):
        out = bridge.step_until(h, 3000)
        if out["done"]:
            break
    assert bridge.step_until(h, 3000)["done"]  # would raise DeterminismError pre-fix
    res = bridge.step_result(h)
    assert res["overflow"] == "w"
    assert res["overflow_time"] == 1068  # the ring filled here, NOT at end_time (F5)
    assert res["end_time"] != res["overflow_time"]


def test_empty_heap_done_lands_the_clock_on_the_horizon():
    """Review F1 follow-up: when a slice finishes a run whose LAST EVENT predates the horizon
    (heap drained before `t0 + horizon`), the observed clock must still land on the horizon —
    the campus week-boundary freeze watches `now`, and a clock pinned at the last event would
    let a city run end without ever reaching its week-end offer."""
    h = bridge.start(_t0_pressure_level("f1b", False), seed=0)["handle"]
    out = bridge.step_until(h, 3000)
    assert out["done"] and out["state"]["now"] == 900 + 2000  # last event ~1850, horizon 2900


def test_hand_result_reports_the_hand_policy():
    """Review 7a-F2: a run the player placed entirely by hand must not report the level default."""
    lvl = {"id": "hp", "title": "hp", "duration": 3000,
           "cluster": {"nodes": [{"id": "n0", "cpus": 8}]},
           "jobs": [{"id": "A", "user": "u", "submit_time": 0, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100}],
           "default_policy": "shortest_first"}
    h = bridge.hand_start(lvl)["handle"]
    bridge.hand_place(h, "A", ["n0"])
    assert bridge.hand_result(h)["policy"] == "hand"


def test_step_close_ends_a_session_without_draining():
    lvl = {"id": "sc", "title": "sc", "duration": 4000,
           "cluster": {"nodes": [{"id": "n0", "cpus": 8}]},
           "jobs": [{"id": "A", "user": "u", "submit_time": 0, "nodes_req": 1,
                     "walltime_req": 100, "actual_runtime": 100}]}
    h = bridge.start(lvl, seed=0)["handle"]
    bridge.step_until(h, 1000)
    out = bridge.step_close(h)
    assert out["ok"] and out["now"] == 1000
    assert bridge.step_close(h)["ok"] is False  # session is gone; step_result would have run 3.9k
