"""Outbound HTTP policy for untrusted URLs.

Internal service integrations such as Wazuh use dedicated clients and explicit
configuration. Generic web/news capabilities use this module and cannot reach
private, loopback, link-local, reserved, multicast, or metadata-service hosts.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

BLOCKED_HOSTNAMES = {
    "localhost",
    "metadata.google.internal",
    "metadata.google",
}


@dataclass(frozen=True, slots=True)
class SafeHTTPResponse:
    status_code: int
    url: str
    headers: dict[str, str]
    content: bytes

    @property
    def text(self) -> str:
        encoding = "utf-8"
        content_type = self.headers.get("content-type", "")
        for part in content_type.split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset" and value:
                encoding = value.strip('"')
        return self.content.decode(encoding, errors="replace")


class PublicAddressPolicy:
    """Resolve and authorize globally routable destinations."""

    def __init__(
        self,
        allowed_schemes: list[str] | None = None,
        allowed_hosts: list[str] | None = None,
    ) -> None:
        self.allowed_schemes = {scheme.lower() for scheme in (allowed_schemes or ["https"])}
        self.allowed_hosts = {host.lower().rstrip(".") for host in (allowed_hosts or [])}

    async def validate_url(self, url: str) -> str:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in self.allowed_schemes:
            raise ValueError(f"URL scheme is not allowed: {parsed.scheme or '(missing)'}")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("Credentials in URLs are not allowed")
        if not parsed.hostname:
            raise ValueError("URL hostname is required")
        await self.validate_host(parsed.hostname, parsed.port)
        return url

    async def validate_host(self, hostname: str, port: int | None = None) -> list[str]:
        normalized = hostname.lower().rstrip(".")
        if normalized in BLOCKED_HOSTNAMES or normalized.endswith((".localhost", ".local")):
            raise ValueError(f"Blocked destination host: {hostname}")
        if self.allowed_hosts and not any(
            normalized == allowed or normalized.endswith(f".{allowed}")
            for allowed in self.allowed_hosts
        ):
            raise ValueError(f"Destination host is not allowlisted: {hostname}")

        try:
            literal = ipaddress.ip_address(normalized.strip("[]"))
            addresses = [literal]
        except ValueError:
            records = await asyncio.to_thread(
                socket.getaddrinfo,
                normalized,
                port or 443,
                type=socket.SOCK_STREAM,
            )
            addresses = list({ipaddress.ip_address(record[4][0]) for record in records})
        if not addresses:
            raise ValueError(f"Destination resolved to no addresses: {hostname}")
        for address in addresses:
            if not address.is_global:
                raise ValueError(f"Destination is not globally routable: {hostname}")
        return [str(address) for address in addresses]


class SafeHTTPClient:
    """Bounded GET client with validation on every redirect."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        config = config or {}
        self.policy = PublicAddressPolicy(
            allowed_schemes=config.get("allowed_schemes", ["https"]),
            allowed_hosts=config.get("allowed_hosts", []),
        )
        self.timeout = float(config.get("timeout_seconds", 30))
        self.max_response_bytes = int(config.get("max_response_bytes", 5_000_000))
        self.max_redirects = int(config.get("max_redirects", 5))
        self.user_agent = str(config.get("user_agent", "MRE/0.1 (+operator-controlled-agent)"))

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str | int | float | bool] | None = None,
        headers: Mapping[str, str] | None = None,
        raise_for_status: bool = True,
    ) -> SafeHTTPResponse:
        """Fetch a bounded public URL.

        Callers may provide API query parameters and headers without bypassing
        destination validation.  Authentication headers are only forwarded
        across same-origin redirects so an upstream cannot redirect a secret to
        another host.
        """

        current_url = url
        request_params = dict(params or {})
        request_headers = {"User-Agent": self.user_agent, **dict(headers or {})}
        authenticated = any(
            key.lower() in {"authorization", "x-api-key", "x-subscription-token"}
            for key in request_headers
        )
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for redirect_count in range(self.max_redirects + 1):
                await self.policy.validate_url(current_url)
                async with client.stream(
                    "GET",
                    current_url,
                    params=request_params or None,
                    headers=request_headers,
                ) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise httpx.HTTPStatusError(
                                "Redirect did not include Location",
                                request=response.request,
                                response=response,
                            )
                        if redirect_count >= self.max_redirects:
                            raise ValueError("Too many redirects")
                        redirected_url = urljoin(str(response.url), location)
                        if authenticated and self._origin(redirected_url) != self._origin(
                            str(response.url)
                        ):
                            raise ValueError(
                                "Authenticated request cannot redirect to another origin"
                            )
                        current_url = redirected_url
                        # The response URL already contains the initial query.
                        request_params = {}
                        continue
                    if raise_for_status:
                        response.raise_for_status()
                    declared = response.headers.get("content-length")
                    if declared and int(declared) > self.max_response_bytes:
                        raise ValueError("HTTP response exceeds configured byte limit")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > self.max_response_bytes:
                            raise ValueError("HTTP response exceeds configured byte limit")
                    return SafeHTTPResponse(
                        status_code=response.status_code,
                        url=str(response.url),
                        headers={key.lower(): value for key, value in response.headers.items()},
                        content=bytes(content),
                    )
        raise ValueError("HTTP request did not produce a response")

    @staticmethod
    def _origin(url: str) -> tuple[str, str, int | None]:
        parsed = urlsplit(url)
        return parsed.scheme.lower(), (parsed.hostname or "").lower().rstrip("."), parsed.port
