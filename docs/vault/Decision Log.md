# Decision Log

Dated entries, each tagged `[agent decision]`, recording choices a human might want to revisit —
the alternatives considered and why. Newest at the top.

## 2026-09-24 — Console script named `dojo` `[agent decision]`

`uv init` generated a `scheduler-dojo` script pointing at `scheduler_dojo:main`. The brief's layout
(§4) names the command `dojo` (`dojo run`, `dojo score`, …), so the entry point is
`dojo = scheduler_dojo.cli:main` and `main()` lives in `src/scheduler_dojo/cli.py`. The package
`__init__` still re-exports a `main()` for convenience. Alternative: keep the long script name —
rejected, the brief uses `dojo` everywhere.

## 2026-09-24 — Python floor is 3.12, wheel targets Pyodide's minor `[agent decision]`

`requires-python = ">=3.12"`. The wheel is pure `py3-none-any` so it runs on any CPython/Pyodide
that satisfies the floor. If cross-runtime determinism ever diverges we will pin the wheel's
language features to Pyodide's bundled CPython minor (see [[Determinism]]). Alternative: pin `==3.12`
— rejected for now to keep native installs flexible; revisit at Stage 4 if Pyodide's version needs it.

## 2026-09-24 — CI installs drift (public installer) + livedocs (PyPI) `[agent decision]`

`ci.yml` installs the `drift` fingerprinter from `https://drift.fp.dev/install.sh` (public,
installs to `~/.local/bin`) and `livedocs` from PyPI (`uv tool install livedocs`, stdlib-only).
The brief first suggested a git install from `GusEllerm/vault-drift`, but that repo is **private**,
so the Actions runner's token cannot fetch it (`could not read Username … terminal prompts
disabled`). Making it public or adding a PAT secret are account/security changes only a human
should make, so we switched to the public sources instead. Pin a version (drift via `--install-dir`,
livedocs `==<ver>`) if a future release changes the stamp/hash format — note the local dev install is
an editable checkout, so its subcommand surface must stay compatible with the pinned PyPI version.
