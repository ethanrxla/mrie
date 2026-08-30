"""Passive honeypot evidence queries.

Network-facing emulation stays in an isolated, maintained sensor such as Cowrie;
MRE consumes normalized Wazuh events and never engages or retaliates.
"""

from __future__ import annotations

from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, EthicsVerdict, ToolDefinition
from mrie.security.store import SecurityEventStore


class HoneypotCapability(Capability):
    name = "honeypot"
    description = "Inspect passive honeypot observations from the security event store"

    def __init__(self, config: dict[str, Any], store: SecurityEventStore) -> None:
        self.config = config
        self.store = store

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="status",
                description="Describe configured passive honeypot sensors",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="recent_observations",
                description="Read recent normalized events tagged as honeypot telemetry",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 50}},
                },
            ),
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        if method not in {"status", "recent_observations"}:
            return EthicsVerdict.DENY
        return EthicsVerdict.ALLOW

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "status":
            return CapabilityResult(
                success=True,
                data={
                    "enabled": bool(self.config.get("enabled", False)),
                    "sensors": self.config.get("sensors", []),
                    "mode": "passive-observation-only",
                },
            )
        if method == "recent_observations":
            limit = max(1, min(int(kwargs.get("limit", 50)), 500))
            candidates = self.store.recent(limit=max(limit * 5, 100))
            events = [
                event
                for event in candidates
                if event.get("category") == "honeypot" or "honeypot" in event.get("tags", [])
            ][:limit]
            return CapabilityResult(success=True, data={"events": events})
        return CapabilityResult(success=False, error=f"Unknown method: {method}")
