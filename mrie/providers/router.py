"""Provider selection and explicit frontier escalation."""

from __future__ import annotations

from typing import Any

from mrie.providers.base import ModelProvider, ProviderUnavailableError


class ProviderRouter(ModelProvider):
    """Routes normal traffic to a primary model and named opt-in providers."""

    name = "router"

    def __init__(
        self,
        primary: ModelProvider,
        optional: list[ModelProvider] | None = None,
    ) -> None:
        self.primary = primary
        self.providers = {primary.name: primary}
        for provider in optional or []:
            if provider.name in self.providers:
                raise ValueError(f"Duplicate provider: {provider.name}")
            self.providers[provider.name] = provider

    def get(self, name: str | None = None) -> ModelProvider:
        if name is None or name == "primary":
            return self.primary
        provider = self.providers.get(name)
        if provider is None:
            raise ProviderUnavailableError(f"Unknown provider: {name}")
        return provider

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.primary.chat(messages, tools)

    async def chat_with(
        self,
        provider_name: str | None,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.get(provider_name).chat(messages, tools)

    def get_status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "primary": self.primary.name,
            "providers": {name: provider.get_status() for name, provider in self.providers.items()},
        }
