"""Share cards — self-describing, replayable, serverless (§4.6 / Stage 9).

A card is a compact ``#c=`` payload that carries everything needed to *replay* the run in the browser:
the level identity (or an inline sandbox cluster), the seed, the policy or the full kata source, and
the **result hash** the replay must match. No server: the payload is base64url of a canonical JSON
object with a version tag. Decoding is forgiving (it never runs arbitrary code); `verify` re-runs the
engine and compares the trajectory hash, so a card cannot lie about its score.

Canonicalization reuses the same canonicalizer the formatter/trajectory use, so two players' identical
katas produce byte-identical card payloads (share links are stable).
"""

from __future__ import annotations

import base64
import json
from typing import Any

from scheduler_dojo.sim import scoring
from scheduler_dojo.sim.level import run_level
from scheduler_dojo.sim.trajectory import trajectory_hash

CARD_VERSION = 1


def _b64url_encode(obj: dict) -> str:
    blob = json.dumps(obj, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(blob).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> dict:
    pad = "=" * (-len(s) % 4)
    return json.loads(base64.urlsafe_b64decode(s + pad))


def encode_card(*, level: dict | None = None, level_id: str | None = None, seed: int,
                policy: str = "fifo", kata: str | None = None,
                result: Any | None = None) -> str:
    """Build a share-card payload. Provide either `level` (inline/sandbox) or a `level_id` reference.

    Pass the `result` (a RunResult) to embed its `trajectory_hash` for verification; if omitted, the
    run is executed here to compute it.
    """
    if level is None and level_id is None:
        raise ValueError("encode_card needs a level or a level_id")
    if result is None:
        if level is None:
            raise ValueError("cannot compute a hash for a level_id-only card without the level")
        result = run_level(level, seed=seed, policy=policy, kata=kata)
    card: dict[str, Any] = {"v": CARD_VERSION, "seed": seed}
    if level is not None:
        card["level"] = {"id": level.get("id"), "cluster": level["cluster"],
                         "generator": level["generator"], "duration": level.get("duration"),
                         "unlocks": level.get("unlocks"), "sensors": level.get("sensors"),
                         "score_weights": level.get("score_weights"),
                         "score_anchors": level.get("score_anchors")}
    else:
        card["level_id"] = level_id
    if kata is not None:
        card["kata"] = kata
    else:
        card["policy"] = policy
    card["hash"] = trajectory_hash(result)
    return "#c=" + _b64url_encode(card)


def decode_card(payload: str) -> dict:
    """Decode a ``#c=`` payload (or a bare base64 body). Raises ValueError on malformed input."""
    body = payload[len("#c="):] if payload.startswith("#c=") else payload.lstrip("#")
    try:
        card = _b64url_decode(body)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"malformed share card: {exc}") from exc
    if not isinstance(card, dict) or card.get("v") != CARD_VERSION or "seed" not in card:
        raise ValueError(f"unsupported share-card version {card.get('v') if isinstance(card, dict) else '?'}")
    return card


def replay_card(card_or_payload: str | dict, *, level: dict | None = None) -> dict:
    """Replay a card and check its hash.

    Inline cards carry their own level; a ``level_id`` card needs the `level` passed in (the browser
    looks it up from the shipped set). Returns ``{"ok", "score"?, "metrics", "trajectory_hash",
    "expected_hash"}``.
    """
    card = decode_card(card_or_payload) if isinstance(card_or_payload, str) else card_or_payload
    lvl = level or card.get("level")
    if lvl is None:
        raise ValueError("level_id card requires the level to be supplied for replay")
    lvl = {**lvl, "seed": card["seed"]}
    result = run_level(lvl, seed=card["seed"], policy=card.get("policy", "fifo"),
                       kata=card.get("kata"), validate=False)
    got = trajectory_hash(result)
    expected = card.get("hash")
    out = {"ok": expected is None or got == expected, "metrics": scoring.metrics_from_run(result),
           "trajectory_hash": got, "expected_hash": expected}
    if lvl.get("score_weights") and lvl.get("score_anchors"):
        out["score"] = scoring.score(out["metrics"], lvl["score_weights"], lvl["score_anchors"])
    return out
