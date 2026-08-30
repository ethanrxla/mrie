"""Web scraping capability."""

from __future__ import annotations

from html.parser import HTMLParser
from typing import Any

import httpx

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition
from mrie.net.safe_http import SafeHTTPClient
from mrie.retrieval.web_search import WebSearchProviderError, build_web_search_provider


class _VisibleTextParser(HTMLParser):
    """Small dependency-free extractor; source text remains untrusted data."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "noscript", "svg"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth and data.strip():
            self.parts.append(data.strip())

    def text(self) -> str:
        return "\n".join(self.parts)


class WebScrapeCapability(Capability):
    name = "web"
    description = "Extract content and search the web"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.http = SafeHTTPClient(config)
        self.max_text_chars = int(config.get("max_text_chars", 100_000))
        self.search_provider = build_web_search_provider(config, self.http)

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="extract_url",
                description="Extract text content from a URL",
                parameters={
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            ),
            ToolDefinition(
                name="search_web",
                description="Search the web through the configured provider",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "default": 10},
                        "freshness": {
                            "type": "string",
                            "enum": ["pd", "pw", "pm", "py"],
                            "description": "Optional past day/week/month/year filter",
                        },
                    },
                    "required": ["query"],
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "extract_url":
            return await self.extract_url(**kwargs)
        if method == "search_web":
            return await self.search_web(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def extract_url(self, url: str) -> CapabilityResult:
        try:
            response = await self.http.get(url)
            content_type = response.headers.get("content-type", "")
            extracted = ""
            if "html" in content_type:
                parser = _VisibleTextParser()
                parser.feed(response.text)
                extracted = parser.text()
            elif content_type.startswith("text/"):
                extracted = response.text
            return CapabilityResult(
                success=True,
                data={
                    "url": response.url,
                    "content_type": content_type,
                    "content_length": len(response.content),
                    "text": extracted[: self.max_text_chars],
                    "truncated": len(extracted) > self.max_text_chars,
                    "trust": "untrusted_external_data",
                },
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def search_web(
        self, query: str, limit: int = 10, freshness: str | None = None
    ) -> CapabilityResult:
        try:
            data = await self.search_provider.search(
                query,
                limit=limit,
                freshness=freshness,
            )
            return CapabilityResult(success=True, data=data)
        except WebSearchProviderError as exc:
            return CapabilityResult(
                success=False,
                data={
                    "provider": self.search_provider.name,
                    "code": exc.code,
                    "retryable": exc.retryable,
                    "status_code": exc.status_code,
                },
                error=exc.message,
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return CapabilityResult(
                success=False,
                data={
                    "provider": self.search_provider.name,
                    "code": "transport_error",
                    "retryable": True,
                },
                error=f"{self.search_provider.name} search transport failed ({type(exc).__name__})",
            )
