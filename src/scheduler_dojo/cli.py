"""Command-line entry point for Scheduler Dojo.

Stage 1 ships ``dojo run``; ``score``, ``verify-card``, ``import-trace`` and ``kata`` are
added in later stages. Everything here is a thin skin over ``scheduler_dojo.sim``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _cmd_run(args: argparse.Namespace) -> int:
    from scheduler_dojo.sim import scoring
    from scheduler_dojo.sim.level import load_level_file, run_level
    from scheduler_dojo.sim.trajectory import trajectory_hash

    level = (
        load_level_file(args.level)
        if args.level
        else json.loads(args.level_json)
    )
    result = run_level(level, seed=args.seed, policy=args.policy, kata=args.kata)
    metrics = scoring.metrics_from_run(result)
    out = {
        "policy": args.policy,
        "seed": args.seed,
        "n_jobs": result.n_jobs,
        "end_time": result.end_time,
        "node_seconds_busy": result.node_seconds_busy,
        "metrics": metrics,
        "trajectory_hash": trajectory_hash(result),
    }
    weights = level.get("score_weights")
    anchors = level.get("score_anchors")
    if weights and anchors:
        out["score"] = scoring.score(metrics, weights, anchors)
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


def _cmd_kata(args: argparse.Namespace) -> int:
    from scheduler_dojo.kata import format as kata_format
    from scheduler_dojo.kata import parse
    from scheduler_dojo.kata.check import check

    if args.file == "-":
        src = sys.stdin.read()
    else:
        try:
            src = Path(args.file).read_text()
        except OSError as exc:
            print(f"kata: cannot read {args.file}: {exc.strerror}", file=sys.stderr)
            return 2

    if args.action == "check":
        from scheduler_dojo.kata.check import format_report

        report = check(src)
        print(format_report(report, src))
        return 0 if report.ok else 1
    if args.action == "format":
        print(kata_format(src), end="")
        return 0
    # action == "run"
    if not args.level:
        print("kata run needs --level", file=sys.stderr)
        return 2
    from scheduler_dojo.sim import scoring
    from scheduler_dojo.sim.level import load_level_file, run_level

    level = load_level_file(args.level)
    result = run_level(level, seed=args.seed, policy=args.policy, kata=src)
    metrics = scoring.metrics_from_run(result)
    out = {"kata": args.file, "seed": args.seed, "n_jobs": result.n_jobs,
           "end_time": result.end_time, "metrics": metrics}
    weights, anchors = level.get("score_weights"), level.get("score_anchors")
    if weights and anchors:
        out["score"] = scoring.score(metrics, weights, anchors)
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


def _cmd_import_trace(args: argparse.Namespace) -> int:
    from scheduler_dojo.sim.trace import import_sacct_csv, level_from_jobs

    jobs = import_sacct_csv(args.csv)
    level = level_from_jobs(jobs, level_id=args.id, nodes=args.nodes, cpus=args.cpus)
    text = json.dumps(level, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + "\n")
        print(json.dumps({"wrote": args.out, "n_jobs": len(jobs),
                          "nodes": len(level["cluster"]["nodes"])}, sort_keys=True))
    else:
        print(text)
    return 0


def _cmd_verify_card(args: argparse.Namespace) -> int:
    import json as _json
    from pathlib import Path

    from scheduler_dojo.share.card import decode_card, replay_card

    payload = sys.stdin.read() if args.card == "-" else args.card
    card = decode_card(payload)
    level = None
    if "level" not in card:  # level_id card -> look it up from the shipped set
        cand = Path(args.levels_dir) / f"{card.get('level_id')}.json"
        if not cand.exists():
            print(_json.dumps({"ok": False, "error": f"level file not found: {cand}"}, sort_keys=True))
            return 1
        level = _json.loads(cand.read_text())
    out = replay_card(card, level=level)
    out["tamper_evident"] = card.get("hash") is not None
    print(_json.dumps(out, indent=2, sort_keys=True))
    return 0 if out["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dojo", description="Scheduler Dojo engine")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    sub = parser.add_subparsers(dest="cmd")

    run = sub.add_parser("run", help="run a level headless")
    run.add_argument("--level", help="path to a level JSON file")
    run.add_argument("--level-json", help="inline level JSON (for tests)")
    run.add_argument("--seed", type=int, default=0)
    run.add_argument("--policy", default="fifo", choices=["fifo", "shortest_first"])
    run.add_argument("--kata", help="path to (or inline) a kata program to run instead of --policy")
    run.set_defaults(func=_cmd_run)

    kata = sub.add_parser("kata", help="check / format / run a kata")
    kata.add_argument("action", choices=["check", "format", "run"])
    kata.add_argument("file", help="kata source file, or - for stdin")
    kata.add_argument("--level", help="level JSON (for 'run')")
    kata.add_argument("--seed", type=int, default=0)
    kata.add_argument("--policy", default="fifo", choices=["fifo", "shortest_first"],
                      help="fallback policy for 'run'")
    kata.set_defaults(func=_cmd_kata)

    imp = sub.add_parser("import-trace", help="import a Slurm sacct CSV export as a playable level")
    imp.add_argument("csv", help="path to a sacct CSV export")
    imp.add_argument("--out", help="write the level JSON here (default: stdout)")
    imp.add_argument("--nodes", type=int, help="override the node count (default: peak demand)")
    imp.add_argument("--cpus", type=int, default=1, help="cpus per node")
    imp.add_argument("--id", default="trace", help="level id")
    imp.set_defaults(func=_cmd_import_trace)

    vc = sub.add_parser("verify-card", help="replay a share card and check its trajectory hash")
    vc.add_argument("card", help="share-card payload (#c=…), or - for stdin")
    vc.add_argument("--levels-dir", default="levels", help="where to find level_id references")
    vc.set_defaults(func=_cmd_verify_card)

    args = parser.parse_args(argv)
    if getattr(args, "version", False):
        from scheduler_dojo import __version__

        print(__version__)
        return 0
    if not getattr(args, "cmd", None):
        parser.print_help(sys.stderr)
        return 2
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
