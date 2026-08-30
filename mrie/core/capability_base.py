"""Abstract capability contract and registry."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EthicsVerdict(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_CONFIRMATION = "require_confirmation"


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass
class CapabilityResult:
    success: bool
    data: Any = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "data": self.data,
            "error": self.error,
        }


class Capability(ABC):
    """Base class for every MRE capability. Tools map to public methods."""

    name: str
    description: str

    @abstractmethod
    def get_tools(self) -> list[ToolDefinition]:
        """Return LLM-callable tool definitions for this capability."""

    @abstractmethod
    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        """Execute a capability method by name."""

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        """Override for capability-specific ethics defaults."""
        return EthicsVerdict.ALLOW

    def list_methods(self) -> list[str]:
        tools = self.get_tools()
        return [tool.name for tool in tools]


class CapabilityRegistry:
    """Discovers, registers, and dispatches capability invocations."""

    def __init__(self) -> None:
        self._capabilities: dict[str, Capability] = {}

    def register(self, capability: Capability) -> None:
        if capability.name in self._capabilities:
            raise ValueError(f"Capability already registered: {capability.name}")
        self._capabilities[capability.name] = capability

    def get(self, name: str) -> Capability | None:
        return self._capabilities.get(name)

    def all_capabilities(self) -> list[Capability]:
        return list(self._capabilities.values())

    def get_all_tools(self) -> list[ToolDefinition]:
        tools: list[ToolDefinition] = []
        for cap in self._capabilities.values():
            for tool in cap.get_tools():
                tools.append(
                    ToolDefinition(
                        name=f"{cap.name}__{tool.name}",
                        description=f"[{cap.name}] {tool.description}",
                        parameters=tool.parameters,
                    )
                )
        return tools

    async def invoke(
        self,
        capability_name: str,
        method: str,
        ethics_guard: Any | None = None,
        **kwargs: Any,
    ) -> CapabilityResult:
        capability = self._capabilities.get(capability_name)
        if capability is None:
            return CapabilityResult(success=False, error=f"Unknown capability: {capability_name}")

        if ethics_guard is not None:
            verdict = ethics_guard.evaluate(capability, method, **kwargs)
            if verdict == EthicsVerdict.DENY:
                return CapabilityResult(
                    success=False, error=f"Ethics guard denied {capability_name}.{method}"
                )
            if verdict == EthicsVerdict.REQUIRE_CONFIRMATION:
                return CapabilityResult(
                    success=False,
                    error=f"Confirmation required for {capability_name}.{method}",
                )

        return await capability.invoke(method, **kwargs)
