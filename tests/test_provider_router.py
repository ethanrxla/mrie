from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mrie.providers.base import ModelProvider, ProviderUnavailableError
from mrie.providers.router import ProviderRouter
from mrie.providers.subscription_cli import CodexSubscriptionProvider


class StaticProvider(ModelProvider):
    name = "static"

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return {"content": "ok", "tool_calls": []}

    def get_status(self) -> dict[str, Any]:
        return {"name": self.name}


@pytest.mark.asyncio
async def test_router_uses_primary() -> None:
    router = ProviderRouter(StaticProvider())
    response = await router.chat([{"role": "user", "content": "hello"}])
    assert response["content"] == "ok"


@pytest.mark.asyncio
async def test_subscription_provider_must_be_explicitly_enabled(tmp_path: Path) -> None:
    provider = CodexSubscriptionProvider({"enabled": False}, tmp_path)
    with pytest.raises(ProviderUnavailableError, match="disabled"):
        await provider.chat([{"role": "user", "content": "hello"}])
