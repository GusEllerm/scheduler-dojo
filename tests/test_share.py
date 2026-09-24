"""Share cards: round-trip, tamper-evidence (hash), level_id lookup, canonical (stable) payloads."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scheduler_dojo.share import decode_card, encode_card, replay_card
from scheduler_dojo.sim.level import load_level_file, run_level

ROOT = Path(__file__).resolve().parent.parent
LEVEL2 = load_level_file(ROOT / "levels" / "level2.json")
REF = (ROOT / "levels" / "reference_katas" / "shortest_first.kata").read_text()


def test_encode_decode_round_trip():
    card = encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF)
    assert card.startswith("#c=")
    decoded = decode_card(card)
    assert decoded["seed"] == LEVEL2["seed"]
    assert decoded["kata"] == REF
    assert "hash" in decoded


def test_replay_matches_and_reports_score():
    card = encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF)
    out = replay_card(card)
    assert out["ok"] is True
    assert out["score"] == 800  # the reference scores 800 on level2's calibration


def test_tamper_detected():
    card = decode_card(encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF))
    card["seed"] = card["seed"] + 1
    assert replay_card(card)["ok"] is False
    card2 = decode_card(encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF))
    card2["kata"] = "order by bad:\n    key = job.submit_time\n"
    assert replay_card(card2)["ok"] is False


def test_level_id_card_needs_level():
    res = run_level(LEVEL2, seed=LEVEL2["seed"], policy="shortest_first")
    card = encode_card(level_id="level2", seed=LEVEL2["seed"], policy="shortest_first", result=res)
    assert replay_card(card, level=LEVEL2)["ok"] is True
    with pytest.raises(ValueError):
        replay_card(card)


def test_payload_is_canonical_stable():
    a = encode_card(level=LEVEL2, seed=3, kata=REF)
    b = encode_card(level=LEVEL2, seed=3, kata=REF)
    assert a == b


def test_malformed_card_raises():
    with pytest.raises(ValueError):
        decode_card("#c=!!!not base64!!!")
    with pytest.raises(ValueError):
        decode_card("#c=" + "e30")  # {} -> wrong version


def test_encode_requires_level_or_id():
    with pytest.raises(ValueError):
        encode_card(seed=0)


def test_verify_card_cli_inline(tmp_path, capsys):
    from scheduler_dojo import cli

    payload = encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF)
    assert cli.main(["verify-card", payload]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_verify_card_cli_level_id_lookup(tmp_path, monkeypatch, capsys):
    from scheduler_dojo import cli

    monkeypatch.chdir(ROOT)  # so the default levels dir resolves
    res = run_level(LEVEL2, seed=LEVEL2["seed"], kata=REF)
    payload = encode_card(level_id="level2", seed=LEVEL2["seed"], kata=REF, result=res)
    assert cli.main(["verify-card", payload]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_verify_card_cli_detects_tamper(tmp_path, capsys):
    from scheduler_dojo import cli
    from scheduler_dojo.share.card import _b64url_encode

    res = run_level(LEVEL2, seed=LEVEL2["seed"], kata=REF)
    payload = encode_card(level=LEVEL2, seed=LEVEL2["seed"], kata=REF, result=res)
    card = decode_card(payload)
    card["kata"] = "order by t:\n  key = job.submit_time\n"  # different policy, same embedded hash
    tampered = "#c=" + _b64url_encode(card)
    assert cli.main(["verify-card", tampered]) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False


def test_card_json_body_is_ordered_keys_compact():
    card = decode_card(encode_card(level=LEVEL2, seed=1, policy="fifo"))
    assert card["policy"] == "fifo" and "kata" not in card
    json.dumps(card)  # decodes to plain JSON types
