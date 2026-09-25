#!/usr/bin/env python3
"""Validate the tutorial sequence data under ``levels/tutorials/`` against the schema in
``docs/vault/Concepts/Tutorial.md``.

Run with ``uv run python scripts/check_tutorials.py`` — exit 0 and a one-line summary when every
file is clean, otherwise exit 1 with every violation listed per file (all errors in a file are
collected, never just the first). The checks are:

1. top level (``version``, unique ``city``, ``title``, ``level`` resolving to ``levels/<level>.json``,
   non-empty ``steps``, ``end``);
2. every step carries ``id`` (unique in the file) + ``when`` + ``do`` + ``then``, and no unknown key
   appears anywhere (the offending JSON path is named);
3. ``when`` is exactly one trigger clause — or ``all`` of 2+ clauses;
4. ``do`` actions come from the documented vocabulary;
5. ``then`` is a ``wait_for`` (one predicate, optional ``timeout_secs`` / ``or_then``) or ``end``;
6. ``level_patch`` touches whitelisted fields only, and ``generator`` sub-keys exist in the level;
7. anchors/highlight targets live in the scene vocabulary (or name a building / builtin);
8. cross-city monotonicity: no upgrade is referenced before the city that first introduces it;
9. ``steps`` is a single ordered list — ``end`` appears only in the final step's ``then``.

Two deliberate interpretations, both flagged rather than hidden:
* ``Tutorial.md`` lists ``wait_for`` predicates as engine facts and says triggers read only engine
  facts, so ``behind`` is accepted as an *extra* clause inside ``when.all`` (as city1's
  ``staff-booth`` needs) but never as a standalone trigger — the note's enumerated clause list
  (``after_days`` | ``after_sim_secs`` | ``on_event`` | ``first_time``) stays closed.
* ``Tutorial.md`` calls the reservation building ``reservations`` while ``progression.UPGRADES``
  ids it ``reserve``; the checker accepts the prose name as an alias of the progression id
  (``RESERVATION_ALIAS``) and errors if the alias ever stops pointing at a real upgrade.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TUTORIALS_DIR = ROOT / "levels" / "tutorials"
LEVELS_DIR = ROOT / "levels"
SPEC_MD = ROOT / "src" / "scheduler_dojo" / "kata" / "spec.md"

SCHEMA_VERSION = 1

# Upgrade/building names: the progression ids plus Tutorial.md's prose name for the reserve building.
RESERVATION_ALIAS = "reservations"
ALIAS_TO_UPGRADE = {RESERVATION_ALIAS: "reserve"}


def upgrade_names() -> set[str]:
    """The five building/upgrade names a tutorial may name (canonical ids + documented alias)."""
    from scheduler_dojo.progression import UPGRADES  # imported lazily: the checker stays standalone-ish

    names = set(UPGRADES)
    for alias, target in ALIAS_TO_UPGRADE.items():
        if target in UPGRADES:
            names.add(alias)
    return names


def canonical_upgrade(name: str) -> str:
    return ALIAS_TO_UPGRADE.get(name, name)


# --- vocabularies -----------------------------------------------------------------------------

TOP_KEYS = {"version", "city", "title", "level", "level_patch", "steps", "end"}
STEP_KEYS = {"id", "when", "do", "then"}
PATCH_KEYS = {"story", "duration", "generator", "pressure"}
WHEN_KEYS = {"after_days", "after_sim_secs", "on_event", "first_time", "all", "once"}
# Engine-fact predicates allowed *inside* `when.all` only (never standalone) — see module docstring.
WHEN_ALL_ONLY_FACTS = {"behind"}
DO_ACTIONS = {"callout", "highlight", "lock", "reveal", "set_mode", "offer_upgrade"}
CALLOUT_KEYS = {"title", "body", "anchor", "actions"}
HIGHLIGHT_KEYS = {"target"}
LOCK_MODES = {"none", "hand", "place", "booth"}
REVEAL_KEYS = {"ring", "booth", "building", "cone", "builtins"}
SET_MODES = {"hand", "step", "booth:cards", "booth:line", "booth:editor"}
OFFER_KEYS = {"pick_of", "forced"}
THEN_KEYS = {"wait_for", "end"}
WAIT_EXTRA_KEYS = {"timeout_secs", "or_then"}
WAIT_BOOL_KEYS = {
    "placed_any", "booth_staffed", "card_swapped", "line_edited", "cone_placed", "behind", "week_end",
}
WAIT_INT_KEYS = {"sim_secs", "day", "cards_placed"}
WAIT_KEYS = WAIT_BOOL_KEYS | WAIT_INT_KEYS | {"owned", "first_time"}
END_KEYS = {"on", "next", "endless_unlock"}
END_ON_KEYS = {"day", "event", "sim_secs"}
EVENTS = {"first_place", "first_preempt", "booth_staffed", "week_end", "line_edited", "card_swapped"}
EVENT_PREFIXES = {"upgrade_placed": "upgrade", "cards_placed": "count"}
FIRST_TIME_EVENTS = {"pressure_moved", "timeout", "fallback", "backfill_placed"}
TARGET_WORDS = {"road", "lots", "booth", "offers"}
TARGET_PREFIXES = ("bay:", "ring:", "vehicle:", "lot:")
TARGET_SUFFIXED = {"ring", "bay", "vehicle", "lot", "building", "builtin", "cone"}


def builtin_tiers(spec_md: Path = SPEC_MD) -> dict[str, str]:
    """{builtin name: tier} parsed from spec.md §6 — unknown builtins are rejected in data."""
    tiers: dict[str, str] = {}
    try:
        text = spec_md.read_text().split("## 6.", 1)[1].split("\n## ", 1)[0]
    except (OSError, IndexError):
        return tiers
    current = "?"
    for line in text.splitlines():
        head = re.match(r"\s*-\s+\*\*([a-z_]+)\*\*", line)
        if head:
            current = head.group(1)
        for name in re.findall(r"`([A-Za-z_][A-Za-z0-9_]*)\s*\(", line):
            tiers.setdefault(name, current)
    return tiers


# --- helpers ----------------------------------------------------------------------------------


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _path(parts: list[str]) -> str:
    """A JSON-ish locator, e.g. `$.steps[2].when.all[1]`."""
    out = "$"
    for part in parts:
        out += f"[{part}]" if part.isdigit() else f".{part}"
    return out


def _keys(obj: dict, allowed: set[str], where: list[str], errors: list[str]) -> None:
    for key in obj:
        if key not in allowed:
            errors.append(f"{_path(where)}.{key}: unknown key (allowed: {sorted(allowed)})")


def _require(obj: dict, key: str, where: list[str], errors: list[str]):
    if key not in obj:
        errors.append(f"{_path(where)}.{key}: missing")
        return None
    return obj[key]


def _check_upgrade_name(value, where: list[str], errors: list[str]) -> str | None:
    if not isinstance(value, str) or not value:
        errors.append(f"{_path(where)}: upgrade name must be a non-empty string")
        return None
    if value not in upgrade_names():
        errors.append(
            f"{_path(where)}: unknown upgrade {value!r} (allowed: {sorted(upgrade_names())})"
        )
        return None
    return canonical_upgrade(value)


def _check_event(value, where: list[str], errors: list[str], *, key: str = "on_event") -> None:
    """Accept `"event"` or `{"from": "event"}`; `prefix:<arg>` forms per the note."""
    forms: list[object] = [value]
    if isinstance(value, dict):
        _keys(value, {"from"}, where + [key], errors)
        forms = [_require(value, "from", where + [key], errors)]
    for form in forms:
        if not isinstance(form, str) or not form:
            errors.append(f"{_path(where + [key])}: event must be a non-empty string or {{'from': …}}")
            continue
        base, _, arg = form.partition(":")
        if base in EVENTS and not arg:
            continue
        rule = EVENT_PREFIXES.get(base)
        if rule is None:
            errors.append(
                f"{_path(where + [key])}: unknown event {form!r} "
                f"(allowed: {sorted(EVENTS | {f'{p}:…' for p in EVENT_PREFIXES})})"
            )
        elif rule == "upgrade":
            _check_upgrade_name(arg, where + [key], errors)
        elif not arg.isdigit():
            errors.append(f"{_path(where + [key])}: {base} needs an integer count, got {form!r}")


def _check_first_time(value, where: list[str], errors: list[str]) -> None:
    forms: list[object] = [value]
    if isinstance(value, dict):
        _keys(value, {"from"}, where + ["first_time"], errors)
        forms = [_require(value, "from", where + ["first_time"], errors)]
    for form in forms:
        if form not in FIRST_TIME_EVENTS:
            errors.append(
                f"{_path(where + ['first_time'])}: unknown first_time {form!r} "
                f"(allowed: {sorted(FIRST_TIME_EVENTS)})"
            )


def _check_target(value, where: list[str], errors: list[str]) -> None:
    """Anchors/highlight targets: scene words, `prefix:instance`, building names, builtins."""
    if not isinstance(value, str) or not value:
        errors.append(f"{_path(where)}: target must be a non-empty string")
        return
    base, sep, arg = value.partition(":")
    if sep:
        if base not in TARGET_SUFFIXED:
            errors.append(
                f"{_path(where)}: unknown target prefix in {value!r} "
                f"(allowed: {sorted(TARGET_SUFFIXED)} with a non-empty suffix)"
            )
        elif not arg:
            errors.append(f"{_path(where)}: target {value!r} has an empty suffix")
        elif base == "building":
            _check_upgrade_name(arg, where, errors)
        elif base == "builtin" and arg not in builtin_tiers():
            errors.append(f"{_path(where)}: unknown builtin {arg!r} (not in kata spec §6)")
        return
    if value in TARGET_WORDS or value in upgrade_names():
        return
    errors.append(
        f"{_path(where)}: target {value!r} is not in the scene vocabulary "
        f"(words {sorted(TARGET_WORDS)}, prefixes {list(TARGET_PREFIXES)}, or a building name)"
    )


# --- when / do / then -------------------------------------------------------------------------


def _check_clause(clause: dict, where: list[str], errors: list[str], *, conjunct: bool = False) -> None:
    if not isinstance(clause, dict) or not clause:
        errors.append(f"{_path(where)}: clause must be a non-empty object")
        return
    for key, value in clause.items():
        if key in ("after_days", "after_sim_secs"):
            if not _is_int(value) or value < 0:
                errors.append(f"{_path(where + [key])}: needs an int >= 0")
        elif key == "on_event":
            _check_event(value, where, errors)
        elif key == "first_time":
            _check_first_time(value, where, errors)
        elif key in WHEN_ALL_ONLY_FACTS:
            if not conjunct:
                errors.append(
                    f"{_path(where + [key])}: `{key}` is an engine-fact conjunct of `when.all`, "
                    f"not a standalone trigger"
                )
            elif value is not True:
                errors.append(f"{_path(where + [key])}: `{key}` is a boolean engine fact")
        else:
            errors.append(f"{_path(where)}.{key}: unknown `when` clause")


def _check_when(when, where: list[str], errors: list[str]) -> None:
    if not isinstance(when, dict) or not when:
        errors.append(f"{_path(where)}: `when` must be a non-empty object")
        return
    _keys(when, WHEN_KEYS, where, errors)
    if "once" in when and not isinstance(when["once"], bool):
        errors.append(f"{_path(where + ['once'])}: needs a boolean")
    clause_keys = [k for k in when if k != "once"]
    if "all" in when:
        if len(clause_keys) != 1:
            errors.append(f"{_path(where)}: `all` cannot be combined with other `when` keys")
        clauses = when["all"]
        if not isinstance(clauses, list) or len(clauses) < 2:
            errors.append(f"{_path(where + ['all'])}: needs a list of 2+ clauses")
            return
        for i, clause in enumerate(clauses):
            if isinstance(clause, dict) and "all" in clause:
                errors.append(f"{_path(where + ['all', str(i)])}: `all` must not nest")
            _check_clause(
                clause if isinstance(clause, dict) else {}, where + ["all", str(i)], errors,
                conjunct=True,
            )
        return
    if len(clause_keys) != 1:
        errors.append(
            f"{_path(where)}: needs exactly one of after_days/after_sim_secs/on_event/first_time "
            f"(or `all` of 2+), got {sorted(clause_keys)}"
        )
        return
    key = clause_keys[0]
    if key in WHEN_ALL_ONLY_FACTS:
        errors.append(
            f"{_path(where + [key])}: `{key}` is an engine-fact conjunct of `when.all`, "
            f"not a standalone trigger"
        )
    _check_clause({key: when[key]}, where, errors)


def _check_action(action, where: list[str], errors: list[str]) -> None:
    if not isinstance(action, dict) or len(action) != 1:
        errors.append(f"{_path(where)}: action must be an object with exactly one of {sorted(DO_ACTIONS)}")
        return
    (verb, payload), = action.items()
    if verb not in DO_ACTIONS:
        errors.append(f"{_path(where)}.{verb}: unknown action (allowed: {sorted(DO_ACTIONS)})")
        return
    at = where + [verb]
    if verb == "callout":
        if not isinstance(payload, dict):
            errors.append(f"{_path(at)}: must be an object")
            return
        _keys(payload, CALLOUT_KEYS, at, errors)
        for key in ("title", "body"):
            value = _require(payload, key, at, errors)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                errors.append(f"{_path(at + [key])}: needs a non-empty string")
        if "anchor" in payload:
            _check_target(payload["anchor"], at + ["anchor"], errors)
        if "actions" in payload:
            acts = payload["actions"]
            if not isinstance(acts, list) or not acts or not all(
                isinstance(a, str) and a.strip() for a in acts
            ):
                errors.append(f"{_path(at + ['actions'])}: needs a non-empty list of strings")
    elif verb == "highlight":
        if not isinstance(payload, dict):
            errors.append(f"{_path(at)}: must be an object")
            return
        _keys(payload, HIGHLIGHT_KEYS, at, errors)
        target = _require(payload, "target", at, errors)
        if target is not None:
            _check_target(target, at + ["target"], errors)
    elif verb == "lock":
        if payload not in LOCK_MODES:
            errors.append(f"{_path(at)}: lock must be one of {sorted(LOCK_MODES)}")
    elif verb == "reveal":
        if not isinstance(payload, dict) or not payload:
            errors.append(f"{_path(at)}: must be a non-empty object")
            return
        _keys(payload, REVEAL_KEYS, at, errors)
        if "ring" in payload and (not isinstance(payload["ring"], str) or not payload["ring"]):
            errors.append(f"{_path(at + ['ring'])}: needs a non-empty user/ring name")
        if "booth" in payload and not isinstance(payload["booth"], bool):
            errors.append(f"{_path(at + ['booth'])}: needs a boolean")
        if "cone" in payload and payload["cone"] is not True:
            errors.append(f"{_path(at + ['cone'])}: cone reveal is a boolean flag")
        if "building" in payload:
            _check_upgrade_name(payload["building"], at + ["building"], errors)
        for i, name in enumerate(payload.get("builtins") or []):
            if name not in builtin_tiers():
                errors.append(f"{_path(at + ['builtins', str(i)])}: unknown builtin {name!r}")
    elif verb == "set_mode":
        if payload not in SET_MODES:
            errors.append(f"{_path(at)}: mode must be one of {sorted(SET_MODES)}")
    elif verb == "offer_upgrade":
        if not isinstance(payload, dict):
            errors.append(f"{_path(at)}: must be an object")
            return
        _keys(payload, OFFER_KEYS, at, errors)
        if len(payload) != 1 or not set(payload) <= OFFER_KEYS:
            errors.append(f"{_path(at)}: needs exactly one of `pick_of` / `forced`")
        elif "pick_of" in payload:
            pick = payload["pick_of"]
            if not _is_int(pick) or pick < 1 or pick > len(upgrade_names()):
                errors.append(f"{_path(at + ['pick_of'])}: int 1..{len(upgrade_names())} required")
        else:
            _check_upgrade_name(payload["forced"], at + ["forced"], errors)


def _check_do(actions, where: list[str], errors: list[str]) -> None:
    if not isinstance(actions, list) or not actions:
        errors.append(f"{_path(where)}: `do` must be a non-empty list of actions")
        return
    for i, action in enumerate(actions):
        _check_action(action, where + [str(i)], errors)


def _check_then(items, where: list[str], errors: list[str]) -> None:
    if not isinstance(items, list) or not items:
        errors.append(f"{_path(where)}: `then` must be a non-empty list")
        return
    for i, item in enumerate(items):
        at = where + [str(i)]
        if not isinstance(item, dict) or len(item) != 1:
            errors.append(f"{_path(at)}: then-item must be `{{'wait_for': …}}` or `{{'end': true}}`")
            continue
        (key, payload), = item.items()
        if key not in THEN_KEYS:
            errors.append(f"{_path(at)}.{key}: unknown then-item (allowed: {sorted(THEN_KEYS)})")
        elif key == "end":
            if payload is not True:
                errors.append(f"{_path(at + ['end'])}: must be `true`")
            if len(items) != 1:
                errors.append(f"{_path(at)}: `end` must be the only then-item of its step")
            continue
        if not isinstance(payload, dict) or not payload:
            errors.append(f"{_path(at + ['wait_for'])}: must be a non-empty object")
            continue
        _keys(payload, WAIT_KEYS | WAIT_EXTRA_KEYS, at + ["wait_for"], errors)
        primary = [k for k in payload if k not in WAIT_EXTRA_KEYS]
        if len(primary) != 1:
            errors.append(
                f"{_path(at + ['wait_for'])}: needs exactly one predicate, got {sorted(primary)}"
            )
        else:
            name = primary[0]
            value = payload[name]
            if name in WAIT_BOOL_KEYS and not isinstance(value, bool):
                errors.append(f"{_path(at + ['wait_for', name])}: needs a boolean")
            elif name in WAIT_INT_KEYS and (not _is_int(value) or value < 0):
                errors.append(f"{_path(at + ['wait_for', name])}: needs an int >= 0")
            elif name == "owned":
                _check_upgrade_name(value, at + ["wait_for", name], errors)
            elif name == "first_time":
                _check_first_time(value, at + ["wait_for"], errors)
        if "timeout_secs" in payload and (not _is_int(payload["timeout_secs"])
                                         or payload["timeout_secs"] < 0):
            errors.append(f"{_path(at + ['wait_for', 'timeout_secs'])}: needs an int >= 0")
        if "or_then" in payload and not isinstance(payload["or_then"], bool):
            errors.append(f"{_path(at + ['wait_for', 'or_then'])}: needs a boolean")


# --- whole file --------------------------------------------------------------------------------


def check_file(path: Path) -> list[str]:
    """Every schema violation in one tutorial file (empty list == clean)."""
    errors: list[str] = []
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot read/parse: {exc}"]
    if not isinstance(data, dict):
        return ["top level must be a JSON object"]

    _keys(data, TOP_KEYS, [], errors)
    if data.get("version") != SCHEMA_VERSION:
        errors.append(f"$.version: must be {SCHEMA_VERSION}, got {data.get('version')!r}")
    if not _is_int(data.get("city")):
        errors.append("$.city: must be an int")
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("$.title: must be a non-empty string")

    level_ref = _require(data, "level", [], errors)
    level_doc: dict = {}
    if isinstance(level_ref, str) and level_ref:
        level_path = LEVELS_DIR / f"{level_ref}.json"
        if not level_path.exists():
            errors.append(f"$.level: no levels/{level_ref}.json")
        else:
            try:
                level_doc = json.loads(level_path.read_text())
            except (OSError, json.JSONDecodeError) as exc:
                errors.append(f"$.level: levels/{level_ref}.json unreadable: {exc}")
            if isinstance(level_doc, dict) and level_doc.get("id") not in (None, level_ref):
                errors.append(f"$.level: levels/{level_ref}.json declares id {level_doc.get('id')!r}")
    elif level_ref is not None:
        errors.append("$.level: must be a non-empty string")

    steps = _require(data, "steps", [], errors)
    if not isinstance(steps, list) or not steps:
        errors.append("$.steps: must be a non-empty list")
        steps = []
    seen_ids: set[str] = set()
    for i, step in enumerate(steps):
        at = ["steps", str(i)]
        if not isinstance(step, dict):
            errors.append(f"{_path(at)}: step must be an object")
            continue
        _keys(step, STEP_KEYS, at, errors)
        sid = _require(step, "id", at, errors)
        if isinstance(sid, str) and sid:
            if sid in seen_ids:
                errors.append(f"{_path(at + ['id'])}: duplicate step id {sid!r}")
            seen_ids.add(sid)
        elif sid is not None:
            errors.append(f"{_path(at + ['id'])}: must be a non-empty string")
        _check_when(step.get("when"), at + ["when"], errors)
        _check_do(step.get("do"), at + ["do"], errors)
        _check_then(step.get("then"), at + ["then"], errors)
        if i != len(steps) - 1 and _ends(step):
            errors.append(f"{_path(at + ['then'])}: `end` may only appear in the final step")

    end = _require(data, "end", [], errors)
    if isinstance(end, dict):
        _keys(end, END_KEYS, ["end"], errors)
        on = end.get("on")
        if isinstance(on, dict):
            _keys(on, END_ON_KEYS, ["end", "on"], errors)
            if "event" in on and on["event"] not in EVENTS:
                errors.append(f"$.end.on.event: unknown event {on['event']!r}")
            if "day" in on and not _is_int(on["day"]):
                errors.append("$.end.on.day: needs an int")
        elif on is not None:
            errors.append("$.end.on: must be an object")
        if "next" in end and (not _is_int(end["next"]) or end["next"] < 1):
            errors.append("$.end.next: needs an int >= 1")
        if "endless_unlock" in end and not isinstance(end["endless_unlock"], bool):
            errors.append("$.end.endless_unlock: needs a boolean")
    elif end is not None:
        errors.append("$.end: must be an object")

    _check_level_patch(data.get("level_patch"), level_doc, errors)
    return errors


def _ends(step: dict) -> bool:
    return any(isinstance(t, dict) and "end" in t for t in step.get("then") or [])


def _check_level_patch(patch, level_doc: dict, errors: list[str]) -> None:
    if patch is None:
        return
    if not isinstance(patch, dict) or not patch:
        errors.append("$.level_patch: must be a non-empty object")
        return
    _keys(patch, PATCH_KEYS, ["level_patch"], errors)
    if "story" in patch and (not isinstance(patch["story"], str) or not patch["story"].strip()):
        errors.append("$.level_patch.story: needs a non-empty string")
    if "duration" in patch and (not isinstance(patch["duration"], (int, float))
                               or isinstance(patch["duration"], bool) or patch["duration"] <= 0):
        errors.append("$.level_patch.duration: needs a positive number")
    if "pressure" in patch:
        pr = patch["pressure"]
        if (not isinstance(pr, dict) or not isinstance(pr.get("cap", 2), int) or pr.get("cap", 2) < 2
                or not isinstance(pr.get("end_on_overflow", False), bool)):
            errors.append('$.level_patch.pressure: must be {"cap": int >= 2, "end_on_overflow": bool}')
        elif isinstance(level_doc, dict) and level_doc.get("pressure") is not None:
            errors.append("$.level_patch.pressure: cannot replace a level's own pressure block")
    if "generator" not in patch:
        return
    gen = patch["generator"]
    if not isinstance(gen, dict) or not gen:
        errors.append("$.level_patch.generator: must be a non-empty object")
        return
    level_gen = level_doc.get("generator") if isinstance(level_doc, dict) else None
    if isinstance(level_gen, dict):
        for key in gen:
            if key not in level_gen:
                errors.append(
                    f"$.level_patch.generator.{key}: not a knob of the referenced level "
                    f"(allowed: {sorted(level_gen)})"
                )
    else:
        errors.append("$.level_patch.generator: referenced level has no generator to patch")
        return
    if "users" in gen:
        users = gen["users"]
        if not isinstance(users, list) or not users:
            errors.append("$.level_patch.generator.users: must be a non-empty list")
            return
        for i, user in enumerate(users):
            at = ["level_patch", "generator", "users", str(i)]
            if not isinstance(user, dict):
                errors.append(f"{_path(at)}: user must be an object")
                continue
            name = user.get("name")
            if not isinstance(name, str) or not name.strip():
                errors.append(f"{_path(at)}.name: must be a non-empty string")


# --- cross-file --------------------------------------------------------------------------------


def _upgrade_refs(data: dict, introduced: bool) -> set[str]:
    """Upgrade names referenced by a file; `introduced=True` counts only offers/building reveals."""
    # Introduction = an offer or a building reveal; a plain reference is `owned`/`upgrade_placed`.
    # A name only ever *referenced* records its own city as its first appearance (later cities may
    # reuse it) — so the error case is a reference in a city before any introduction.
    names: set[str] = set()
    for step in data.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for action in step.get("do") or []:
            if not isinstance(action, dict):
                continue
            if "offer_upgrade" in action and isinstance(action["offer_upgrade"], dict):
                forced = action["offer_upgrade"].get("forced")
                if isinstance(forced, str):
                    names.add(canonical_upgrade(forced))
            if introduced and isinstance(action.get("reveal"), dict):
                building = action["reveal"].get("building")
                if isinstance(building, str):
                    names.add(canonical_upgrade(building))
        when = step.get("when")
        for clause in _clauses(when):
            event = clause.get("on_event")
            event = event.get("from") if isinstance(event, dict) else event
            if isinstance(event, str) and event.startswith("upgrade_placed:"):
                names.add(canonical_upgrade(event.split(":", 1)[1]))
        for item in step.get("then") or []:
            if isinstance(item, dict) and isinstance(item.get("wait_for"), dict):
                owned = item["wait_for"].get("owned")
                if isinstance(owned, str) and not introduced:
                    names.add(canonical_upgrade(owned))
    return names


def _clauses(when) -> list[dict]:
    if not isinstance(when, dict):
        return []
    if isinstance(when.get("all"), list):
        return [c for c in when["all"] if isinstance(c, dict)]
    return [{k: v for k, v in when.items() if k in {"on_event"}}]


def check_city_order(files: list[Path]) -> list[str]:
    """City order never introduces an upgrade after another city has already referenced it."""
    errors: list[str] = []
    docs: list[tuple[int, dict, Path]] = []
    for path in files:
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and _is_int(data.get("city")):
            docs.append((data["city"], data, path))
    introduce: dict[str, tuple[int, Path]] = {}
    for city, data, path in docs:
        for name in _upgrade_refs(data, introduced=True):
            if name not in introduce or city < introduce[name][0]:
                introduce[name] = (city, path)
    for city, data, path in docs:
        for name in _upgrade_refs(data, introduced=False):
            first = introduce.get(name)
            if first and city < first[0]:
                errors.append(
                    f"city {city} references upgrade {name!r} before it is offered in city "
                    f"{first[0]} ({first[1].name})"
                )
    return errors


def check_files(files: list[Path]) -> dict[str, list[str]]:
    """{file label: [violation, …]} for the given tutorial files (cross-city checks included)."""
    report: dict[str, list[str]] = {}
    for path in files:
        report[path.name] = check_file(path)
    cities = {}
    for path in files:
        try:
            city = json.loads(path.read_text()).get("city")
        except (OSError, json.JSONDecodeError):
            continue
        if _is_int(city):
            cities.setdefault(city, []).append(path.name)
    for city, names in sorted(cities.items()):
        if len(names) > 1:
            label = ", ".join(sorted(names))
            report.setdefault("_cross-city", []).append(
                f"city {city} is claimed by more than one file ({label})"
            )
    for message in check_city_order(files):
        report.setdefault("_cross-city", []).append(message)
    return {k: v for k, v in report.items() if v}


def default_files(tutorials_dir: Path = TUTORIALS_DIR) -> list[Path]:
    return sorted(tutorials_dir.glob("city*.json"))


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    files = [Path(a) for a in argv] if argv else default_files()
    if not files:
        print("no tutorial files found", file=sys.stderr)
        return 1
    report = check_files(files)
    bad = sum(len(v) for v in report.values())
    for label in sorted(report):
        for message in report[label]:
            where = label if not label.startswith("_") else ""
            print(f"{where + ': ' if where else ''}{message}")
    if bad:
        print(f"FAIL: {bad} violation(s) in {len(files)} tutorial file(s)", file=sys.stderr)
        return 1
    print(f"OK: {len(files)} tutorial file(s) valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
