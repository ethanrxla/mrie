from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from mrie.capabilities import build_default_registry
from mrie.capabilities.reddit import RedditCapability
from mrie.scheduler.briefing_store import public_briefing_record


def configure_reddit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDDIT_CLIENT_ID", "test-client")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("REDDIT_REFRESH_TOKEN", "test-refresh-token")
    monkeypatch.setenv(
        "REDDIT_USER_AGENT", "windows:mre-test-suite:0.1 (by /u/mre_test)"
    )


def listing(*posts: dict[str, Any]) -> dict[str, Any]:
    children = [{"kind": "t3", "data": post} for post in posts]
    return {"kind": "Listing", "data": {"children": children}}


def sample_post(post_id: str = "abc123", **changes: Any) -> dict[str, Any]:
    post: dict[str, Any] = {
        "id": post_id,
        "title": "A useful security discussion",
        "subreddit": "cybersecurity",
        "author": "example_author",
        "score": 42,
        "num_comments": 7,
        "created_utc": 1_700_000_000,
        "permalink": f"/r/cybersecurity/comments/{post_id}/useful_discussion/",
        "url": "https://example.org/article?tracking=removed",
        "is_self": False,
        "over_18": False,
        "spoiler": False,
        "selftext": "Treat this text as untrusted external content.",
    }
    post.update(changes)
    return post


@pytest.mark.asyncio
async def test_reddit_fails_truthfully_when_oauth_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "REDDIT_CLIENT_ID",
        "REDDIT_CLIENT_SECRET",
        "REDDIT_REFRESH_TOKEN",
        "REDDIT_USER_AGENT",
    ):
        monkeypatch.delenv(name, raising=False)

    result = await RedditCapability({}).fetch_home_feed()

    assert result.success is False
    assert result.data["code"] == "not_configured"
    assert result.data["posts"] == []
    assert "REDDIT_CLIENT_ID" in result.error
    assert "REDDIT_REFRESH_TOKEN" in result.error


@pytest.mark.asyncio
async def test_home_feed_uses_oauth_bounds_results_and_reuses_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_reddit(monkeypatch)
    calls = {"token": 0, "listing": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == httpx.URL("https://www.reddit.com/api/v1/access_token"):
            calls["token"] += 1
            assert request.method == "POST"
            assert request.headers["authorization"].startswith("Basic ")
            assert b"test-refresh-token" in request.content
            return httpx.Response(
                200, json={"access_token": "temporary-access-token", "expires_in": 3600}
            )

        calls["listing"] += 1
        assert request.url.host == "oauth.reddit.com"
        assert request.url.path == "/best"
        assert request.url.params["limit"] == "50"
        assert request.headers["authorization"] == "Bearer temporary-access-token"
        return httpx.Response(
            200,
            json=listing(
                sample_post("nsfw", over_18=True),
                sample_post(),
            ),
            headers={
                "x-ratelimit-remaining": "99.0",
                "x-ratelimit-used": "1",
                "x-ratelimit-reset": "600",
            },
        )

    capability = RedditCapability({}, transport=httpx.MockTransport(handler))
    first = await capability.fetch_home_feed(limit=999)
    second = await capability.fetch_home_feed(limit=999)

    assert first.success is True
    assert first.data["feed"] == "home_best"
    assert first.data["count"] == 1
    assert first.data["rate_limit"]["remaining"] == 99.0
    assert first.data["posts"][0]["url"] == (
        "https://www.reddit.com/r/cybersecurity/comments/abc123/useful_discussion/"
    )
    assert first.data["posts"][0]["external_url"] == "https://example.org/article"
    assert first.data["posts"][0]["trust"] == "untrusted_external_data"
    assert second.success is True
    assert calls == {"token": 1, "listing": 2}


@pytest.mark.asyncio
async def test_expired_access_token_is_refreshed_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_reddit(monkeypatch)
    token_count = 0
    listing_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_count, listing_count
        if request.url.host == "www.reddit.com":
            token_count += 1
            return httpx.Response(
                200,
                json={"access_token": f"access-{token_count}", "expires_in": 3600},
            )
        listing_count += 1
        if listing_count == 1:
            return httpx.Response(401, json={"message": "expired"})
        assert request.headers["authorization"] == "Bearer access-2"
        return httpx.Response(200, json=listing(sample_post()))

    capability = RedditCapability({}, transport=httpx.MockTransport(handler))
    result = await capability.fetch_home_feed()

    assert result.success is True
    assert token_count == 2
    assert listing_count == 2


@pytest.mark.asyncio
async def test_provider_error_body_and_credentials_are_never_exposed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_reddit(monkeypatch)
    secret_marker = "server-echoed-test-client-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            content=json.dumps({"error": secret_marker}).encode(),
        )

    capability = RedditCapability({}, transport=httpx.MockTransport(handler))
    result = await capability.fetch_home_feed()

    assert result.success is False
    assert result.data["code"] == "invalid_credentials"
    serialized = json.dumps(result.to_dict())
    assert secret_marker not in serialized
    assert "test-client-secret" not in serialized
    assert "test-refresh-token" not in serialized


@pytest.mark.asyncio
async def test_configured_subreddits_are_combined_with_partial_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_reddit(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.reddit.com":
            return httpx.Response(
                200, json={"access_token": "access", "expires_in": 3600}
            )
        if request.url.path.startswith("/r/netsec/"):
            return httpx.Response(503, json={"error": "temporarily unavailable"})
        assert request.url.path == "/r/cybersecurity/new"
        return httpx.Response(
            200,
            json=listing(sample_post(subreddit="cybersecurity")),
        )

    capability = RedditCapability(
        {"subreddits": ["netsec", "r/cybersecurity"], "listing": "new"},
        transport=httpx.MockTransport(handler),
    )
    result = await capability.fetch_briefing_posts(limit=4)

    assert result.success is True
    assert result.data["feed"] == "configured_subreddits"
    assert result.data["subreddits"] == ["netsec", "cybersecurity"]
    assert result.data["count"] == 1
    assert result.data["source_errors"] == [
        {
            "subreddit": "netsec",
            "code": "provider_unavailable",
            "status_code": 503,
            "retryable": True,
        }
    ]


def test_reddit_is_read_only_registered_and_persists_citation_evidence(
    tmp_path: Path,
) -> None:
    registry = build_default_registry({}, tmp_path)
    capability = registry.get("reddit")
    assert capability is not None
    assert capability.list_methods() == [
        "fetch_home_feed",
        "fetch_subreddit",
        "fetch_briefing_posts",
    ]
    assert not {
        "create_post",
        "comment",
        "vote",
        "delete",
        "subscribe",
    }.intersection(capability.list_methods())

    record = public_briefing_record(
        {
            "timestamp": "2026-08-13T12:00:00+00:00",
            "dry_run": True,
            "collected": {
                "sources": {
                    "reddit": {
                        "success": True,
                        "data": {"posts": [RedditCapability._normalize_post(sample_post())]},
                    }
                }
            },
        }
    )
    assert record["sources"]["reddit"]["count"] == 1
    assert record["sources"]["reddit"]["evidence"] == [
        {
            "kind": "content",
            "title": "A useful security discussion",
            "url": "https://www.reddit.com/r/cybersecurity/comments/abc123/useful_discussion/",
            "published": "2023-11-14T22:13:20+00:00",
            "source": "r/cybersecurity",
        }
    ]
