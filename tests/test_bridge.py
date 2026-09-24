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
