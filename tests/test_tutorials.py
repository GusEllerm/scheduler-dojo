"""The tutorial sequences are data, not code — so the data is the spec's test surface.

`scripts/check_tutorials.py` validates ``levels/tutorials/city*.json`` against
``docs/vault/Concepts/Tutorial.md``. These tests run its real entry point on the shipped files
(must be clean) and on mutated copies in tmp (must fail, naming the JSON path).
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check_tutorials.py"
TUTORIALS = ROOT / "levels" / "tutorials"


def _checker():
    spec = importlib.util.spec_from_file_location("check_tutorials", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _data(name: str) -> dict:
    return json.loads((TUTORIALS / name).read_text())


def _write(tmp_path: Path, files: dict[str, dict]) -> list[Path]:
    paths = []
    for name, doc in files.items():
        path = tmp_path / name
        path.write_text(json.dumps(doc))
        paths.append(path)
    return paths


def test_checker_reads_the_three_shipped_cities():
    checker = _checker()
    assert [p.name for p in checker.default_files()] == ["city1.json", "city2.json", "city3.json"]


def test_shipped_tutorials_are_valid():
    checker = _checker()
    assert checker.check_files(checker.default_files()) == {}


def test_main_exits_zero_on_the_real_files(capsys):
    assert _checker().main([]) == 0
    assert "valid" in capsys.readouterr().out


def _set(doc: dict, parts: list, value) -> dict:
    node = doc
    for part in parts[:-1]:
        node = node[int(part)] if isinstance(node, list) else node[part]
    if isinstance(node, list):
        node[int(parts[-1])] = value
    else:
        node[parts[-1]] = value
    return doc


@pytest.mark.parametrize(
    "parts,value,fragment",
    [
        (["version"], 2, "$.version"),
        (["steps", 0, "when", "whoosh"], 1, "$.steps[0].when.whoosh"),
        (["steps", 0, "when"], {"behind": True}, "standalone trigger"),
        (["steps", 1, "when"], {"on_event": "alien_event"}, "unknown event"),
        (["steps", 0, "do", 1, "callout", "anchor"], "moon", "scene vocabulary"),
        (["steps", 0, "then"], [{"wait_for": {"chosen": True}}], "wait_for"),
        (["steps", 1, "then"], [{"end": True}], "only appear in the final step"),
        (["steps", 1, "id"], "welcome", "duplicate step id"),
        (["level_patch", "hard_mode"], True, "$.level_patch.hard_mode"),
        (["level_patch", "generator", "not_a_knob"], {}, "not a knob"),
        (["level_patch", "generator", "users", 0, "name"], "", "non-empty string"),
        (["steps", 7, "do", 1, "offer_upgrade"], {"forced": "timewarp"}, "unknown upgrade"),
        (["level"], "level99", "no levels/level99.json"),
    ],
)
def test_broken_copy_fails_naming_the_path(tmp_path, parts, value, fragment):
    checker = _checker()
    broken = _set(copy.deepcopy(_data("city1.json")), parts, value)
    (path,) = _write(tmp_path, {"city1.json": broken})
    errors = checker.check_file(path)
    assert any(fragment in e for e in errors), errors
    assert checker.main([str(path)]) == 1


def test_end_may_not_appear_before_the_last_step(tmp_path):
    checker = _checker()
    broken = _data("city1.json")
    broken["steps"][1]["then"] = [{"end": True}]
    (path,) = _write(tmp_path, {"city1.json": broken})
    assert any("final step" in e for e in checker.check_file(path))


def test_duplicate_city_number_is_rejected(tmp_path):
    checker = _checker()
    clone = copy.deepcopy(_data("city1.json"))
    clone["steps"] = clone["steps"][:1]
    paths = _write(tmp_path, {"city1.json": _data("city1.json"), "city1b.json": clone})
    report = checker.check_files(paths)
    assert any("claimed by more than one file" in e for e in report.get("_cross-city", [])), report


def test_upgrade_may_not_be_referenced_before_its_city_offers_it(tmp_path):
    checker = _checker()
    early = _set(_data("city2.json"), ["steps", 1, "then"], [{"wait_for": {"owned": "reservations"}}])
    paths = _write(
        tmp_path,
        {"city1.json": _data("city1.json"), "city2.json": early, "city3.json": _data("city3.json")},
    )
    report = checker.check_files(paths)
    assert any("before it is offered in city 3" in e for e in report.get("_cross-city", [])), report
    # ...and the shipped order (reservations introduced in city3) is clean.
    assert checker.check_files(_write(tmp_path, {
        "city1.json": _data("city1.json"),
        "city2.json": _data("city2.json"),
        "city3.json": _data("city3.json"),
    })) == {}


def test_unknown_builtin_would_be_rejected(tmp_path):
    """No shipped tutorial names a builtin; the vocabulary from kata spec §6 is still enforced."""
    checker = _checker()
    assert "earliest_fit" in checker.builtin_tiers() and "queue" in checker.builtin_tiers()
    broken = _data("city3.json")
    broken["steps"][2]["do"].insert(0, {"reveal": {"builtins": ["teleport_jobs"]}})
    (path,) = _write(tmp_path, {"city3.json": broken})
    assert any("unknown builtin" in e for e in checker.check_file(path))
