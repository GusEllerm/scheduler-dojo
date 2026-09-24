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

## 2026-09-24 — CI installs livedocs from the GusEllerm/vault-drift git source `[agent decision]`

The brief names `uv tool install git+https://github.com/GusEllerm/vault-drift` as the fallback
installer, so `ci.yml` uses that exact source for `livedocs verify`. Alternatives: a published PyPI
package (none found under that name) or a brew formula for livedocs (drift is brew, livedocs is the
python tool). If the git install proves flaky in CI, pin a commit SHA.
