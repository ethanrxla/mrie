from __future__ import annotations

import json
from typing import Any

import pytest

from mrie.capabilities.news import NewsCapability
from mrie.capabilities.social_feeds import InstagramCapability
from mrie.capabilities.web_scrape import WebScrapeCapability
from mrie.net.safe_http import SafeHTTPResponse
from mrie.retrieval.web_search import BraveWebSearchProvider, WebSearchProviderError


class FakeHTTPClient:
    def __init__(self, response: SafeHTTPResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def get(self, url: str, **kwargs: Any) -> SafeHTTPResponse:
        self.calls.append((url, kwargs))
        return self.response


def json_response(status_code: int, payload: dict[str, Any]) -> SafeHTTPResponse:
    return SafeHTTPResponse(
        status_code=status_code,
        url="https://provider.example/request",
        headers={"content-type": "application/json"},
        content=json.dumps(payload).encode(),
    )


@pytest.mark.asyncio
async def test_rss_headlines_report_each_live_feed_status() -> None:
    capability = NewsCapability(
        {"rss_feeds": ["https://one.example/rss", "https://two.example/rss"]}
    )
    capability.http = FakeHTTPClient(  # type: ignore[assignment]
        SafeHTTPResponse(
            status_code=200,
            url="https://feed.example/resolved.xml",
            headers={"content-type": "application/rss+xml"},
            content=b"""<?xml version="1.0"?>
                <rss version="2.0"><channel><title>Test</title>
                <item><title>Verified headline</title>
                <link>https://example.com/report</link></item>
                </channel></rss>""",
        )
    )

    result = await capability.fetch_headlines(limit=10)

    assert result.success is True
    assert len(result.data["headlines"]) == 2
    assert result.data["trust"] == "untrusted_external_data"
    assert result.data["feed_statuses"] == [
        {
            "source": "https://one.example/rss",
            "resolved_url": "https://feed.example/resolved.xml",
            "success": True,
            "headline_count": 1,
            "error": None,
        },
        {
            "source": "https://two.example/rss",
            "resolved_url": "https://feed.example/resolved.xml",
            "success": True,
            "headline_count": 1,
            "error": None,
        },
    ]


@pytest.mark.asyncio
async def test_disabled_web_search_fails_truthfully(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    capability = WebScrapeCapability({"search_provider": "auto"})

    result = await capability.search_web("current MRE security news")

    assert result.success is False
    assert result.data == {
        "provider": "disabled",
        "code": "not_configured",
        "retryable": False,
        "status_code": None,
    }
    assert "BRAVE_SEARCH_API_KEY" in result.error


@pytest.mark.asyncio
async def test_brave_search_normalizes_and_bounds_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "test-secret")
    fake = FakeHTTPClient(
        json_response(
            200,
            {
                "query": {"more_results_available": True},
                "web": {
                    "results": [
                        {
                            "title": "MRE result",
                            "url": "https://example.com/result",
                            "description": "External result snippet",
                            "page_age": "2026-08-12T10:00:00Z",
                            "language": "en",
                        }
                    ]
                },
            },
        )
    )
    provider = BraveWebSearchProvider(fake)  # type: ignore[arg-type]

    result = await provider.search("MRE", limit=999, freshness="pd")

    assert result["provider"] == "brave"
    assert result["result_count"] == 1
    assert result["results"][0] == {
        "rank": 1,
        "title": "MRE result",
        "url": "https://example.com/result",
        "snippet": "External result snippet",
        "published_at": "2026-08-12T10:00:00Z",
        "language": "en",
        "source": "brave",
        "trust": "untrusted_external_data",
    }
    _, request = fake.calls[0]
    assert request["params"]["count"] == 20
    assert request["params"]["freshness"] == "pd"
    assert "apiKey" not in request["params"]
    assert request["headers"]["X-Subscription-Token"] == "test-secret"


@pytest.mark.asyncio
async def test_brave_error_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "do-not-echo")
    fake = FakeHTTPClient(
        json_response(401, {"code": "AUTH", "message": "bad key do-not-echo"})
    )
    provider = BraveWebSearchProvider(fake)  # type: ignore[arg-type]

    with pytest.raises(WebSearchProviderError) as caught:
        await provider.search("MRE")

    assert caught.value.code == "invalid_credentials"
    assert caught.value.status_code == 401
    assert "do-not-echo" not in str(caught.value)


@pytest.mark.asyncio
async def test_newsapi_invalid_key_has_actionable_sanitized_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NEWSAPI_KEY", "do-not-echo")
    capability = NewsCapability({})
    fake = FakeHTTPClient(
        json_response(
            401,
            {
                "status": "error",
                "code": "apiKeyInvalid",
                "message": "The key do-not-echo is invalid",
            },
        )
    )
    capability.newsapi_http = fake  # type: ignore[assignment]

    result = await capability.search_topic("cybersecurity")

    assert result.success is False
    assert result.data == {
        "provider": "newsapi",
        "code": "apiKeyInvalid",
        "retryable": False,
        "status_code": 401,
    }
    assert result.error == "The configured NewsAPI key is invalid"
    assert "do-not-echo" not in result.error
    _, request = fake.calls[0]
    assert "apiKey" not in request["params"]
    assert request["headers"]["X-Api-Key"] == "do-not-echo"


@pytest.mark.asyncio
async def test_newsapi_success_returns_untrusted_normalized_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NEWSAPI_KEY", "configured")
    capability = NewsCapability({})
    capability.newsapi_http = FakeHTTPClient(  # type: ignore[assignment]
        json_response(
            200,
            {
                "status": "ok",
                "totalResults": 1,
                "articles": [{"title": "A current event", "url": "https://example.com/a"}],
            },
        )
    )

    result = await capability.search_topic("current event", limit=1)

    assert result.success is True
    assert result.data["provider"] == "newsapi"
    assert result.data["total_results"] == 1
    assert result.data["trust"] == "untrusted_external_data"


@pytest.mark.asyncio
async def test_instagram_feed_fails_truthfully_when_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("INSTAGRAM_ACCESS_TOKEN", raising=False)
    capability = InstagramCapability({})

    result = await capability.invoke("fetch_recent_posts", limit=10)

    assert result.success is False
    assert result.data == {
        "posts": [],
        "provider": "instagram",
        "code": "not_configured",
        "retryable": False,
    }
    assert "professional-account" in result.error
