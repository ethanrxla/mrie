"""MCP bridge capability — wraps Hermes native MCP client."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition


class MCPCapability(Capability):
    name = "mcp"
    description = "Connect to external MCP servers for extended tools"

    def __init__(self, config: dict[str, Any], project_root: Path) -> None:
        self.config = config
        self.project_root = project_root
        self._hermes_config_path = project_root / "vendor" / "hermes-agent"
        self._discovered_tools: list[dict[str, Any]] = []

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_servers",
                description="List configured MCP servers",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="call_tool",
                description="Call a tool on an MCP server",
                parameters={
                    "type": "object",
                    "properties": {
                        "server": {"type": "string"},
                        "tool": {"type": "string"},
                        "arguments": {"type": "object"},
                    },
                    "required": ["server", "tool"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "list_servers":
            return CapabilityResult(success=True, data={"servers": list(self.config.keys())})
        if method == "call_tool":
            return CapabilityResult(
                success=False,
                error="MCP tool dispatch pending Hermes mcp_tool integration",
                data={"server": kwargs.get("server"), "tool": kwargs.get("tool")},
            )
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    def load_hermes_mcp_config(self) -> dict[str, Any]:
        """Read MCP server config from Hermes-style YAML when available."""
        hermes_yaml = Path.home() / ".hermes" / "config.yaml"
        if hermes_yaml.exists():
            import yaml

            with hermes_yaml.open(encoding="utf-8") as handle:
                data = yaml.safe_load(handle) or {}
                return data.get("mcp_servers", {})
        return self.config
