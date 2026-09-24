"""Sanity checks that the package and console script are wired up."""

import subprocess
import sys

import scheduler_dojo


def test_version_present():
    assert isinstance(scheduler_dojo.__version__, str)
    assert scheduler_dojo.__version__.count(".") >= 2


def test_cli_module_importable():
    from scheduler_dojo import cli

    assert callable(cli.main)


def test_console_script_runs():
    out = subprocess.run(
        [sys.executable, "-m", "scheduler_dojo.cli", "--version"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == scheduler_dojo.__version__
