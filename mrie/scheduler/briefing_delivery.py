"""Durable asynchronous delivery worker for archived briefings."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mrie.core.orchestrator import MRIEOrchestrator
    from mrie.scheduler.briefing_store import BriefingStore

logger = logging.getLogger(__name__)


class BriefingDeliveryWorker:
    """Drain one durable speech job at a time without blocking report creation."""

    def __init__(
        self,
        store: BriefingStore,
        orchestrator: MRIEOrchestrator,
        *,
        idle_poll_seconds: float = 5,
    ) -> None:
        self.store = store
        self.orchestrator = orchestrator
        self.idle_poll_seconds = max(0.1, min(float(idle_poll_seconds), 60.0))
        self._task: asyncio.Task[None] | None = None
        self._wake_event = asyncio.Event()
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        recovery = self.store.recover_delivery_jobs()
        if recovery["recovered"] or recovery["interrupted"]:
            logger.warning(
                "Briefing delivery recovery: recovered=%d interrupted=%d",
                recovery["recovered"],
                recovery["interrupted"],
            )
        self._task = asyncio.create_task(self._run(), name="briefing-delivery")
        self.wake()

    def wake(self) -> None:
        if self._running:
            self._wake_event.set()

    async def stop(self) -> None:
        self._running = False
        self._wake_event.set()
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.to_thread(
            self.store.interrupt_running_deliveries,
            "delivery_cancelled_unknown",
        )

    async def drain_once(self) -> bool:
        """Deliver at most one job; return whether work was claimed."""
        job = await asyncio.to_thread(self.store.claim_next_delivery)
        if job is None:
            return False

        briefing_id = str(job["briefing_id"])
        try:
            outcome = await self._deliver(str(job["summary"]))
            await asyncio.to_thread(
                self.store.complete_delivery_job,
                briefing_id,
                outcome,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - terminalize claimed work
            logger.exception("Briefing delivery job failed")
            await asyncio.to_thread(
                self.store.complete_delivery_job,
                briefing_id,
                {
                    "status": "delivery_failed",
                    "reason": f"delivery worker failed ({type(exc).__name__})",
                },
            )
        return True

    async def _deliver(self, summary: str) -> dict[str, Any]:
        voice_cap = self.orchestrator.registry.get("voice")
        if voice_cap is None:
            return {
                "status": "unavailable",
                "reason": "voice_capability_unavailable",
            }
        try:
            result = await voice_cap.invoke("speak", text=summary, trigger="briefing")
            return result.to_dict()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - worker survives capability failures
            logger.exception("Briefing speech delivery failed")
            return {
                "status": "delivery_failed",
                "reason": f"voice.speak failed ({type(exc).__name__})",
            }

    async def _run(self) -> None:
        try:
            while self._running:
                claimed = await self.drain_once()
                if claimed:
                    continue
                self._wake_event.clear()
                try:
                    await asyncio.wait_for(
                        self._wake_event.wait(),
                        timeout=self.idle_poll_seconds,
                    )
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 - never take down scheduler/service
            logger.exception("Briefing delivery worker stopped unexpectedly")
            self._running = False
