from __future__ import annotations

from typing import Any

import pytest

from mrie.core.capability_base import CapabilityResult
from mrie.core.ipc_server import IPCServer


class FakeCapability:
    def __init__(self, results: dict[str, CapabilityResult]) -> None:
        self.results = results
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        self.calls.append((method, kwargs))
        return self.results[method]


class FakeRegistry:
    def __init__(self, capabilities: dict[str, FakeCapability]) -> None:
        self.capabilities = capabilities

    def get(self, name: str) -> FakeCapability | None:
        return self.capabilities.get(name)


class FakeOrchestrator:
    def __init__(self, registry: FakeRegistry) -> None:
        self.registry = registry


@pytest.mark.asyncio
async def test_security_status_reports_probed_sources_without_sensor_details() -> None:
    wazuh = FakeCapability(
        {
            "connection_status": CapabilityResult(
                success=True,
                data={
                    "state": "unconfigured",
                    "checked_at": "2026-08-12T18:00:00+00:00",
                    "manager": {
                        "state": "unconfigured",
                        "error": "Wazuh manager API is not configured",
                    },
                    "indexer": {
                        "state": "unconfigured",
                        "error": "Wazuh indexer is not configured",
                    },
                },
            )
        }
    )
    honeypot = FakeCapability(
        {
            "status": CapabilityResult(
                success=True,
                data={
                    "enabled": True,
                    "sensors": [{"host": "private-sensor.test", "token": "secret"}],
                },
            )
        }
    )
    server = IPCServer(  # type: ignore[arg-type]
        FakeOrchestrator(FakeRegistry({"wazuh": wazuh, "honeypot": honeypot}))
    )

    response = await server.handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": "security.status", "params": {}}
    )

    status = response["result"]
    assert status["wazuh"]["state"] == "unconfigured"
    assert status["honeypot"] == {
        "state": "configured",
        "enabled": True,
        "sensor_count": 1,
        "mode": "passive-observation-only",
        "error": None,
    }
    assert "sensors" not in status["honeypot"]


@pytest.mark.asyncio
async def test_security_events_bounds_console_query() -> None:
    wazuh = FakeCapability(
        {
            "recent_events": CapabilityResult(
                success=True,
                data={"events": [], "counts_by_severity": {}},
            )
        }
    )
    server = IPCServer(  # type: ignore[arg-type]
        FakeOrchestrator(FakeRegistry({"wazuh": wazuh}))
    )

    response = await server.handle_request(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "security.events",
            "params": {"limit": 99999, "minimum_severity": -10},
        }
    )

    assert response["result"]["success"] is True
    assert wazuh.calls == [("recent_events", {"limit": 500, "minimum_severity": 0})]


@pytest.mark.asyncio
async def test_security_status_returns_schema_valid_generic_probe_failures() -> None:
    wazuh = FakeCapability(
        {
            "connection_status": CapabilityResult(
                success=False, error="private backend detail"
            )
        }
    )
    honeypot = FakeCapability(
        {"status": CapabilityResult(success=False, error="private sensor detail")}
    )
    server = IPCServer(  # type: ignore[arg-type]
        FakeOrchestrator(FakeRegistry({"wazuh": wazuh, "honeypot": honeypot}))
    )

    response = await server.handle_request(
        {"jsonrpc": "2.0", "id": 3, "method": "security.status", "params": {}}
    )

    status = response["result"]
    assert status["wazuh"]["state"] == "error"
    assert status["wazuh"]["checked_at"]
    assert status["honeypot"] == {
        "state": "error",
        "enabled": False,
        "sensor_count": 0,
        "mode": "passive-observation-only",
        "error": "Honeypot capability status probe failed",
    }
    assert "private" not in str(status)
