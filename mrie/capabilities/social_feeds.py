"""YouTube and Instagram social feed capabilities."""

from __future__ import annotations

import os
from typing import Any

import httpx

from mrie.core.capability_base import Capability, CapabilityResult, ToolDefinition


class YouTubeCapability(Capability):
    name = "social"
    description = "YouTube subscriptions and recent videos"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.api_key_env = config.get("api_key_env", "YOUTUBE_API_KEY")
        self.oauth_token_env = config.get("oauth_token_env", "YOUTUBE_OAUTH_TOKEN")
        self.channel_limit = int(config.get("channel_limit", 50))

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="list_subscriptions",
                description="List YouTube channel subscriptions",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="fetch_recent_videos",
                description="Fetch recent videos from subscribed channels",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 5}},
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "list_subscriptions":
            return await self.list_subscriptions()
        if method == "fetch_recent_videos":
            return await self.fetch_recent_videos(**kwargs)
        return CapabilityResult(success=False, error=f"Unknown method: {method}")

    async def list_subscriptions(self) -> CapabilityResult:
        token = os.environ.get(self.oauth_token_env)
        if not token:
            return CapabilityResult(
                success=False,
                error=f"{self.oauth_token_env} not configured; subscriptions require OAuth",
            )
        subscriptions: list[dict[str, Any]] = []
        page_token: str | None = None
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                while len(subscriptions) < self.channel_limit:
                    params = {
                        "part": "snippet,contentDetails",
                        "mine": "true",
                        "maxResults": min(50, self.channel_limit - len(subscriptions)),
                    }
                    if page_token:
                        params["pageToken"] = page_token
                    response = await client.get(
                        "https://www.googleapis.com/youtube/v3/subscriptions",
                        params=params,
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    response.raise_for_status()
                    payload = response.json()
                    for item in payload.get("items", []):
                        snippet = item.get("snippet") or {}
                        subscriptions.append(
                            {
                                "channel_id": (snippet.get("resourceId") or {}).get("channelId"),
                                "title": snippet.get("title"),
                            }
                        )
                    page_token = payload.get("nextPageToken")
                    if not page_token:
                        break
            return CapabilityResult(
                success=True,
                data={"subscriptions": subscriptions, "count": len(subscriptions)},
            )
        except httpx.HTTPError as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def fetch_recent_videos(self, limit: int = 5) -> CapabilityResult:
        token = os.environ.get(self.oauth_token_env)
        if not token:
            return CapabilityResult(
                success=False,
                error=f"{self.oauth_token_env} not configured; feed access requires OAuth",
            )
        bounded = max(1, min(int(limit), 50))
        subscriptions = await self.list_subscriptions()
        if not subscriptions.success:
            return subscriptions
        channel_ids = [
            item.get("channel_id")
            for item in subscriptions.data.get("subscriptions", [])
            if item.get("channel_id")
        ]
        videos: list[dict[str, Any]] = []
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                for channel_id in channel_ids:
                    channel_response = await client.get(
                        "https://www.googleapis.com/youtube/v3/channels",
                        params={"part": "contentDetails", "id": channel_id},
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    channel_response.raise_for_status()
                    channels = channel_response.json().get("items", [])
                    if not channels:
                        continue
                    uploads = (
                        channels[0]
                        .get("contentDetails", {})
                        .get("relatedPlaylists", {})
                        .get("uploads")
                    )
                    if not uploads:
                        continue
                    video_response = await client.get(
                        "https://www.googleapis.com/youtube/v3/playlistItems",
                        params={
                            "part": "snippet,contentDetails",
                            "playlistId": uploads,
                            "maxResults": min(5, bounded),
                        },
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    video_response.raise_for_status()
                    for item in video_response.json().get("items", []):
                        snippet = item.get("snippet") or {}
                        video_id = (item.get("contentDetails") or {}).get("videoId")
                        videos.append(
                            {
                                "video_id": video_id,
                                "title": snippet.get("title"),
                                "channel": snippet.get("videoOwnerChannelTitle")
                                or snippet.get("channelTitle"),
                                "published_at": snippet.get("publishedAt"),
                                "url": f"https://www.youtube.com/watch?v={video_id}"
                                if video_id
                                else None,
                            }
                        )
            videos.sort(key=lambda item: item.get("published_at") or "", reverse=True)
            return CapabilityResult(success=True, data={"videos": videos[:bounded]})
        except httpx.HTTPError as exc:
            return CapabilityResult(success=False, error=str(exc))


class InstagramCapability(Capability):
    """Official-API boundary; consumer home-feed scraping is intentionally unsupported."""

    name = "instagram"
    description = "Instagram follows and recent posts"

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.feed_urls = config.get("feed_urls", [])
        self.access_token_env = str(
            config.get("access_token_env", "INSTAGRAM_ACCESS_TOKEN")
        )

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="fetch_recent_posts",
                description="Fetch recent posts from configured Instagram feed URLs",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 10}},
                },
            ),
        ]

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        if method == "fetch_recent_posts":
            configured = bool(os.environ.get(self.access_token_env, "").strip())
            return CapabilityResult(
                success=False,
                data={
                    "posts": [],
                    "provider": "instagram",
                    "code": "unsupported_consumer_feed" if configured else "not_configured",
                    "retryable": False,
                },
                error=(
                    "Instagram consumer home-feed collection is not available through the "
                    "official API; use an authorized professional-account source or shared URLs"
                    if configured
                    else f"Instagram is not configured; set {self.access_token_env} only for "
                    "an authorized professional-account integration"
                ),
            )
        return CapabilityResult(success=False, error=f"Unknown method: {method}")
