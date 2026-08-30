from __future__ import annotations

from typing import Any

import pytest

from mrie.core.capability_base import (
    Capability,
    CapabilityRegistry,
    CapabilityResult,
    ToolDefinition,
)


class ExampleCapability(Capability):
    name = "example"
    description = "test"

    def get_tools(self) -> list[ToolDefinition]:
        return [ToolDefinition("read", "read", {"type": "object", "properties": {}})]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        return CapabilityResult(success=True, data={"method": method})


def test_tool_names_use_provider_safe_separator() -> None:
    registry = CapabilityRegistry()
    registry.register(ExampleCapability())
    assert registry.get_all_tools()[0].name == "example__read"


def test_duplicate_capability_is_rejected() -> None:
    registry = CapabilityRegistry()
    registry.register(ExampleCapability())
    with pytest.raises(ValueError, match="already registered"):
        registry.register(ExampleCapability())
