"""A deterministic discrete-event queue.

Ordering is total and runtime-independent: by integer time, then event kind (so all
finishes free resources before arrivals enqueue, before preemptions, ticks, drifts),
then a stable per-event key (usually the job id), then insertion sequence. Never depends
on set/dict iteration — see the Determinism concept note.
"""

from __future__ import annotations

import enum
import heapq
from dataclasses import dataclass, field


class EventKind(enum.IntEnum):
    """IntEnum so the value is the tie-break precedence directly.

    Finishes first (free capacity), then arrivals (new demand), then preempts, then
    periodic ticks, then arrival-mix drifts.
    """

    FINISH = 0
    ARRIVE = 1
    PREEMPT = 2
    TICK = 3
    DRIFT = 4


@dataclass(order=True)
class Event:
    sort_key: tuple
    time: int = field(compare=False)
    kind: EventKind = field(compare=False)
    key: str = field(compare=False, default="")
    payload: object = field(compare=False, default=None)

    def __post_init__(self) -> None:
        # sort_key is derived: (time, kind, key, seq). seq is filled by EventQueue.add.
        object.__setattr__(self, "_seq", 0)


class EventQueue:
    """Min-heap of events with the total order above."""

    def __init__(self) -> None:
        self._heap: list[Event] = []
        self._seq = 0

    def __len__(self) -> int:
        return len(self._heap)

    def add(self, time: int, kind: EventKind, key: str = "", payload: object = None) -> None:
        self._seq += 1
        ev = Event(sort_key=(time, int(kind), key, self._seq),
                   time=time, kind=kind, key=key, payload=payload)
        object.__setattr__(ev, "_seq", self._seq)
        heapq.heappush(self._heap, ev)

    def peek_time(self) -> int | None:
        return self._heap[0].time if self._heap else None

    def pop_batch(self) -> list[Event]:
        """Pop every event at the earliest time, in the total order. Callers run one
        decision point after handling the whole batch."""
        if not self._heap:
            return []
        t = self._heap[0].time
        batch: list[Event] = []
        while self._heap and self._heap[0].time == t:
            batch.append(heapq.heappop(self._heap))
        return batch
