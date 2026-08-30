"""News capability — headlines, articles, topic search."""

from __future__ import annotations

import json
import os
from typing import Any

import feedparser
import httpx

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition
from mrie.net.safe_http import SafeHTTPClient


class NewsCapability(Capability):
    name = "news"
    description = "Fetch news from APIs and RSS feeds"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.rss_feeds = config.get(
            "rss_feeds",
            [
                "https://feeds.bbci.co.uk/news/rss.xml",
                "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
            ],
        )
        self.newsapi_key_env = config.get("newsapi_key_env", "NEWSAPI_KEY")
        self.http = SafeHTTPClient(config)
        self.newsapi_http = SafeHTTPClient(
            {
                **config,
                "allowed_schemes": ["https"],
                "allowed_hosts": ["newsapi.org"],
            }
        )
        self.max_article_chars = int(config.get("max_article_chars", 100_000))

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="fetch_headlines",
                description="Fetch recent headlines from configured RSS/API sources",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 10}},
                },
            ),
            ToolDefinition(
                name="fetch_article",
                description="Fetch full text/metadata for an article URL",
                parameters={
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            ),
            ToolDefinition(
                name="search_topic",
                description="Search news for a topic via NewsAPI if configured",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "default": 10},
                    },
                    "required": ["query"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "fetch_headlines":
            return await self.fetch_headlines(**kwargs)
        if method == "fetch_article":
            return await self.fetch_article(**kwargs)
        if method == "search_topic":
            return await self.search_topic(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def fetch_headlines(self, limit: int = 10) -> CapabilityResult:
        headlines: list[dict[str, str]] = []
        errors: list[dict[str, str]] = []
        feed_statuses: list[dict[str, Any]] = []
        bounded_limit = max(1, min(int(limit), 100))
        for feed_url in self.rss_feeds:
            try:
                response = await self.http.get(feed_url)
                parsed = feedparser.parse(response.content)
                entries = parsed.entries[:bounded_limit]
                for entry in entries:
                    headlines.append(
                        {
                            "title": entry.get("title", ""),
                            "link": entry.get("link", ""),
                            "published": entry.get("published", ""),
                            "source": str(response.url),
                        }
                    )
                feed_statuses.append(
                    {
                        "source": str(feed_url),
                        "resolved_url": str(response.url),
                        "success": True,
                        "headline_count": len(entries),
                        "error": None,
                    }
                )
            except (httpx.HTTPError, OSError, ValueError) as exc:
                errors.append({"source": feed_url, "error": type(exc).__name__})
                feed_statuses.append(
                    {
                        "source": str(feed_url),
                        "resolved_url": None,
                        "success": False,
                        "headline_count": 0,
                        "error": type(exc).__name__,
                    }
                )
        return CapabilityResult(
            success=bool(headlines) or not errors,
            data={
                "headlines": headlines[:bounded_limit],
                "source_errors": errors,
                "feed_statuses": feed_statuses,
                "trust": "untrusted_external_data",
            },
            error="All configured news feeds failed" if errors and not headlines else None,
        )

    async def fetch_article(self, url: str) -> CapabilityResult:
        try:
            response = await self.http.get(url)
            text = response.text
            return CapabilityResult(
                success=True,
                data={
                    "url": response.url,
                    "length": len(response.content),
                    "text": text[: self.max_article_chars],
                    "truncated": len(text) > self.max_article_chars,
                    "trust": "untrusted_external_data",
                },
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def search_topic(self, query: str, limit: int = 10) -> CapabilityResult:
        normalized_query = query.strip()
        if not normalized_query:
            return CapabilityResult(
                success=False,
                data={"provider": "newsapi", "code": "invalid_query", "retryable": False},
                error="News search query cannot be empty",
            )
        if len(normalized_query) > 500:
            return CapabilityResult(
                success=False,
                data={"provider": "newsapi", "code": "invalid_query", "retryable": False},
                error="NewsAPI search queries are limited to 500 characters",
            )
        api_key = os.environ.get(self.newsapi_key_env, "").strip()
        if not api_key:
            return CapabilityResult(
                success=False,
                data={"provider": "newsapi", "code": "not_configured", "retryable": False},
                error=f"NewsAPI is not configured; set {self.newsapi_key_env}",
            )
        try:
            response = await self.newsapi_http.get(
                "https://newsapi.org/v2/everything",
                params={
                    "q": normalized_query,
                    "pageSize": max(1, min(int(limit), 100)),
                    "sortBy": "publishedAt",
                },
                headers={"Accept": "application/json", "X-Api-Key": api_key},
                raise_for_status=False,
            )
            try:
                payload = json.loads(response.content)
            except (UnicodeDecodeError, json.JSONDecodeError):
                return CapabilityResult(
                    success=False,
                    data={
                        "provider": "newsapi",
                        "code": "invalid_response",
                        "retryable": response.status_code >= 500,
                        "status_code": response.status_code,
                    },
                    error="NewsAPI returned a response that was not valid JSON",
                )
            if not isinstance(payload, dict):
                return CapabilityResult(
                    success=False,
                    data={
                        "provider": "newsapi",
                        "code": "invalid_response",
                        "retryable": True,
                        "status_code": response.status_code,
                    },
                    error="NewsAPI returned an unexpected response shape",
                )
            if response.status_code != 200 or payload.get("status") == "error":
                code = str(payload.get("code") or "provider_error")
                retryable = code in {"apiKeyExhausted", "rateLimited", "unexpectedError"}
                if response.status_code >= 500:
                    retryable = True
                descriptions = {
                    "apiKeyDisabled": "The configured NewsAPI key is disabled",
                    "apiKeyExhausted": "The NewsAPI request allowance is exhausted",
                    "apiKeyInvalid": "The configured NewsAPI key is invalid",
                    "apiKeyMissing": "NewsAPI did not receive an API key",
                    "rateLimited": "NewsAPI rate limit was reached; retry later",
                    "unexpectedError": "NewsAPI is temporarily unavailable",
                }
                return CapabilityResult(
                    success=False,
                    data={
                        "provider": "newsapi",
                        "code": code,
                        "retryable": retryable,
                        "status_code": response.status_code,
                    },
                    error=descriptions.get(
                        code, f"NewsAPI request failed with HTTP {response.status_code}"
                    ),
                )
            articles = payload.get("articles") if isinstance(payload.get("articles"), list) else []
            return CapabilityResult(
                success=True,
                data={
                    "provider": "newsapi",
                    "query": normalized_query,
                    "total_results": int(payload.get("totalResults") or 0),
                    "articles": articles,
                    "trust": "untrusted_external_data",
                },
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return CapabilityResult(
                success=False,
                data={"provider": "newsapi", "code": "transport_error", "retryable": True},
                error=f"NewsAPI transport failed ({type(exc).__name__})",
            )
