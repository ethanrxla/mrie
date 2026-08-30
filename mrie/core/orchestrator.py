"""MRE orchestrator — session lifecycle, scheduler, and IPC bridge."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from mrie.capabilities import build_default_registry
from mrie.core.agent_loop import AgentLoop
from mrie.core.capability_base import CapabilityRegistry
from mrie.core.ethics_guard import EthicsGuard
from mrie.core.event_bus import EventBus
from mrie.providers import (
    ClaudeSubscriptionProvider,
    CodexSubscriptionProvider,
    NVIDIANIMProvider,
    ProviderRouter,
)
from mrie.scheduler.briefing_scheduler import BriefingScheduler
from mrie.scheduler.event_watcher import EventWatcher


class MRIEOrchestrator:
    """Central coordinator for MRE capabilities, agent loop, and scheduler."""

    def __init__(self, project_root: Path | None = None) -> None:
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        self.config = self._load_config()
        self.registry: CapabilityRegistry = build_default_registry(self.config, self.project_root)
        self.ethics_guard = EthicsGuard(self.config, self.project_root)
        self.provider = self._build_provider_router()
        self.agent = AgentLoop(
            self.provider,
            self.registry,
            self.ethics_guard,
            history_limit=int(self.config.get("agent", {}).get("history_limit", 40)),
        )
        self.scheduler = BriefingScheduler(
            config=self.config.get("scheduler", {}),
            orchestrator=self,
            project_root=self.project_root,
        )
        self.event_bus = EventBus()
        self.event_watcher = EventWatcher(
            config=self.config.get("event_watcher", {}),
            orchestrator=self,
        )

    def _load_config(self) -> dict[str, Any]:
        config_path = self.project_root / "config" / "mrie.yaml"
        if not config_path.exists():
            example = self.project_root / "config" / "mrie.example.yaml"
            config_path = example
        if not config_path.exists():
            raise FileNotFoundError("Missing config/mrie.yaml and config/mrie.example.yaml")
        with config_path.open(encoding="utf-8") as handle:
            return yaml.safe_load(handle) or {}

    def _build_provider_router(self) -> ProviderRouter:
        provider_config = self.config.get("providers", {})
        primary_name = str(provider_config.get("primary", "nvidia_nim"))
        if primary_name != "nvidia_nim":
            raise ValueError(
                "The bootstrap runtime currently requires providers.primary=nvidia_nim"
            )
        nim_config = provider_config.get("nvidia_nim", self.config.get("provider", {}))
        primary = NVIDIANIMProvider(nim_config)
        optional = [
            CodexSubscriptionProvider(
                provider_config.get("codex_subscription", {}), self.project_root
            ),
            ClaudeSubscriptionProvider(
                provider_config.get("claude_subscription", {}), self.project_root
            ),
        ]
        return ProviderRouter(primary, optional)

    async def ask(
        self,
        message: str,
        provider: str | None = None,
        session_id: str = "default",
    ) -> str:
        return await self.agent.ask(message, provider_name=provider, session_id=session_id)

    async def run_briefing(self, dry_run: bool = False) -> dict[str, Any]:
        return await self.scheduler.run_briefing(dry_run=dry_run)

    def get_status(self) -> dict[str, Any]:
        return {
            "agent": "MRE",
            "version": "0.1.0",
            "capabilities": [cap.name for cap in self.registry.all_capabilities()],
            "scheduler": self.scheduler.get_status(),
            "event_watcher": self.event_watcher.get_status(),
            "provider": self.provider.get_status(),
            "last_briefings": self.scheduler.list_history(limit=3),
        }

    def start_scheduler(self) -> None:
        self.scheduler.start()
        self.event_watcher.start()

    async def stop_scheduler(self) -> None:
        await self.scheduler.stop()
        self.event_watcher.stop()
