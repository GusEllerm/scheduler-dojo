#!/usr/bin/env python3
"""Regenerate Stage 1 golden trajectories for the fixture level.

The ONLY sanctioned way to change the goldens (quality bar: goldens are script-generated and
reviewed in the diff). Run with `uv run python scripts/gen_goldens.py` and commit the result.

Emits tests/goldens/stage1.json keyed by "<seed>:<policy>" with the trajectory hash and a
couple of cheap scalars, so a regression points at exactly which scenario drifted.
"""

from __future__ import annotations

import json
from pathlib import Path

from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.level import load_level_file, run_level
from scheduler_dojo.sim.trajectory import trajectory_hash

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "levels" / "fixture.json"
LEVELS_DIR = ROOT / "levels"
OUT = ROOT / "tests" / "goldens" / "stage1.json"
LEVELS_OUT = ROOT / "tests" / "goldens" / "levels.json"

SEEDS = [1, 2, 3]
POLICIES = ["fifo", "shortest_first"]


def _resolve_reference(level):
    ref = level.get("reference_kata")
    cand = LEVELS_DIR / ref if ref else None
    return cand.read_text() if cand and cand.exists() else None


def _score(level, res):
    w, a = level.get("score_weights"), level.get("score_anchors")
    if w and a:
        return scoring.score(scoring.metrics_from_run(res), w, a)
    return None


def _emit_fixture() -> None:
    level = load_level_file(FIXTURE)
    data: dict[str, dict] = {}
    for seed in SEEDS:
        for policy in POLICIES:
            res = run_level(level, seed=seed, policy=policy)
            key = f"{seed}:{policy}"
            data[key] = {
                "trajectory_hash": trajectory_hash(res),
                "end_time": res.end_time,
                "node_seconds_busy": res.node_seconds_busy,
                "n_jobs": res.n_jobs,
            }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT} ({len(data)} scenarios)")


def _emit_levels() -> None:
    data: dict[str, dict] = {}
    for path in sorted(LEVELS_DIR.glob("level*.json")):
        level = load_level_file(path)
        baseline = level.get("baseline_policy", level.get("default_policy", "fifo"))
        ref = _resolve_reference(level)
        seed = int(level["seed"])
        rb = run_level(level, seed=seed, policy=baseline)
        entry = {"seed": seed, "baseline_policy": baseline,
                 "baseline_hash": trajectory_hash(rb), "baseline_score": _score(level, rb)}
        if ref is not None:
            rr = run_level(level, seed=seed, kata=ref)
            entry["reference_hash"] = trajectory_hash(rr)
            entry["reference_score"] = _score(level, rr)
        data[path.name] = entry
    LEVELS_OUT.parent.mkdir(parents=True, exist_ok=True)
    LEVELS_OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(f"wrote {LEVELS_OUT} ({len(data)} levels)")


def main() -> None:
    _emit_fixture()
    _emit_levels()


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
