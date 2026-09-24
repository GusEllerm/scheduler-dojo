"""Stage 8 trace mode: import a sacct CSV, wrap it in a level, and run it (no server, deterministic)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from scheduler_dojo import cli
from scheduler_dojo.sim.level import run_level, validate_level
from scheduler_dojo.sim.trace import import_sacct_csv, level_from_jobs

CSV = str(Path(__file__).parent / "data" / "sample_sacct.csv")


def test_import_maps_columns():
    jobs = import_sacct_csv(CSV)
    assert len(jobs) == 5
    a = next(j for j in jobs if j.id == "1001")
    assert a.user == "alice" and a.nodes_req == 1
    assert a.submit_time == 0             # earliest submit is the t=0 anchor
    assert a.actual_runtime == 300        # 00:05:00
    assert a.walltime_req == 600          # 00:10:00
    big = next(j for j in jobs if j.id == "1003")
    assert big.actual_runtime == 86400    # 1-00:00:00


def test_import_anchors_at_zero_and_is_deterministic():
    jobs = import_sacct_csv(CSV)
    assert min(j.submit_time for j in jobs) == 0
    # Deterministic: same input -> identical ids/times, and sorted by (submit, id).
    again = import_sacct_csv(CSV)
    assert [(j.id, j.submit_time) for j in jobs] == [(j.id, j.submit_time) for j in again]
    assert jobs == sorted(jobs, key=lambda j: (j.submit_time, j.id))


def test_level_from_jobs_is_runnable():
    level = level_from_jobs(import_sacct_csv(CSV))
    validate_level(level)                 # explicit-jobs levels pass the same gate
    assert level["generator"] is None and len(level["jobs"]) == 5
    assert level["cluster"]["nodes"]      # some nodes inferred from peak demand
    res = run_level(level, seed=0, policy="fifo")
    assert res.n_jobs == 5


def test_import_trace_cli(tmp_path, capsys):
    out = tmp_path / "trace_level.json"
    rc = cli.main(["import-trace", CSV, "--out", str(out)])
    assert rc == 0
    level = json.loads(out.read_text())
    assert len(level["jobs"]) == 5
    assert level["id"] == "trace"
    # and the produced level actually runs headless
    assert run_level(level, seed=0, policy="fifo").n_jobs == 5


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
