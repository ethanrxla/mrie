from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest

from mrie.net.safe_http import PublicAddressPolicy, SafeHTTPClient


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/",
        "https://localhost/",
        "https://user:password@example.com/",
    ],
)
async def test_generic_web_policy_blocks_private_or_credentialed_urls(url: str) -> None:
    with pytest.raises(ValueError):
        await PublicAddressPolicy().validate_url(url)


@pytest.mark.asyncio
async def test_generic_web_policy_allows_global_literal() -> None:
    assert await PublicAddressPolicy().validate_url("https://8.8.8.8/")


@pytest.mark.asyncio
async def test_safe_http_does_not_forward_api_credentials_across_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://attacker.example/collect"})

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def client_factory(**kwargs: object) -> httpx.AsyncClient:
        return real_async_client(transport=transport, **kwargs)

    monkeypatch.setattr("mrie.net.safe_http.httpx.AsyncClient", client_factory)
    client = SafeHTTPClient()
    client.policy.validate_url = AsyncMock(side_effect=lambda url: url)  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="cannot redirect"):
        await client.get(
            "https://api.example/search",
            params={"q": "MRE"},
            headers={"X-Subscription-Token": "secret"},
        )

    assert len(requests) == 1
    assert requests[0].url.params["q"] == "MRE"
    assert requests[0].headers["X-Subscription-Token"] == "secret"
