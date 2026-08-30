from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from mrie.core.capability_base import CapabilityResult
from mrie.core.event_bus import NotableEvent
from mrie.core.ipc_server import IPCServer
from mrie.core.orchestrator import MRIEOrchestrator

PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.asyncio
async def test_newline_json_rpc_ping_round_trip() -> None:
    server = IPCServer(MRIEOrchestrator(PROJECT_ROOT), port=0)
    await server.start()
    assert server._server is not None
    socket = server._server.sockets[0]
    host, port = socket.getsockname()[:2]

    reader, writer = await asyncio.open_connection(host, port)
    writer.write(b'{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}\n')
    await writer.drain()
    response = json.loads((await reader.readline()).decode("utf-8"))
    writer.close()
    await writer.wait_closed()
    await server.stop()

    assert response == {"jsonrpc": "2.0", "id": 7, "result": {"pong": True}}


@pytest.mark.asyncio
async def test_events_subscribe_receives_pushed_events() -> None:
    orchestrator = MRIEOrchestrator(PROJECT_ROOT)
    server = IPCServer(orchestrator, port=0)
    await server.start()
    assert server._server is not None
    socket = server._server.sockets[0]
    host, port = socket.getsockname()[:2]

    reader, writer = await asyncio.open_connection(host, port)
    writer.write(b'{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{}}\n')
    await writer.drain()
    ack = json.loads((await reader.readline()).decode("utf-8"))
    assert ack == {"jsonrpc": "2.0", "id": 1, "result": {"subscribed": True}}

    event = NotableEvent.now(
        source="wazuh",
        source_event_id="test-1",
        severity="urgent",
        title="Test alert",
        detail="detail",
    )
    await orchestrator.event_bus.publish(event)

    pushed = json.loads(await asyncio.wait_for(reader.readline(), timeout=2))
    writer.close()
    await writer.wait_closed()
    await server.stop()

    assert pushed["method"] == "event.notify"
    assert pushed["params"]["title"] == "Test alert"


@pytest.mark.asyncio
async def test_events_recent_returns_history() -> None:
    orchestrator = MRIEOrchestrator(PROJECT_ROOT)
    await orchestrator.event_bus.publish(
        NotableEvent.now(
            source="honeypot",
            source_event_id="test-2",
            severity="warning",
            title="Probe seen",
            detail="detail",
        )
    )
    server = IPCServer(orchestrator, port=0)
    await server.start()
    assert server._server is not None
    socket = server._server.sockets[0]
    host, port = socket.getsockname()[:2]

    reader, writer = await asyncio.open_connection(host, port)
    writer.write(b'{"jsonrpc":"2.0","id":2,"method":"events.recent","params":{"limit":10}}\n')
    await writer.drain()
    response = json.loads((await reader.readline()).decode("utf-8"))
    writer.close()
    await writer.wait_closed()
    await server.stop()

    assert response["result"]["events"][0]["title"] == "Probe seen"


@pytest.mark.asyncio
async def test_briefings_list_returns_sanitized_durable_history(tmp_path: Path) -> None:
    orchestrator = MRIEOrchestrator(PROJECT_ROOT)
    orchestrator.scheduler.history.path = tmp_path / "briefings.sqlite3"
    orchestrator.scheduler.history._initialize()
    orchestrator.scheduler.history.append(
        {
            "timestamp": "2026-08-12T13:00:00+00:00",
            "dry_run": False,
            "successful": True,
            "summary": "A saved briefing",
            "model_error": None,
            "window_start": "2026-08-12T05:00:00+00:00",
            "window_end": "2026-08-12T13:00:00+00:00",
            "next_run": "2026-08-12T21:00:00-04:00",
            "collected": {
                "sources": {
                    "news": {
                        "success": True,
                        "data": {
                            "headlines": [
                                {
                                    "title": "Citable report",
                                    "link": "https://example.test/report",
                                    "published": "2026-08-12T12:00:00Z",
                                    "source": "Example Wire",
                                    "raw": "not public",
                                }
                            ]
                        },
                        "error": None,
                    }
                }
            },
        }
    )
    server = IPCServer(orchestrator, port=0)

    response = await server.handle_request(
        {"jsonrpc": "2.0", "id": 3, "method": "briefings.list", "params": {"limit": 10}}
    )

    record = response["result"]["briefings"][0]
    assert record["summary"] == "A saved briefing"
    assert record["sources"]["news"]["count"] == 1
    assert record["windowStart"] == "2026-08-12T05:00:00+00:00"
    assert record["sources"]["news"]["evidence"] == [
        {
            "kind": "content",
            "title": "Citable report",
            "url": "https://example.test/report",
            "published": "2026-08-12T12:00:00Z",
            "source": "Example Wire",
        }
    ]
    assert "collected" not in record
    assert "not public" not in str(record)


