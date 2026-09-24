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

from scheduler_dojo.sim.level import load_level_file, run_level

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "levels" / "fixture.json"
OUT = ROOT / "tests" / "goldens" / "stage1.json"

SEEDS = [1, 2, 3]
POLICIES = ["fifo", "shortest_first"]


def main() -> None:
    level = load_level_file(FIXTURE)
    data: dict[str, dict] = {}
    for seed in SEEDS:
        for policy in POLICIES:
            res = run_level(level, seed=seed, policy=policy)
            key = f"{seed}:{policy}"
            from scheduler_dojo.sim.trajectory import trajectory_hash

            data[key] = {
                "trajectory_hash": trajectory_hash(res),
                "end_time": res.end_time,
                "node_seconds_busy": res.node_seconds_busy,
                "n_jobs": res.n_jobs,
            }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT} ({len(data)} scenarios)")


if __name__ == "__main__":
    main()
