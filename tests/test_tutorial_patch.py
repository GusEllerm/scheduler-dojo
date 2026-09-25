"""level_patch is a deterministic city *edition* of a canonical level — never a fork ([[Tutorial]])."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from scheduler_dojo.sim.errors import LevelError
from scheduler_dojo.sim.level import load_level_file, validate_level
from scheduler_dojo.sim.tutorial import apply_patch, load_city_level, load_tutorial, validate_patch

ROOT = Path(__file__).resolve().parent.parent
BASE = {
    "id": "levelX", "title": "X", "duration": 40000, "story": "canonical",
    "generator": {"users": [{"name": "alice", "weight": 1.0}],
                  "arrival": {"type": "poisson", "rate_per_hour": 8},
                  "n_jobs": 16},
    "cluster": {"nodes": [{"id": "n0"}]},
}


def _patched(base=BASE):
    return copy.deepcopy(base)


def test_whitelist_accepts_story_duration_and_existing_generator_knobs():
    validate_patch({"story": "new"}, BASE)
    validate_patch({"duration": 50000}, BASE)
    validate_patch({"generator": {"users": [{"name": "bob", "weight": 1.0}]}}, BASE)
    validate_patch({"generator": {"arrival": {"min": 1800, "max": 3600}, "n_jobs": 4}}, BASE)


@pytest.mark.parametrize("patch", [
    {"cluster": {}},                                    # top key off the whitelist
    {"generator": {"n_jobs": 4}, "sandbox": True},      # one nested-good, one top-bad
    {"seed": 3},
    {"generator": {"made_up_knob": 1}},                 # nested key not in the base generator
    {"generator": {"users": []}, "duration": 0},         # bad duration
])
def test_non_whitelisted_keys_raise_level_schema(patch):
    with pytest.raises(LevelError) as exc:
        apply_patch(_patched(), patch)
    assert exc.value.code == "level_schema"


def test_generator_patch_needs_a_generator_to_patch():
    base = _patched()
    del base["generator"]
    base["jobs"] = [{"id": "j0", "submit_time": 0}]
    with pytest.raises(LevelError) as exc:
        apply_patch(base, {"generator": {"users": []}})
    assert exc.value.code == "level_schema"


def test_apply_patch_is_pure_and_edits_only_what_it_names():
    base = _patched()
    before = copy.deepcopy(base)
    out = apply_patch(base, {"story": "edition", "generator": {"users": [{"name": "bob",
                                                                          "weight": 1.0}]}})
    assert base == before                                       # base untouched
    assert out is not base
    assert out["story"] == "edition"
    assert out["generator"]["users"] == [{"name": "bob", "weight": 1.0}]
    assert out["generator"]["arrival"] == BASE["generator"]["arrival"]  # untouched knobs intact
    assert out["generator"]["n_jobs"] == 16
    out["generator"]["users"].append({"name": "eve"})           # mutating the copy...
    assert base["generator"]["users"] == BASE["generator"]["users"]  # ...never leaks to the base


@pytest.mark.parametrize("name", ["city1", "city2", "city3"])
def test_shipped_cities_load_and_patch_their_referenced_real_level(name):
    tutorial = load_tutorial(name)
    assert tutorial["city"] >= 1
    level = load_city_level(name)
    raw = json.loads((ROOT / "levels" / f"{tutorial['level']}.json").read_text())
    validate_level(level)                            # the edition is still a valid level
    assert level["id"] == tutorial["level"]
    for key, value in tutorial.get("level_patch", {}).items():
        if key == "generator":
            for knob, val in value.items():
                assert level["generator"][knob] == val
        else:
            assert level[key] == value
    # The edition never changes the shared file: reload after loading is byte-equal.
    patched = json.loads(json.dumps(raw))
    for key, value in tutorial.get("level_patch", {}).items():
        if key == "generator":
            patched["generator"].update(value)
        else:
            patched[key] = value
    assert level == patched
    assert load_level_file(ROOT / "levels" / f"{tutorial['level']}.json") == raw
