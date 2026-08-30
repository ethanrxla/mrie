"""Provider-neutral web search backed by supported public APIs."""

from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from mrie.net.safe_http import SafeHTTPClient


@dataclass(frozen=True, slots=True)
class WebSearchProviderError(RuntimeError):
    """A stable, secret-free search-provider failure."""

    code: str
    message: str
    retryable: bool = False
    status_code: int | None = None

    def __str__(self) -> str:
        return self.message


class WebSearchProvider(ABC):
    """Internal contract for interchangeable search services."""

    name: str

    @property
    @abstractmethod
    def configured(self) -> bool:
        """Return whether the adapter has the credentials it needs."""

    @abstractmethod
    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        freshness: str | None = None,
    ) -> dict[str, Any]:
        """Return normalized search results."""


class DisabledWebSearchProvider(WebSearchProvider):
    name = "disabled"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    @property
    def configured(self) -> bool:
        return False

    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        freshness: str | None = None,
    ) -> dict[str, Any]:
        del query, limit, freshness
        raise WebSearchProviderError("not_configured", self.reason)


class BraveWebSearchProvider(WebSearchProvider):
    """Brave Search API adapter with a normalized result schema."""

    name = "brave"
    endpoint = "https://api.search.brave.com/res/v1/web/search"
    _freshness_values = {"pd", "pw", "pm", "py"}

    def __init__(
        self,
        http: SafeHTTPClient,
        *,
        api_key_env: str = "BRAVE_SEARCH_API_KEY",
        country: str = "US",
        search_lang: str = "en",
        safesearch: str = "moderate",
    ) -> None:
        self.http = http
        self.api_key_env = api_key_env
        self.country = country
        self.search_lang = search_lang
        self.safesearch = safesearch

    @property
    def configured(self) -> bool:
        return bool(os.environ.get(self.api_key_env, "").strip())

    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        freshness: str | None = None,
    ) -> dict[str, Any]:
        normalized_query = query.strip()
        if not normalized_query:
            raise WebSearchProviderError("invalid_query", "Search query cannot be empty")
        if len(normalized_query) > 400 or len(normalized_query.split()) > 50:
            raise WebSearchProviderError(
                "invalid_query",
                "Brave search queries are limited to 400 characters and 50 words",
            )
        bounded_limit = max(1, min(int(limit), 20))
        if freshness is not None and freshness not in self._freshness_values:
            raise WebSearchProviderError(
                "invalid_freshness",
                "Freshness must be one of pd, pw, pm, or py",
            )

        api_key = os.environ.get(self.api_key_env, "").strip()
        if not api_key:
            raise WebSearchProviderError(
                "not_configured",
                f"Brave web search is selected but {self.api_key_env} is not configured",
            )

        params: dict[str, str | int] = {
            "q": normalized_query,
            "count": bounded_limit,
            "country": self.country,
            "search_lang": self.search_lang,
            "safesearch": self.safesearch,
        }
        if freshness:
            params["freshness"] = freshness
        response = await self.http.get(
            self.endpoint,
            params=params,
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": api_key,
            },
            raise_for_status=False,
        )
        payload = _decode_json(response.content, provider=self.name)
        if response.status_code != 200:
            raise _provider_http_error(self.name, response.status_code, payload)

        raw_results = (payload.get("web") or {}).get("results") or []
        results: list[dict[str, Any]] = []
        for rank, item in enumerate(raw_results[:bounded_limit], start=1):
            if not isinstance(item, dict) or not item.get("url"):
                continue
            results.append(
                {
                    "rank": rank,
                    "title": str(item.get("title") or ""),
                    "url": str(item["url"]),
                    "snippet": str(item.get("description") or ""),
                    "published_at": item.get("page_age") or item.get("age"),
                    "language": item.get("language"),
                    "source": self.name,
                    "trust": "untrusted_external_data",
                }
            )
        query_meta = payload.get("query") if isinstance(payload.get("query"), dict) else {}
        return {
            "provider": self.name,
            "query": normalized_query,
            "results": results,
            "result_count": len(results),
            "more_results_available": bool(query_meta.get("more_results_available")),
        }


def build_web_search_provider(
    config: dict[str, Any], http: SafeHTTPClient
) -> WebSearchProvider:
    """Build the configured adapter without ever reading a secret from YAML."""

    selected = str(config.get("search_provider", "disabled")).strip().lower()
    brave_key_env = str(config.get("brave_api_key_env", "BRAVE_SEARCH_API_KEY"))
    if selected == "auto":
        selected = "brave" if os.environ.get(brave_key_env, "").strip() else "disabled"
    if selected == "brave":
        # Search credentials can only leave for Brave's documented API host,
        # regardless of the broader extraction allowlist.
        http = SafeHTTPClient(
            {
                **config,
                "allowed_schemes": ["https"],
                "allowed_hosts": ["api.search.brave.com"],
            }
        )
        return BraveWebSearchProvider(
            http,
            api_key_env=brave_key_env,
            country=str(config.get("search_country", "US")),
            search_lang=str(config.get("search_language", "en")),
            safesearch=str(config.get("search_safesearch", "moderate")),
        )
    if selected == "disabled":
        return DisabledWebSearchProvider(
            "Web search is disabled; set web.search_provider to brave and configure "
            f"{brave_key_env}"
        )
    return DisabledWebSearchProvider(
        f"Unsupported web search provider '{selected}'; supported providers: brave, disabled"
    )


def _decode_json(content: bytes, *, provider: str) -> dict[str, Any]:
    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WebSearchProviderError(
            "invalid_response",
            f"{provider} returned a response that was not valid JSON",
            retryable=True,
        ) from exc
    if not isinstance(payload, dict):
        raise WebSearchProviderError(
            "invalid_response",
            f"{provider} returned an unexpected response shape",
            retryable=True,
        )
    return payload


def _provider_http_error(
    provider: str, status_code: int, payload: dict[str, Any]
) -> WebSearchProviderError:
    if status_code in {401, 403}:
        code, message, retryable = (
            "invalid_credentials",
            f"{provider} rejected the configured API credential",
            False,
        )
    elif status_code == 429:
        code, message, retryable = (
            "rate_limited",
            f"{provider} rate limit was reached; retry later",
            True,
        )
    elif status_code >= 500:
        code, message, retryable = (
            "upstream_unavailable",
            f"{provider} search is temporarily unavailable",
            True,
        )
    else:
        provider_code = payload.get("code")
        code, message, retryable = (
            str(provider_code) if provider_code else "provider_error",
            f"{provider} search request failed with HTTP {status_code}",
            False,
        )
    return WebSearchProviderError(code, message, retryable, status_code)
