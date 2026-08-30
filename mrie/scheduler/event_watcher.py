"""Event watcher — polls fast-moving sources on a short interval and publishes
proactive notifications, independent of the 8-hour briefing loop.

This stays poll-based against the same documented, read-only capability
methods the briefing scheduler uses (Wazuh indexer/manager APIs, the local
honeypot evidence store). No webhook ingestion is wired up yet; that remains
a later, explicitly-approved phase per docs/MASTER_SPEC.md.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from mrie.core.event_bus import NotableEvent

if TYPE_CHECKING:
    from mrie.core.orchestrator import MRIEOrchestrator

logger = logging.getLogger(__name__)

DEFAULT_POLL_SECONDS = 60
DEFAULT_URGENT_SEVERITY = 3  # matches security.models.Severity.HIGH


class EventWatcher:
    """Polls security-relevant capabilities and publishes NotableEvents for
    anything at or above the urgent threshold, deduplicated by the bus.
    """

    def __init__(
        self,
        config: dict[str, Any],
        orchestrator: MRIEOrchestrator,
    ) -> None:
        self.orchestrator = orchestrator
        self.poll_seconds = int(config.get("poll_seconds", DEFAULT_POLL_SECONDS))
        self.urgent_severity = int(config.get("urgent_severity", DEFAULT_URGENT_SEVERITY))
        self._task: asyncio.Task[None] | None = None
        self._running = False

    def get_status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "poll_seconds": self.poll_seconds,
            "urgent_severity": self.urgent_severity,
        }

    async def poll_once(self) -> int:
        """Run a single poll cycle. Returns the number of events published."""
        published = 0
        published += await self._poll_wazuh()
        published += await self._poll_honeypot()
        return published

    async def _poll_wazuh(self) -> int:
        capability = self.orchestrator.registry.get("wazuh")
        if capability is None:
            return 0
        try:
            result = await capability.invoke(
                "recent_events", limit=50, minimum_severity=self.urgent_severity
            )
        except Exception:  # noqa: BLE001 - one source outage must not stop the watcher
            logger.exception("Event watcher: wazuh poll failed")
            return 0
        if not result.success:
            return 0
        events = (result.data or {}).get("events", [])
        return await self._publish_security_events("wazuh", events)

    async def _poll_honeypot(self) -> int:
        capability = self.orchestrator.registry.get("honeypot")
        if capability is None:
            return 0
        try:
            result = await capability.invoke("recent_observations", limit=50)
        except Exception:  # noqa: BLE001 - one source outage must not stop the watcher
            logger.exception("Event watcher: honeypot poll failed")
            return 0
        if not result.success:
            return 0
        events = (result.data or {}).get("events", [])
        return await self._publish_security_events("honeypot", events)

    async def _publish_security_events(self, source: str, events: list[dict[str, Any]]) -> int:
        published = 0
        for event in events:
            source_event_id = str(event.get("event_id") or event.get("source_event_id") or "")
            if not source_event_id:
                continue
            notable = NotableEvent.now(
                source=source,
                source_event_id=source_event_id,
                severity="urgent" if source == "wazuh" else "warning",
                title=str(event.get("title", f"{source} event")),
                detail=str(event.get("category", "")),
                data=event,
            )
            if await self.orchestrator.event_bus.publish(notable):
                published += 1
        return published

    async def _watch_loop(self) -> None:
        while self._running:
            try:
                await self.poll_once()
            except Exception:  # noqa: BLE001 - watcher must survive source outages
                logger.exception("Event watcher poll cycle failed")
            await asyncio.sleep(self.poll_seconds)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._watch_loop())
        logger.info("Event watcher started (poll_seconds=%s)", self.poll_seconds)

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("Event watcher stopped")
