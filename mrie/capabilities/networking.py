"""Networking capability — HTTP, DNS, connectivity checks."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition
from mrie.net.safe_http import PublicAddressPolicy, SafeHTTPClient


class NetworkingCapability(Capability):
    name = "networking"
    description = "Network connectivity and HTTP operations"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.http = SafeHTTPClient(config)
        self.address_policy = PublicAddressPolicy(
            allowed_schemes=config.get("allowed_schemes", ["https"]),
            allowed_hosts=config.get("allowed_hosts", []),
        )

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="http_get",
                description="Perform an HTTP GET request",
                parameters={
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            ),
            ToolDefinition(
                name="dns_lookup",
                description="Resolve a hostname to IP addresses",
                parameters={
                    "type": "object",
                    "properties": {"hostname": {"type": "string"}},
                    "required": ["hostname"],
                },
            ),
            ToolDefinition(
                name="check_connectivity",
                description="Check if a host:port is reachable",
                parameters={
                    "type": "object",
                    "properties": {
                        "host": {"type": "string"},
                        "port": {"type": "integer", "default": 443},
                    },
                    "required": ["host"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "http_get":
            return await self.http_get(**kwargs)
        if method == "dns_lookup":
            return await self.dns_lookup(**kwargs)
        if method == "check_connectivity":
            return await self.check_connectivity(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def http_get(self, url: str) -> CapabilityResult:
        try:
            response = await self.http.get(url)
            return CapabilityResult(
                success=True,
                data={
                    "status": response.status_code,
                    "length": len(response.content),
                    "url": response.url,
                },
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def dns_lookup(self, hostname: str) -> CapabilityResult:
        try:
            ips = await self.address_policy.validate_host(hostname)
            return CapabilityResult(success=True, data={"hostname": hostname, "addresses": ips})
        except (OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def check_connectivity(self, host: str, port: int = 443) -> CapabilityResult:
        try:
            await self.address_policy.validate_host(host, port)
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
            writer.close()
            await writer.wait_closed()
            return CapabilityResult(
                success=True, data={"host": host, "port": port, "reachable": True}
            )
        except (OSError, TimeoutError, ValueError) as exc:
            return CapabilityResult(
                success=True,
                data={"host": host, "port": port, "reachable": False, "error": str(exc)},
            )
