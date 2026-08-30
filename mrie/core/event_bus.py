"""Proactive event bus — lets capabilities push notable findings outside the
scheduled briefing loop, and lets IPC clients subscribe to them.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

MAX_SUBSCRIBER_QUEUE = 100
MAX_HISTORY = 200


@dataclass(frozen=True, slots=True)
class NotableEvent:
    """A single proactive notification, provenance-tagged to its source capability."""

    event_id: str
    source: str
    severity: str
    title: str
    detail: str
    created_at: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source": self.source,
            "severity": self.severity,
            "title": self.title,
            "detail": self.detail,
            "created_at": self.created_at,
            "data": self.data,
        }

    @classmethod
    def now(
        cls,
        *,
        source: str,
        source_event_id: str,
        severity: str,
        title: str,
        detail: str,
        data: dict[str, Any] | None = None,
    ) -> NotableEvent:
        stable_id = hashlib.sha256(f"{source}\0{source_event_id}".encode()).hexdigest()
        return cls(
            event_id=stable_id,
            source=source,
            severity=severity,
            title=title,
            detail=detail,
            created_at=datetime.now(UTC).isoformat(),
            data=data or {},
        )


class EventBus:
    """Bounded in-process pub/sub for proactive events.

    Subscribers each get their own bounded queue so one slow consumer cannot
    block publishers or other subscribers; oldest-first drop under pressure.
    """

    def __init__(self, max_history: int = MAX_HISTORY) -> None:
        self._subscribers: list[asyncio.Queue[NotableEvent]] = []
        self._history: list[NotableEvent] = []
        self._max_history = max_history
        self._seen_ids: set[str] = set()

    def subscribe(self) -> asyncio.Queue[NotableEvent]:
        queue: asyncio.Queue[NotableEvent] = asyncio.Queue(maxsize=MAX_SUBSCRIBER_QUEUE)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[NotableEvent]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    async def publish(self, event: NotableEvent) -> bool:
        """Publish an event. Returns False if it was a duplicate (already seen)."""
        if event.event_id in self._seen_ids:
            return False
        self._seen_ids.add(event.event_id)

        self._history.append(event)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history :]

        for queue in list(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                logger.warning("Event subscriber queue full; dropped oldest event")
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("Event subscriber queue still full after drop; skipping")
        return True

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        bounded = max(1, min(int(limit), self._max_history))
        return [event.to_dict() for event in self._history[-bounded:]]