@pytest.mark.asyncio
async def test_manual_briefing_returns_busy_snapshot_without_waiting() -> None:
    orchestrator = MRIEOrchestrator(PROJECT_ROOT)
    orchestrator.scheduler._active_run = {  # noqa: SLF001 - exercise public IPC snapshot
        "kind": "scheduled",
        "phase": "generating",
        "started_at": "2026-08-12T17:00:00+00:00",
        "scheduled_slot": "2026-08-12T13:00:00-04:00",
    }
    server = IPCServer(orchestrator, port=0)

    response = await server.handle_request(
        {"jsonrpc": "2.0", "id": 4, "method": "briefings.run", "params": {}}
    )

    assert response["result"]["busy"] is True
    assert response["result"]["briefing"] is None
    assert response["result"]["scheduler"]["active_run"]["phase"] == "generating"


@pytest.mark.asyncio
async def test_news_test_collects_sources_without_model_or_speech() -> None:
    orchestrator = MRIEOrchestrator(PROJECT_ROOT)
    capability = orchestrator.registry.get("news")
    reddit_capability = orchestrator.registry.get("reddit")
    assert capability is not None
    assert reddit_capability is not None
    calls: list[tuple[str, dict[str, object]]] = []
    reddit_calls: list[tuple[str, dict[str, object]]] = []

    async def invoke(method: str, **kwargs: object) -> CapabilityResult:
        calls.append((method, kwargs))
        if method == "fetch_headlines":
            return CapabilityResult(
                success=True,
                data={
                    "headlines": [
                        {
                            "title": "A live headline",
                            "link": "https://example.com/live",
                        }
                    ],
                    "feed_statuses": [
                        {
                            "source": "https://example.com/rss",
                            "resolved_url": "https://example.com/rss",
                            "success": True,
                            "headline_count": 1,
                            "error": None,
                        }
                    ],
                },
            )
        return CapabilityResult(
            success=False,
            data={"provider": "newsapi", "code": "not_configured", "retryable": False},
            error="NewsAPI is not configured",
        )

    capability.invoke = invoke  # type: ignore[method-assign]

    async def invoke_reddit(method: str, **kwargs: object) -> CapabilityResult:
        reddit_calls.append((method, kwargs))
        return CapabilityResult(
            success=True,
            data={
                "provider": "reddit",
                "feed": "home_best",
                "posts": [
                    {
                        "title": "A Reddit source",
                        "url": "https://www.reddit.com/r/netsec/comments/abc/source/",
                    }
                ],
            },
        )

    reddit_capability.invoke = invoke_reddit  # type: ignore[method-assign]
    server = IPCServer(orchestrator, port=0)

    response = await server.handle_request(
        {"jsonrpc": "2.0", "id": 5, "method": "news.test", "params": {"limit": 999}}
    )

    result = response["result"]
    assert result["model_used"] is False
    assert result["speech_used"] is False
    assert result["sources"]["rss"]["headline_count"] == 1
    assert result["sources"]["newsapi"]["configured"] is False
    assert result["sources"]["reddit"]["configured"] is True
    assert result["sources"]["reddit"]["post_count"] == 1
    assert calls == [
        ("fetch_headlines", {"limit": 25}),
        ("search_topic", {"query": "latest news", "limit": 10}),
    ]
    assert reddit_calls == [("fetch_briefing_posts", {"limit": 10})]
