from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mrie.core.agent_loop import AgentLoop
from mrie.core.capability_base import CapabilityRegistry
from mrie.core.ethics_guard import EthicsGuard
from mrie.providers.base import ModelProvider
from mrie.providers.router import ProviderRouter


class EchoProvider(ModelProvider):
    name = "echo"

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        users = [message["content"] for message in messages if message["role"] == "user"]
        return {"content": "|".join(users), "tool_calls": []}

    def get_status(self) -> dict[str, Any]:
        return {"name": self.name}


class RecordingProvider(EchoProvider):
    name = "frontier"

    def __init__(self) -> None:
        self.last_messages: list[dict[str, str]] = []

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.last_messages = messages
        return {"content": "frontier", "tool_calls": []}


@pytest.mark.asyncio
async def test_conversation_histories_are_isolated(tmp_path: Path) -> None:
    guard = EthicsGuard({"ethics": {}}, tmp_path)
    loop = AgentLoop(EchoProvider(), CapabilityRegistry(), guard)

    assert await loop.ask("alpha", session_id="one") == "alpha"
    assert await loop.ask("beta", session_id="two") == "beta"
    assert await loop.ask("again", session_id="one") == "alpha|again"


@pytest.mark.asyncio
async def test_empty_message_is_rejected(tmp_path: Path) -> None:
    loop = AgentLoop(EchoProvider(), CapabilityRegistry(), EthicsGuard({"ethics": {}}, tmp_path))
    with pytest.raises(ValueError, match="empty"):
        await loop.ask("   ")


@pytest.mark.asyncio
async def test_frontier_escalation_does_not_receive_prior_session_history(tmp_path: Path) -> None:
    frontier = RecordingProvider()
    loop = AgentLoop(
        ProviderRouter(EchoProvider(), [frontier]),
        CapabilityRegistry(),
        EthicsGuard({"ethics": {}}, tmp_path),
    )

    await loop.ask("private earlier turn", session_id="one")
    await loop.ask("explicit escalation", provider_name="frontier", session_id="one")

    user_messages = [
        message["content"] for message in frontier.last_messages if message["role"] == "user"
    ]
    assert user_messages == ["explicit escalation"]
