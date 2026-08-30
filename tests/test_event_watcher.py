from __future__ import annotations

from typing import Any

import pytest

from mrie.core.capability_base import CapabilityResult
from mrie.core.event_bus import EventBus
from mrie.scheduler.event_watcher import EventWatcher


class FakeCapability:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        self.calls.append((method, kwargs))
        return CapabilityResult(success=True, data={"events": self.events})


class FakeRegistry:
    def __init__(
        self,
        wazuh_events: list[dict[str, Any]],
        honeypot_events: list[dict[str, Any]],
    ) -> None:
        self.capabilities = {
            "wazuh": FakeCapability(wazuh_events),
            "honeypot": FakeCapability(honeypot_events),
        }

    def get(self, name: str) -> FakeCapability | None:
        return self.capabilities.get(name)


class FakeOrchestrator:
    def __init__(
        self,
        wazuh_events: list[dict[str, Any]],
        honeypot_events: list[dict[str, Any]],
    ) -> None:
        self.registry = FakeRegistry(wazuh_events, honeypot_events)
        self.event_bus = EventBus()


@pytest.mark.asyncio
async def test_poll_once_publishes_new_events() -> None:
    orchestrator = FakeOrchestrator(
        wazuh_events=[{"event_id": "w1", "title": "Alert", "category": "intrusion"}],
        honeypot_events=[{"event_id": "h1", "title": "Probe", "category": "honeypot"}],
    )
    watcher = EventWatcher({}, orchestrator)  # type: ignore[arg-type]

    published = await watcher.poll_once()

    assert published == 2
    assert len(orchestrator.event_bus.recent(limit=10)) == 2


@pytest.mark.asyncio
async def test_poll_once_is_idempotent_on_repeat() -> None:
    orchestrator = FakeOrchestrator(
        wazuh_events=[{"event_id": "w1", "title": "Alert", "category": "intrusion"}],
        honeypot_events=[],
    )
    watcher = EventWatcher({}, orchestrator)  # type: ignore[arg-type]

    first = await watcher.poll_once()
    second = await watcher.poll_once()

    assert first == 1
    assert second == 0
    assert len(orchestrator.event_bus.recent(limit=10)) == 1


@pytest.mark.asyncio
async def test_poll_once_survives_missing_capability() -> None:
    orchestrator = FakeOrchestrator(wazuh_events=[], honeypot_events=[])
    orchestrator.registry.capabilities.pop("honeypot")
    watcher = EventWatcher({}, orchestrator)  # type: ignore[arg-type]

    published = await watcher.poll_once()

    assert published == 0
