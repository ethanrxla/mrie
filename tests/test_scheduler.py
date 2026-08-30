from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from mrie.core.capability_base import CapabilityResult
from mrie.scheduler.briefing_scheduler import BriefingScheduler


class FakeCapability:
    def __init__(self, data: Any = None) -> None:
        self.data = data or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        self.calls.append((method, kwargs))
        return CapabilityResult(success=True, data=self.data)


class RaisingVoiceCapability:
    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        raise RuntimeError("speaker disconnected")


class FakeRegistry:
    def __init__(self) -> None:
        self.capabilities = {
            "news": FakeCapability({"headlines": []}),
            "social": FakeCapability({"videos": []}),
            "instagram": FakeCapability({"posts": []}),
            "reddit": FakeCapability({"posts": []}),
            "wazuh": FakeCapability({"events": []}),
            "honeypot": FakeCapability({"events": []}),
            "speech_log": FakeCapability({"entries": []}),
            "voice": FakeCapability(),
        }

    def get(self, name: str) -> FakeCapability | None:
        return self.capabilities.get(name)


class FailingAgent:
    async def ask(self, prompt: str, session_id: str) -> str:
        raise RuntimeError("model offline")


class SuccessfulAgent:
    async def ask(self, prompt: str, session_id: str) -> str:
        return "Verified briefing"


class FakeOrchestrator:
    def __init__(self, agent: Any = None) -> None:
        self.registry = FakeRegistry()
        self.agent = agent or FailingAgent()


@pytest.mark.asyncio
async def test_briefing_degrades_when_model_is_offline(tmp_path: Path) -> None:
    scheduler = BriefingScheduler(
        {
            "timezone": "America/New_York",
            "briefings": ["0 5 * * *", "0 13 * * *", "0 21 * * *"],
        },
        FakeOrchestrator(),  # type: ignore[arg-type]
        tmp_path,
    )

    result = await scheduler.run_briefing()

    assert result["model_error"] == "RuntimeError"
    assert "model was unavailable" in result["summary"]
    assert result["next_run"]
    assert result["id"]
    assert scheduler.get_status()["history_count"] == 1

    # A fresh scheduler instance hydrates its status and records from disk.
    restarted = BriefingScheduler(
        {"timezone": "America/New_York"},
        FakeOrchestrator(),  # type: ignore[arg-type]
        tmp_path,
    )
    assert restarted.get_status()["last_run"] == result["timestamp"]
    history = restarted.list_history(limit=10)
    assert history[0]["id"] == result["id"]
    assert "collected" not in history[0]


@pytest.mark.asyncio
async def test_briefing_window_advances_only_after_successful_non_dry_run(
    tmp_path: Path,
) -> None:
    scheduler = BriefingScheduler(
        {"timezone": "America/New_York"},
        FakeOrchestrator(SuccessfulAgent()),  # type: ignore[arg-type]
        tmp_path,
    )

    first = await scheduler.run_briefing()
    dry_run = await scheduler.run_briefing(dry_run=True)
    second = await scheduler.run_briefing()

    assert first["successful"] is True
    assert first["delivery"]["status"] == "unavailable"
    assert first["delivery"]["reason"] == "delivery_worker_not_running"
    assert dry_run["successful"] is False
    assert dry_run["window_start"] == first["window_end"]
    assert second["window_start"] == first["window_end"]
    assert second["window_start"] != dry_run["window_end"]


@pytest.mark.asyncio
async def test_scheduled_slot_is_not_replayed_after_restart(tmp_path: Path) -> None:
    config = {"timezone": "America/New_York"}
    scheduler = BriefingScheduler(
        config,
        FakeOrchestrator(SuccessfulAgent()),  # type: ignore[arg-type]
        tmp_path,
    )
    due_slot = scheduler._latest_due_slot()  # noqa: SLF001 - deterministic slot contract
    assert due_slot is not None

    first = await scheduler.run_briefing(scheduled_slot=due_slot)
    duplicate = await scheduler.run_briefing(scheduled_slot=due_slot)
    restarted = BriefingScheduler(
        config,
        FakeOrchestrator(SuccessfulAgent()),  # type: ignore[arg-type]
        tmp_path,
    )

    assert duplicate["deduplicated"] is True
    assert duplicate["id"] == first["id"]
    assert scheduler._next_run is not None  # noqa: SLF001
    assert scheduler._next_run > due_slot  # noqa: SLF001
    assert restarted.get_status()["history_count"] == 1
    assert restarted.get_status()["next_run"] != due_slot.isoformat()


