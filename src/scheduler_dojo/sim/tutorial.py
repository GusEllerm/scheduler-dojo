"""Tutorial city editions: validate and apply a `level_patch` over a canonical level.

Per ``docs/vault/Concepts/Tutorial.md`` a patch is a deterministic **city edition** of a shipped
level: it never mutates the shared calibrated level (calibration and share cards still refer to
`level`), it touches whitelisted top-level keys only (``story``, ``duration``, ``generator``),
and every ``generator`` sub-key must already be a knob of the referenced level's generator — the
same rules ``scripts/check_tutorials.py`` enforces over the data. All pure functions over plain
dicts; no RNG, no wall clock ([[Determinism]]).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from scheduler_dojo.sim.errors import LEVEL_SCHEMA, LevelError
from scheduler_dojo.sim.level import load_level_file

# Whitelisted level_patch top-level keys (mirrors check_tutorials.PATCH_KEYS).
PATCH_KEYS = frozenset({"story", "duration", "generator"})

# Repo layout, resolved the way sim/level.py:load_level_file does — plain paths under the repo.
ROOT = Path(__file__).resolve().parents[3]
TUTORIALS_DIR = ROOT / "levels" / "tutorials"
LEVELS_DIR = ROOT / "levels"


def validate_patch(patch: Any, level: dict[str, Any] | None = None) -> None:
    """Raise ``LevelError(code="level_schema")`` if a patch is outside the whitelist.

    With `level` given, also require every ``generator`` sub-key to exist in the base level's
    generator (a patch editions knobs, never invents a new generator shape).
    """
    if not isinstance(patch, dict):
        raise LevelError("level_patch must be an object", code=LEVEL_SCHEMA)
    unknown = sorted(set(patch) - PATCH_KEYS)
    if unknown:
        raise LevelError(
            f"level_patch has non-whitelisted key(s) {unknown} (allowed: {sorted(PATCH_KEYS)})",
            code=LEVEL_SCHEMA)
    if "story" in patch and not isinstance(patch["story"], str):
        raise LevelError("level_patch.story must be a string", code=LEVEL_SCHEMA)
    if "duration" in patch:
        d = patch["duration"]
        if not isinstance(d, int) or isinstance(d, bool) or d <= 0:
            raise LevelError("level_patch.duration must be a positive integer", code=LEVEL_SCHEMA)
    if "generator" not in patch:
        return
    gen = patch["generator"]
    if not isinstance(gen, dict):
        raise LevelError("level_patch.generator must be an object", code=LEVEL_SCHEMA)
    if level is None:
        return
    base_gen = level.get("generator")
    if not isinstance(base_gen, dict):
        raise LevelError("level_patch.generator: referenced level has no generator to patch",
                         code=LEVEL_SCHEMA)
    for key in sorted(gen):
        if key not in base_gen:
            raise LevelError(
                f"level_patch.generator.{key}: not a knob of the referenced level "
                f"(allowed: {sorted(base_gen)})", code=LEVEL_SCHEMA)


def apply_patch(level: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Return a patched deep copy of `level`; the base level is never mutated (pure)."""
    validate_patch(patch, level)
    out = copy.deepcopy(level)
    for key in ("story", "duration"):
        if key in patch:
            out[key] = copy.deepcopy(patch[key])
    for key, value in sorted((patch.get("generator") or {}).items()):
        out["generator"][key] = copy.deepcopy(value)
    return out


def load_tutorial(ref: str | Path = "city1") -> dict[str, Any]:
    """Load a tutorial document: a bare city name resolves to ``levels/tutorials/<name>.json``."""
    path = Path(ref)
    if not (path.is_absolute() or path.exists()):
        path = TUTORIALS_DIR / f"{path}.json"
    return json.loads(Path(path).read_text())


def load_city_level(ref: str | Path = "city1") -> dict[str, Any]:
    """Load the city's **edition** of its canonical level: ``levels/<level>.json`` + patch applied.

    The referenced level resolves repo-relative the way every level file does
    (``sim/level.py:load_level_file``); the returned dict is a fresh patched copy — the file on
    disk and any previously loaded copy are untouched.
    """
    tutorial = load_tutorial(ref) if not isinstance(ref, dict) else ref
    level_ref = tutorial.get("level")
    if not isinstance(level_ref, str) or not level_ref:
        raise LevelError("tutorial missing 'level' reference", code=LEVEL_SCHEMA)
    path = Path(level_ref)
    if not (path.is_absolute() or path.exists()):
        path = LEVELS_DIR / f"{level_ref}.json"
    level = load_level_file(path)
    patch = tutorial.get("level_patch") or {}
    if patch:
        return apply_patch(level, patch)
    return copy.deepcopy(level)
