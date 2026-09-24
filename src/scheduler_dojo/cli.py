"""Command-line entry point for Scheduler Dojo.

Subcommands (``run``, ``score``, ``verify-card``, ``import-trace``, ``kata``) are
added as the engine lands; for now this is a placeholder that keeps the
``dojo`` console script resolvable.
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dojo", description="Scheduler Dojo engine")
    parser.add_argument(
        "--version", action="store_true", help="print version and exit"
    )
    args = parser.parse_args(argv)
    if args.version:
        from scheduler_dojo import __version__

        print(__version__)
        return 0
    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