def test_legacy_success_after_due_slot_suppresses_restart_catchup(tmp_path: Path) -> None:
    config = {"timezone": "America/New_York"}
    scheduler = BriefingScheduler(
        config,
        FakeOrchestrator(SuccessfulAgent()),  # type: ignore[arg-type]
        tmp_path,
    )
    due_slot = scheduler._latest_due_slot()  # noqa: SLF001
    assert due_slot is not None
    now = datetime.now(UTC)
    assert now >= due_slot
    scheduler.history.append(
        {
            "timestamp": now.isoformat(),
            "dry_run": False,
            "successful": True,
            "summary": "Pre-migration report",
            "model_error": None,
            "window_start": (now.replace(microsecond=0)).isoformat(),
            "window_end": now.isoformat(),
            "next_run": None,
            "collected": {"sources": {}},
        }
    )

    restarted = BriefingScheduler(
        config,
        FakeOrchestrator(SuccessfulAgent()),  # type: ignore[arg-type]
        tmp_path,
    )

    assert restarted._next_run is not None  # noqa: SLF001
    assert restarted._next_run > due_slot  # noqa: SLF001


@pytest.mark.asyncio
async def test_report_returns_before_voice_delivery_and_worker_records_failure(
    tmp_path: Path,
) -> None:
    orchestrator = FakeOrchestrator(SuccessfulAgent())
    orchestrator.registry.capabilities["voice"] = RaisingVoiceCapability()
    scheduler = BriefingScheduler(
        {"timezone": "America/New_York"},
        orchestrator,  # type: ignore[arg-type]
        tmp_path,
    )
    scheduler.delivery_worker._running = True  # noqa: SLF001 - isolate worker scheduling

    result = await scheduler.run_briefing()
    queued = scheduler.list_history(limit=1)[0]

    assert result["delivery"]["status"] == "queued"
    assert queued["id"] == result["id"]
    assert queued["delivery"] == result["delivery"]

    assert await scheduler.delivery_worker.drain_once() is True
    saved = scheduler.list_history(limit=1)[0]
    assert saved["delivery"]["status"] == "delivery_failed"
    assert saved["delivery"]["reason"] == "voice.speak failed (RuntimeError)"


@pytest.mark.asyncio
async def test_started_scheduler_returns_while_slow_voice_remains_background(
    tmp_path: Path,
) -> None:
    voice_started = asyncio.Event()
    release_voice = asyncio.Event()

    class SlowVoiceCapability:
        async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
            voice_started.set()
            await release_voice.wait()
            return CapabilityResult(
                success=True,
                data={
                    "delivery_status": "played",
                    "rendered": True,
                    "queued": False,
                    "played": True,
                },
            )

    orchestrator = FakeOrchestrator(SuccessfulAgent())
    orchestrator.registry.capabilities["voice"] = SlowVoiceCapability()
    scheduler = BriefingScheduler(
        {"timezone": "America/New_York", "delivery_poll_seconds": 60},
        orchestrator,  # type: ignore[arg-type]
        tmp_path,
    )
    scheduler.delivery_worker.start()
    try:
        result = await asyncio.wait_for(scheduler.run_briefing(), timeout=1)
        await asyncio.wait_for(voice_started.wait(), timeout=1)

        assert result["delivery"]["status"] == "queued"
        assert scheduler.get_status()["active_run"] is None
        assert scheduler.get_status()["delivery_queue"]["running"] == 1

        release_voice.set()
        for _ in range(50):
            saved = scheduler.list_history(limit=1)[0]
            if saved["delivery"]["status"] == "played":
                break
            await asyncio.sleep(0.01)
        assert saved["delivery"]["status"] == "played"
    finally:
        release_voice.set()
        await scheduler.delivery_worker.stop()
