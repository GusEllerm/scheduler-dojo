#!/usr/bin/env python3
"""Calibrate levels into deterministic *puzzles*.

Every level gets a fixed ``seed`` (determinism is the whole point: the same puzzle for everyone, and
a replayable share card). On that seed we run the ``baseline_policy`` and the ``reference_kata``, then
solve per-metric anchors so ``score(baseline) == 300`` and ``score(reference) == 800`` **exactly**.

Only metrics where the reference is at least as good as the baseline are scored (a Pareto filter on
that seed), so clearing the gold bar means genuinely matching the reference's improvements — the gold
is earned, not baked in. If no seed is Pareto-clean we keep the level's ``primary_metric`` (the lesson)
on the seed where the reference improves it most, so the teaching signal stays honest even when the
reference trades a secondary metric away.

Run with ``--write`` to update the level JSONs in place; run bare to report.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.level import load_level_file, run_level, validate_level

REPO = Path(__file__).resolve().parent.parent
LEVELS_DIR = REPO / "levels"
CANDIDATE_SEEDS = range(0, 8)
LOWER_BETTER = frozenset({"bounded_slowdown", "wait_p95"})


def resolve_reference(level: dict) -> str | None:
    ref = level.get("reference_kata")
    cand = LEVELS_DIR / ref if ref else None
    return cand.read_text() if cand and cand.exists() else None


def _metrics(level: dict, seed: int, *, policy=None, kata=None) -> dict[str, float]:
    return scoring.metrics_from_run(run_level(level, seed=seed, policy=policy, kata=kata))


def _round(v: float) -> float:
    return round(float(v), 6)


def _no_worse(metric: str, base: float, ref: float) -> bool:
    return ref <= base if metric in LOWER_BETTER else ref >= base


def _improves(metric: str, base: float, ref: float) -> bool:
    return ref < base if metric in LOWER_BETTER else ref > base


def calibrate_level(level: dict) -> dict:
    """Pick a fixed seed and solve anchors so baseline→300 and reference→800 on it.

    Raises ``ValueError`` if no candidate seed lets the reference improve the primary metric.
    """
    validate_level(level)
    baseline = level.get("baseline_policy", level.get("default_policy", "fifo"))
    ref_src = resolve_reference(level)
    if ref_src is None:
        raise ValueError(f"level {level.get('id')} has no resolvable reference_kata")
    primary = level.get("primary_metric", "bounded_slowdown")

    best: tuple[float, int, list[str], dict, dict] | None = None
    for seed in CANDIDATE_SEEDS:
        base = _metrics(level, seed, policy=baseline)
        ref = _metrics(level, seed, kata=ref_src)
        metrics = sorted(set(base) & set(ref))
        if not _improves(primary, base[primary], ref[primary]):
            continue
        pareto = [m for m in metrics if _round(base[m]) != _round(ref[m]) and _no_worse(m, base[m], ref[m])]
        keep = pareto or [primary]
        gain = abs(ref[primary] - base[primary]) / max(abs(base[primary]), 1e-9)
        # Prefer a Pareto-clean seed; among those, the largest primary gain.
        score = (1 if pareto else 0, gain)
        if best is None or score > best[0]:
            best = (score, seed, keep, base, ref)

    if best is None:
        raise ValueError(f"level {level.get('id')}: no seed in {list(CANDIDATE_SEEDS)} where the "
                         f"reference improves the primary metric {primary!r}")

    _, seed, keep, base, ref = best
    out = dict(level)
    out["seed"] = seed
    out["primary_metric"] = primary
    out["score_weights"] = {m: 1.0 for m in keep}
    out["score_anchors"] = {m: {"baseline": _round(base[m]), "reference": _round(ref[m])} for m in keep}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="update level JSONs in place")
    args = ap.parse_args(argv)

    ok = True
    for path in sorted(LEVELS_DIR.glob("level*.json")):
        level = load_level_file(path)
        try:
            cal = calibrate_level(level)
        except Exception as exc:  # noqa: BLE001
            print(f"{path.name}: CALIBRATION FAILED — {exc}")
            ok = False
            continue
        w, a = cal["score_weights"], cal["score_anchors"]
        s_base = scoring.score(_metrics(cal, cal["seed"], policy=cal.get("baseline_policy", cal.get("default_policy", "fifo"))), w, a)
        s_ref = scoring.score(_metrics(cal, cal["seed"], kata=resolve_reference(cal)), w, a)
        gold = cal.get("bars", {}).get("gold_score", 720)
        good = s_base == 300 and s_ref == 800
        ok = ok and good and s_ref >= gold
        print(f"{path.name}: seed={cal['seed']} baseline={s_base} reference={s_ref} "
              f"(scored={sorted(w)}) gold={gold} {'OK' if good and s_ref >= gold else 'CHECK'}")
        if args.write:
            path.write_text(json.dumps(cal, indent=2) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
