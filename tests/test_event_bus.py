from __future__ import annotations

import asyncio

import pytest

from mrie.core.event_bus import EventBus, NotableEvent


def make_event(source_event_id: str = "abc") -> NotableEvent:
    return NotableEvent.now(
        source="wazuh",
        source_event_id=source_event_id,
        severity="urgent",
        title="Test event",
        detail="detail",
    )


@pytest.mark.asyncio
async def test_duplicate_events_are_not_republished() -> None:
    bus = EventBus()
    event = make_event()

    assert await bus.publish(event) is True
    assert await bus.publish(event) is False
    assert len(bus.recent(limit=10)) == 1


@pytest.mark.asyncio
async def test_subscribers_receive_published_events() -> None:
    bus = EventBus()
    queue = bus.subscribe()

    await bus.publish(make_event("one"))
    received = await asyncio.wait_for(queue.get(), timeout=1)

    assert received.event_id == make_event("one").event_id


@pytest.mark.asyncio
async def test_unsubscribe_stops_delivery() -> None:
    bus = EventBus()
    queue = bus.subscribe()
    bus.unsubscribe(queue)

    await bus.publish(make_event("two"))

    assert queue.empty()


@pytest.mark.asyncio
async def test_recent_history_is_bounded_to_most_recent() -> None:
    bus = EventBus(max_history=3)
    for i in range(5):
        await bus.publish(make_event(str(i)))

    history = bus.recent(limit=10)
    expected_ids = [make_event(str(i)).event_id for i in (2, 3, 4)]
    assert [item["event_id"] for item in history] == expected_ids
