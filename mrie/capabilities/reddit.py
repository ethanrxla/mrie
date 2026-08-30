"""Read-only Reddit Data API capability using operator-provided OAuth credentials."""

from __future__ import annotations

import asyncio
import hashlib
import html
import json
import math
import os
import re
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API_BASE_URL = "https://oauth.reddit.com"
PUBLIC_BASE_URL = "https://www.reddit.com"
HARD_MAX_RESULTS = 50
DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
_SUBREDDIT_NAME = re.compile(r"^[A-Za-z0-9_]{2,21}$")
_LISTINGS = {"hot", "new", "rising", "top"}


class RedditProviderError(RuntimeError):
    """A public, credential-free Reddit integration diagnostic."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        status_code: int | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds


class RedditCapability(Capability):
    """Retrieve Reddit listings through the official OAuth API.

    The capability deliberately exposes no mutation methods. OAuth secrets stay in
    environment variables, responses are size-bounded, redirects are rejected, and
    provider error bodies are never returned to the agent or logs.
    """

    name = "reddit"
    description = "Read authenticated Reddit home and subreddit feeds"

    def __init__(
        self,
        config: dict[str, Any],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.config = config
        self.client_id_env = str(config.get("client_id_env", "REDDIT_CLIENT_ID"))
        self.client_secret_env = str(
            config.get("client_secret_env", "REDDIT_CLIENT_SECRET")
        )
        self.refresh_token_env = str(
            config.get("refresh_token_env", "REDDIT_REFRESH_TOKEN")
        )
        self.user_agent_env = str(config.get("user_agent_env", "REDDIT_USER_AGENT"))
        self.timeout_seconds = max(1.0, min(float(config.get("timeout_seconds", 20)), 60.0))
        self.max_response_bytes = max(
            16_384,
            min(
                int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)),
                5_000_000,
            ),
        )
        self.max_results = max(
            1, min(int(config.get("max_results", HARD_MAX_RESULTS)), HARD_MAX_RESULTS)
        )
        self.default_listing = str(config.get("listing", "hot")).lower().strip()
        if self.default_listing not in _LISTINGS:
            raise ValueError(
                "reddit.listing must be one of: hot, new, rising, top"
            )
        self.include_nsfw = bool(config.get("include_nsfw", False))
        self.subreddits = self._configured_subreddits(config.get("subreddits", []))
        self._transport = transport
        self._access_token: str | None = None
        self._token_expires_at = 0.0
        self._credential_fingerprint: bytes | None = None
        self._token_lock = asyncio.Lock()

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="fetch_home_feed",
                description=(
                    "Fetch the authenticated operator's Reddit best/home feed (read-only)"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                },
            ),
            ToolDefinition(
                name="fetch_subreddit",
                description="Fetch a public subreddit listing through Reddit OAuth (read-only)",
                parameters={
                    "type": "object",
                    "properties": {
                        "subreddit": {"type": "string"},
                        "listing": {
                            "type": "string",
                            "enum": sorted(_LISTINGS),
                            "default": self.default_listing,
                        },
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    },
                    "required": ["subreddit"],
                },
            ),
            ToolDefinition(
                name="fetch_briefing_posts",
                description=(
                    "Fetch configured subreddit listings, or the authenticated home feed "
                    "when no subreddits are configured"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "fetch_home_feed":
            return await self.fetch_home_feed(**kwargs)
        if method == "fetch_subreddit":
            return await self.fetch_subreddit(**kwargs)
        if method == "fetch_briefing_posts":
            return await self.fetch_briefing_posts(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def fetch_home_feed(self, limit: int = 10) -> CapabilityResult:
        try:
            bounded = self._bounded_limit(limit)
            posts, rate_limit = await self._fetch_listing("/best", bounded)
            return self._success(
                posts,
                feed="home_best",
                rate_limit=rate_limit,
            )
        except RedditProviderError as exc:
            return self._failure(exc)
        except (httpx.HTTPError, OSError):
            return self._transport_failure()

    async def fetch_subreddit(
        self,
        subreddit: str,
        listing: str | None = None,
        limit: int = 10,
    ) -> CapabilityResult:
        try:
            bounded = self._bounded_limit(limit)
            normalized_subreddit = self._validate_subreddit(subreddit)
            normalized_listing = self._validate_listing(listing or self.default_listing)
            posts, rate_limit = await self._fetch_listing(
                f"/r/{normalized_subreddit}/{normalized_listing}", bounded
            )
            return self._success(
                posts,
                feed="subreddit",
                subreddits=[normalized_subreddit],
                listing=normalized_listing,
                rate_limit=rate_limit,
            )
        except RedditProviderError as exc:
            return self._failure(exc)
        except (httpx.HTTPError, OSError):
            return self._transport_failure()

    async def fetch_briefing_posts(self, limit: int = 15) -> CapabilityResult:
        """Collect one bounded source envelope for the scheduled briefing."""
        try:
            bounded = self._bounded_limit(limit)
            if not self.subreddits:
                return await self.fetch_home_feed(limit=bounded)

            # Fail once, clearly, before iterating configured sources when OAuth is absent.
            await self._get_access_token()
            selected_subreddits = self.subreddits[:bounded]
            posts: list[dict[str, Any]] = []
            source_errors: list[dict[str, Any]] = []
            rate_limit: dict[str, int | float] = {}
            successful_requests = 0

            for index, subreddit in enumerate(selected_subreddits):
                remaining = bounded - len(posts)
                if remaining <= 0:
                    break
                remaining_sources = len(selected_subreddits) - index
                per_source = max(1, math.ceil(remaining / remaining_sources))
                try:
                    fetched, current_rate_limit = await self._fetch_listing(
                        f"/r/{subreddit}/{self.default_listing}", per_source
                    )
                    successful_requests += 1
                    posts.extend(fetched[:remaining])
                    rate_limit = current_rate_limit or rate_limit
                except RedditProviderError as exc:
                    if exc.code in {"invalid_credentials", "invalid_token"}:
                        raise
                    source_errors.append(
                        {
                            "subreddit": subreddit,
                            "code": exc.code,
                            "status_code": exc.status_code,
                            "retryable": exc.retryable,
                        }
                    )

            if successful_requests == 0:
                return CapabilityResult(
                    success=False,
                    data={
                        "provider": "reddit",
                        "code": "all_sources_failed",
                        "retryable": any(
                            bool(error.get("retryable")) for error in source_errors
                        ),
                        "status_code": None,
                        "posts": [],
                        "source_errors": source_errors,
                        "trust": "untrusted_external_data",
                    },
                    error="All configured Reddit subreddit listings failed",
                )
            return self._success(
                posts[:bounded],
                feed="configured_subreddits",
                subreddits=selected_subreddits,
                listing=self.default_listing,
                source_errors=source_errors,
                rate_limit=rate_limit,
            )
        except RedditProviderError as exc:
            return self._failure(exc)
        except (httpx.HTTPError, OSError):
            return self._transport_failure()

    async def _fetch_listing(
        self, path: str, limit: int
    ) -> tuple[list[dict[str, Any]], dict[str, int | float]]:
        token = await self._get_access_token()
        try:
            payload, headers = await self._api_get(path, token, limit)
        except RedditProviderError as exc:
            if exc.status_code != 401:
                raise
            token = await self._get_access_token(force_refresh=True)
            payload, headers = await self._api_get(path, token, limit)
        posts = self._normalize_listing(payload, limit)
        return posts, self._rate_limit_status(headers)

    async def _get_access_token(self, *, force_refresh: bool = False) -> str:
        client_id, client_secret, refresh_token, user_agent = self._oauth_settings()
        fingerprint = hashlib.sha256(f"{client_id}\0{refresh_token}".encode()).digest()
        now = time.monotonic()
        if (
            not force_refresh
            and self._access_token
            and self._credential_fingerprint == fingerprint
            and now < self._token_expires_at
        ):
            return self._access_token

        async with self._token_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and self._access_token
                and self._credential_fingerprint == fingerprint
                and now < self._token_expires_at
            ):
                return self._access_token

            payload = await self._token_request(
                client_id,
                client_secret,
                refresh_token,
                user_agent,
            )
            token = payload.get("access_token") if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token.strip() or len(token) > 8192:
                raise RedditProviderError(
                    "invalid_response",
                    "Reddit OAuth returned an invalid token response",
                    retryable=True,
                )
            try:
                ttl = max(30, min(int(payload.get("expires_in", 3600)), 86_400))
            except (TypeError, ValueError):
                ttl = 3600
            safety_margin = min(60, max(5, ttl // 10))
            self._access_token = token.strip()
            self._token_expires_at = time.monotonic() + ttl - safety_margin
            self._credential_fingerprint = fingerprint
            return self._access_token

    async def _token_request(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        user_agent: str,
    ) -> dict[str, Any]:
        async with self._client() as client:
            async with client.stream(
                "POST",
                TOKEN_URL,
                data={"grant_type": "refresh_token", "refresh_token": refresh_token},
                auth=httpx.BasicAuth(client_id, client_secret),
                headers={"Accept": "application/json", "User-Agent": user_agent},
            ) as response:
                body = await self._read_bounded(response)
                if response.is_redirect:
                    raise RedditProviderError(
                        "unexpected_redirect",
                        "Reddit OAuth returned an unexpected redirect",
                        status_code=response.status_code,
                    )
                if response.status_code != 200:
                    raise self._status_error(response.status_code, response.headers, oauth=True)
        return self._decode_object(body, "Reddit OAuth")

    async def _api_get(
        self, path: str, token: str, limit: int
    ) -> tuple[dict[str, Any], httpx.Headers]:
        _, _, _, user_agent = self._oauth_settings()
        url = f"{API_BASE_URL}{path}"
        async with self._client() as client:
            async with client.stream(
                "GET",
                url,
                params={"limit": limit, "raw_json": 1},
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {token}",
                    "User-Agent": user_agent,
                },
            ) as response:
                body = await self._read_bounded(response)
                if response.is_redirect:
                    raise RedditProviderError(
                        "unexpected_redirect",
                        "Reddit API returned an unexpected redirect",
                        status_code=response.status_code,
                    )
                if response.status_code != 200:
                    raise self._status_error(response.status_code, response.headers)
                headers = response.headers
        return self._decode_object(body, "Reddit API"), headers

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=self.timeout_seconds,
            follow_redirects=False,
            transport=self._transport,
        )

    async def _read_bounded(self, response: httpx.Response) -> bytes:
        declared = response.headers.get("content-length")
        if declared:
            try:
                if int(declared) > self.max_response_bytes:
                    raise RedditProviderError(
                        "response_too_large",
                        "Reddit returned a response larger than MRE permits",
                    )
            except ValueError as exc:
                raise RedditProviderError(
                    "invalid_response",
                    "Reddit returned an invalid Content-Length header",
                    retryable=True,
                ) from exc
        content = bytearray()
        async for chunk in response.aiter_bytes():
            content.extend(chunk)
            if len(content) > self.max_response_bytes:
                raise RedditProviderError(
                    "response_too_large",
                    "Reddit returned a response larger than MRE permits",
                )
        return bytes(content)

    @staticmethod
    def _decode_object(body: bytes, provider: str) -> dict[str, Any]:
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RedditProviderError(
                "invalid_response",
                f"{provider} returned invalid JSON",
                retryable=True,
            ) from exc
        if not isinstance(payload, dict):
            raise RedditProviderError(
                "invalid_response",
                f"{provider} returned an unexpected response shape",
                retryable=True,
            )
        return payload

    @staticmethod
    def _status_error(
        status_code: int,
        headers: httpx.Headers,
        *,
        oauth: bool = False,
    ) -> RedditProviderError:
        retry_after = RedditCapability._retry_after(headers)
        if status_code == 401 or (oauth and status_code == 400):
            return RedditProviderError(
                "invalid_credentials" if oauth else "invalid_token",
                (
                    "Reddit rejected the configured OAuth credentials"
                    if oauth
                    else "Reddit rejected the OAuth access token"
                ),
                status_code=status_code,
            )
        if status_code == 403:
            return RedditProviderError(
                "access_denied",
                "Reddit denied this read request; verify the refresh token's scopes",
                status_code=status_code,
            )
        if status_code == 404:
            return RedditProviderError(
                "not_found",
                "The requested Reddit listing was not found or is not accessible",
                status_code=status_code,
            )
        if status_code == 429:
            return RedditProviderError(
                "rate_limited",
                "Reddit rate-limited MRE; retry after the provider window resets",
                retryable=True,
                status_code=status_code,
                retry_after_seconds=retry_after,
            )
        if status_code >= 500:
            return RedditProviderError(
                "provider_unavailable",
                "Reddit is temporarily unavailable",
                retryable=True,
                status_code=status_code,
                retry_after_seconds=retry_after,
            )
        return RedditProviderError(
            "provider_error",
            f"Reddit request failed with HTTP {status_code}",
            status_code=status_code,
        )

    def _normalize_listing(
        self, payload: dict[str, Any], limit: int
    ) -> list[dict[str, Any]]:
        listing_data = payload.get("data")
        children = listing_data.get("children") if isinstance(listing_data, dict) else None
        if not isinstance(children, list):
            raise RedditProviderError(
                "invalid_response",
                "Reddit returned an unexpected listing response",
                retryable=True,
            )

        posts: list[dict[str, Any]] = []
        for child in children:
            if len(posts) >= limit:
                break
            if not isinstance(child, dict) or child.get("kind") != "t3":
                continue
            raw = child.get("data")
            if not isinstance(raw, dict):
                continue
            over_18 = bool(raw.get("over_18", False))
            if over_18 and not self.include_nsfw:
                continue
            post = self._normalize_post(raw)
            if post is not None:
                posts.append(post)
        return posts

    @staticmethod
    def _normalize_post(raw: dict[str, Any]) -> dict[str, Any] | None:
        post_id = RedditCapability._text(raw.get("id"), 32)
        title = RedditCapability._text(html.unescape(str(raw.get("title") or "")), 500)
        subreddit = RedditCapability._text(raw.get("subreddit"), 64)
        permalink = RedditCapability._text(raw.get("permalink"), 2048)
        if not post_id or not title or not subreddit or not permalink:
            return None
        if not permalink.startswith("/") or permalink.startswith("//"):
            return None
        canonical_url = f"{PUBLIC_BASE_URL}{permalink}"
        try:
            created_utc = float(raw.get("created_utc"))
            published_at = datetime.fromtimestamp(created_utc, tz=UTC).isoformat()
        except (TypeError, ValueError, OSError, OverflowError):
            published_at = None
        external_url = RedditCapability._public_link(
            raw.get("url_overridden_by_dest") or raw.get("url")
        )
        return {
            "id": post_id,
            "title": title,
            "subreddit": subreddit,
            "source": f"r/{subreddit}",
            "author": RedditCapability._text(raw.get("author"), 128),
            "score": RedditCapability._safe_int(raw.get("score")),
            "num_comments": RedditCapability._safe_int(raw.get("num_comments")),
            "published_at": published_at,
            "url": canonical_url,
            "external_url": external_url if external_url != canonical_url else None,
            "is_self": bool(raw.get("is_self", False)),
            "over_18": bool(raw.get("over_18", False)),
            "spoiler": bool(raw.get("spoiler", False)),
            "selftext_excerpt": RedditCapability._text(raw.get("selftext"), 1000),
            "trust": "untrusted_external_data",
        }

    def _oauth_settings(self) -> tuple[str, str, str, str]:
        names = (
            self.client_id_env,
            self.client_secret_env,
            self.refresh_token_env,
            self.user_agent_env,
        )
        values = tuple(os.environ.get(name, "").strip() for name in names)
        missing = [name for name, value in zip(names, values, strict=True) if not value]
        if missing:
            raise RedditProviderError(
                "not_configured",
                "Reddit OAuth is not configured; set " + ", ".join(missing),
            )
        client_id, client_secret, refresh_token, user_agent = values
        if any(character in user_agent for character in "\r\n") or len(user_agent) > 256:
            raise RedditProviderError(
                "invalid_configuration",
                f"{self.user_agent_env} must be a single line of at most 256 characters",
            )
        return client_id, client_secret, refresh_token, user_agent

    def _bounded_limit(self, value: Any) -> int:
        try:
            limit = int(value)
        except (TypeError, ValueError) as exc:
            raise RedditProviderError(
                "invalid_request", "Reddit result limit must be an integer"
            ) from exc
        return max(1, min(limit, self.max_results, HARD_MAX_RESULTS))

    @staticmethod
    def _validate_subreddit(value: Any) -> str:
        normalized = str(value).strip()
        if normalized.lower().startswith("r/"):
            normalized = normalized[2:]
        if not _SUBREDDIT_NAME.fullmatch(normalized):
            raise RedditProviderError(
                "invalid_request",
                "Subreddit names may contain only letters, numbers, and underscores",
            )
        return normalized

    @staticmethod
    def _validate_listing(value: Any) -> str:
        listing = str(value).lower().strip()
        if listing not in _LISTINGS:
            raise RedditProviderError(
                "invalid_request",
                "Reddit listing must be one of: hot, new, rising, top",
            )
        return listing

    @staticmethod
    def _configured_subreddits(value: Any) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("reddit.subreddits must be a list")
        subreddits: list[str] = []
        seen: set[str] = set()
        for raw in value:
            normalized = str(raw).strip()
            if normalized.lower().startswith("r/"):
                normalized = normalized[2:]
            if not _SUBREDDIT_NAME.fullmatch(normalized):
                raise ValueError(f"Invalid configured subreddit name: {normalized!r}")
            folded = normalized.casefold()
            if folded not in seen:
                seen.add(folded)
                subreddits.append(normalized)
            if len(subreddits) > 20:
                raise ValueError("reddit.subreddits supports at most 20 entries")
        return subreddits

    @staticmethod
    def _text(value: Any, limit: int) -> str | None:
        if value is None:
            return None
        normalized = " ".join(str(value).split()).strip()
        return normalized[:limit] if normalized else None

    @staticmethod
    def _safe_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _public_link(value: Any) -> str | None:
        text = RedditCapability._text(value, 4096)
        if not text:
            return None
        try:
            parsed = urlsplit(text)
            if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
                return None
            if parsed.username or parsed.password:
                return None
            port = f":{parsed.port}" if parsed.port is not None else ""
        except ValueError:
            return None
        return urlunsplit(
            (parsed.scheme.lower(), f"{parsed.hostname.lower()}{port}", parsed.path, "", "")
        )[:2048]

    @staticmethod
    def _retry_after(headers: httpx.Headers) -> int | None:
        value = headers.get("retry-after")
        if value is None:
            return None
        try:
            return max(0, min(int(float(value)), 86_400))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _rate_limit_status(headers: httpx.Headers) -> dict[str, int | float]:
        status: dict[str, int | float] = {}
        for header, name in (
            ("x-ratelimit-remaining", "remaining"),
            ("x-ratelimit-used", "used"),
            ("x-ratelimit-reset", "reset_seconds"),
        ):
            value = headers.get(header)
            if value is None:
                continue
            try:
                status[name] = max(0.0, float(value))
            except ValueError:
                continue
        return status

    @staticmethod
    def _success(
        posts: list[dict[str, Any]],
        *,
        feed: str,
        subreddits: list[str] | None = None,
        listing: str | None = None,
        source_errors: list[dict[str, Any]] | None = None,
        rate_limit: dict[str, int | float] | None = None,
    ) -> CapabilityResult:
        return CapabilityResult(
            success=True,
            data={
                "provider": "reddit",
                "feed": feed,
                "subreddits": subreddits or [],
                "listing": listing,
                "count": len(posts),
                "posts": posts,
                "source_errors": source_errors or [],
                "rate_limit": rate_limit or {},
                "trust": "untrusted_external_data",
            },
        )

    @staticmethod
    def _failure(exc: RedditProviderError) -> CapabilityResult:
        data: dict[str, Any] = {
            "provider": "reddit",
            "code": exc.code,
            "retryable": exc.retryable,
            "status_code": exc.status_code,
            "posts": [],
            "trust": "untrusted_external_data",
        }
        if exc.retry_after_seconds is not None:
            data["retry_after_seconds"] = exc.retry_after_seconds
        return CapabilityResult(success=False, data=data, error=str(exc))

    @staticmethod
    def _transport_failure() -> CapabilityResult:
        return CapabilityResult(
            success=False,
            data={
                "provider": "reddit",
                "code": "transport_error",
                "retryable": True,
                "status_code": None,
                "posts": [],
                "trust": "untrusted_external_data",
            },
            error="Reddit transport failed; retry later",
        )
