from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from mrie.capabilities.wazuh import WazuhCapability
from mrie.security.store import SecurityEventStore


@pytest.mark.asyncio
async def test_unconfigured_wazuh_returns_bounded_error(tmp_path: Path) -> None:
    capability = WazuhCapability({}, SecurityEventStore(tmp_path / "events.db"))
    result = await capability.invoke("manager_status")
    assert result.success is False
    assert "base_url" in (result.error or "")


def test_wazuh_tls_cannot_be_disabled() -> None:
    with pytest.raises(ValueError, match="cannot be disabled"):
        WazuhCapability._verify({"verify_tls": False})


@pytest.mark.asyncio
async def test_connection_status_never_claims_unconfigured_wazuh_is_connected(
    tmp_path: Path,
) -> None:
    capability = WazuhCapability({}, SecurityEventStore(tmp_path / "events.db"))

    result = await capability.connection_status()

    assert result.success is True
    assert result.data["state"] == "unconfigured"
    assert result.data["manager"]["state"] == "unconfigured"
    assert result.data["indexer"]["state"] == "unconfigured"


@pytest.mark.asyncio
async def test_connection_status_requires_successful_probes_for_connected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    capability = WazuhCapability(
        {
            "server_api": {"base_url": "https://manager.test"},
            "indexer": {"base_url": "https://indexer.test"},
        },
        SecurityEventStore(tmp_path / "events.db"),
    )
    manager_probe = AsyncMock(return_value={"data": {}})
    indexer_probe = AsyncMock(return_value={"hits": {"hits": []}})
    monkeypatch.setattr(capability, "_manager_request", manager_probe)
    monkeypatch.setattr(capability, "_indexer_search", indexer_probe)

    result = await capability.connection_status()

    assert result.data["state"] == "connected"
    assert result.data["manager"] == {"state": "connected", "error": None}
    assert result.data["indexer"] == {"state": "connected", "error": None}
    manager_probe.assert_awaited_once()
    indexer_probe.assert_awaited_once()


@pytest.mark.asyncio
async def test_connection_status_sanitizes_probe_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    capability = WazuhCapability(
        {
            "server_api": {"base_url": "https://manager.test"},
            "indexer": {"base_url": "https://indexer.test"},
        },
        SecurityEventStore(tmp_path / "events.db"),
    )
    monkeypatch.setattr(
        capability,
        "_manager_request",
        AsyncMock(side_effect=ValueError("Set PRIVATE_WAZUH_USERNAME and password")),
    )
    monkeypatch.setattr(
        capability,
        "_indexer_search",
        AsyncMock(return_value={"hits": {"hits": []}}),
    )

    result = await capability.connection_status()

    assert result.data["state"] == "partial"
    assert result.data["manager"]["error"] == (
        "Wazuh service credentials are not configured"
    )
    assert "PRIVATE" not in result.data["manager"]["error"]
