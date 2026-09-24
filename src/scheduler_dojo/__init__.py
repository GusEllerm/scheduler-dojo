"""Scheduler Dojo: be the scheduler, then automate yourself out of the job."""

__version__ = "0.1.0"


def main() -> None:
    from scheduler_dojo.cli import main as cli_main

    raise SystemExit(cli_main())
