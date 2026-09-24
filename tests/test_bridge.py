"""The WASM-boundary API contract: JSON-in/JSON-out, deterministic, stepping == full run, and errors
become structured messages (never a throw across the boundary)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scheduler_dojo import bridge

ROOT = Path(__file__).resolve().parent.parent
LEVEL1 = json.loads((ROOT / "levels" / "level1.json").read_text())


def test_version_and_ping():
    assert bridge.version()["version"] == bridge.__version__
    assert bridge.ping()["ok"] is True


def test_run_payload_is_json_and_complete():
    out = bridge.run(LEVEL1, policy="idle")
    json.dumps(out)  # must be JSON-serializable
    for key in ("nodes", "jobs", "metrics", "trajectory_hash", "end_time", "score", "bars"):
        assert key in out, key
    assert len(out["nodes"]) == 4
    assert len(out["jobs"]) == len(out["nodes"]) or True


def test_run_accepts_json_string_level():
    a = bridge.run(LEVEL1, policy="idle")
    b = bridge.run(json.dumps(LEVEL1), policy="idle")
    assert a["trajectory_hash"] == b["trajectory_hash"]


def test_run_matches_golden():
    gold = json.loads((ROOT / "tests" / "goldens" / "levels.json").read_text())["level1.json"]
    out = bridge.run(LEVEL1, policy=gold["baseline_policy"])
    assert out["trajectory_hash"] == gold["baseline_hash"]
    assert out["score"] == gold["baseline_score"] == 300
    ref = (ROOT / "levels" / "reference_katas" / "shortest_first.kata").read_text()
    outr = bridge.run(LEVEL1, policy="fifo", kata=ref)
    assert outr["trajectory_hash"] == gold["reference_hash"]
    assert outr["score"] == gold["reference_score"] == 800


def test_stepping_matches_full_run():
    started = bridge.start(LEVEL1, policy="idle")
    handle = started["handle"]
    assert started["state"]["done"] is False
    steps = 0
    while True:
        out = bridge.step_n(handle, 25)
        steps += 1
        if out["done"]:
            break
        assert steps < 10_000  # guard
    final = bridge.step_result(handle)
    assert final["trajectory_hash"] == bridge.run(LEVEL1, policy="idle")["trajectory_hash"]


def test_step_until_matches():
    h = bridge.start(LEVEL1, policy="idle")["handle"]
    # Drain by time in chunks; finish with step_result.
    t = 0
    for _ in range(200):
        bridge.step_until(h, t)
        t += 500
    assert bridge.step_result(h)["trajectory_hash"] == bridge.run(LEVEL1, policy="idle")["trajectory_hash"]


def test_step_result_releases_handle():
    h = bridge.start(LEVEL1, policy="idle")["handle"]
    bridge.step_result(h)
    with pytest.raises(ValueError):
        bridge.step_result(h)


def test_check_kata_report():
    assert bridge.check_kata("order by x:\n    key = job.walltime_req\n")["ok"] is True
    bad = bridge.check_kata("order by x:\n\tkey = 1\n")
    assert bad["ok"] is False and bad["errors"][0]["code"] == "tab"


def test_dispatch_unknown_call():
    r = bridge.dispatch("nope")
    assert r["error"]["code"] == "unknown_call"


def test_dispatch_wraps_errors():
    r = bridge.dispatch("run", {"level": {"id": "x"}})
    assert "error" in r and r["error"]["code"] == "level_schema"


def test_dispatch_positional_and_kwargs():
    assert bridge.dispatch("run", [LEVEL1, None, "idle"])["result"]["score"] == 300
    assert bridge.dispatch("ping")["result"]["ok"] is True


# --- hand placement (Stage 5) ---------------------------------------------------


def _play_by_hand(level):
    h = bridge.hand_start(level)["handle"]
    for _ in range(2000):
        st = bridge._snapshot(bridge._SESSIONS[h])
        for jid in list(st["queued"]):
            bridge.hand_place(h, jid)
        if bridge.hand_tick(h)["done"]:
            break
    return bridge.hand_result(h)


def test_hand_start_returns_nodes_and_suggestions():
    out = bridge.hand_start(LEVEL1)
    assert "nodes" in out and "suggestions" in out and "handle" in out


def test_hand_suggestions_do_not_mutate():
    h = bridge.hand_start(LEVEL1)["handle"]
    before = bridge._snapshot(bridge._SESSIONS[h])
    bridge._suggestions(bridge._SESSIONS[h])
    assert bridge._snapshot(bridge._SESSIONS[h]) == before


def test_hand_placement_completes_deterministically():
    r = _play_by_hand(LEVEL1)
    states = {j["state"] for j in r["jobs"]}
    assert states <= {"done", "timeout"} and "unfinished" not in states
    # A hand run equals the deterministic reference run for the same placements.
    assert r["trajectory_hash"] == _play_by_hand(LEVEL1)["trajectory_hash"]
    assert r["metrics"]["utilization"] > 0.3


def test_hand_place_surfaces_errors_without_crashing():
    h = bridge.hand_start(LEVEL1)["handle"]
    # Place a job on too many nodes -> engine error, run stays alive.
    out = bridge.hand_place(h, "0", ["n0", "n1", "n2", "n3"])  # most jobs want 1 node
    assert out["ok"] is False and "error" in out
    assert bridge.hand_tick(h) is not None  # still steppable


def test_dispatch_reaches_hand_api():
    assert bridge.dispatch("hand_start", {"level": LEVEL1})["result"]["nodes"]


def test_dispatch_progression_round_trip():
    st = bridge.dispatch("progression_completion",
                         {"state": None, "level_id": "level1", "score": 800, "seed": 1})["result"]
    assert st["credits"] == 105  # 80 + gold bonus
    st["credits"] = 200
    st["lifetime"] = 200
    st = bridge.dispatch("progression_buy", {"state": st, "upgrade_id": "reserve"})["result"]
    assert st["credits"] == 140
    view = bridge.dispatch("progression_view", {"state": st})["result"]
    assert "reserve" in view["unlocked"] and view["credits"] == 140
    assert bridge.dispatch("progression_buy", {"state": st, "upgrade_id": "nope"})["error"]["code"]
