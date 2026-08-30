"""JSON-RPC 2.0 IPC server for Rust TUI communication."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from mrie.core.orchestrator import MRIEOrchestrator

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17351


class IPCServer:
    """Async TCP JSON-RPC server exposing MRE orchestrator methods."""

    def __init__(
        self,
        orchestrator: MRIEOrchestrator,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
    ) -> None:
        self.orchestrator = orchestrator
        self.host = host
        self.port = port
        self._server: asyncio.AbstractServer | None = None

    async def handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        try:
            result = await self._dispatch(method, params)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as exc:  # noqa: BLE001 — surface errors to TUI
            logger.exception("IPC error on %s", method)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(exc)},
            }

    async def _dispatch(self, method: str | None, params: dict[str, Any]) -> Any:
        if method == "ping":
            return {"pong": True}
        if method == "status":
            return self.orchestrator.get_status()
        if method == "ask":
            message = params.get("message", "")
            provider = params.get("provider")
            session_id = str(params.get("session_id", "default"))
            response = await self.orchestrator.ask(
                message,
                provider=provider,
                session_id=session_id,
            )
            return {"response": response, "session_id": session_id}
        if method == "briefing":
            dry_run = bool(params.get("dry_run", False))
            return await self.orchestrator.run_briefing(dry_run=dry_run)
        if method == "briefings.list":
            limit = max(1, min(int(params.get("limit", 20)), 100))
            return {
                "briefings": self.orchestrator.scheduler.list_history(limit=limit),
                "scheduler": self.orchestrator.scheduler.get_status(),
            }
        if method == "briefings.run":
            dry_run = bool(params.get("dry_run", False))
            current_status = self.orchestrator.scheduler.get_status()
            if current_status.get("active_run") is not None:
                return {
                    "briefing": None,
                    "scheduler": current_status,
                    "busy": True,
                }
            result = await self.orchestrator.run_briefing(dry_run=dry_run)
            records = self.orchestrator.scheduler.list_history(limit=1)
            return {
                "briefing": records[0] if records else None,
                "scheduler": self.orchestrator.scheduler.get_status(),
                "run_id": result.get("id"),
                "busy": False,
            }
        if method == "news.test":
            capability = self.orchestrator.registry.get("news")
            if capability is None:
                raise ValueError("News capability is unavailable")
            limit = max(1, min(int(params.get("limit", 10)), 25))
            query = str(params.get("query", "latest news")).strip() or "latest news"

            rss_result = await capability.invoke("fetch_headlines", limit=limit)
            rss_data = rss_result.data if isinstance(rss_result.data, dict) else {}
            headlines = rss_data.get("headlines", [])
            if not isinstance(headlines, list):
                headlines = []
            feed_statuses = rss_data.get("feed_statuses", [])
            if not isinstance(feed_statuses, list):
                feed_statuses = []

            newsapi_result = await capability.invoke(
                "search_topic", query=query, limit=min(limit, 10)
            )
            newsapi_data = (
                newsapi_result.data if isinstance(newsapi_result.data, dict) else {}
            )
            articles = newsapi_data.get("articles", [])
            if not isinstance(articles, list):
                articles = []
            newsapi_code = str(newsapi_data.get("code", ""))

            reddit_capability = self.orchestrator.registry.get("reddit")
            if reddit_capability is None:
                reddit_success = False
                reddit_data: dict[str, Any] = {
                    "code": "capability_unavailable",
                    "posts": [],
                }
                reddit_error = "Reddit capability is unavailable"
            else:
                reddit_result = await reddit_capability.invoke(
                    "fetch_briefing_posts", limit=min(limit, 10)
                )
                reddit_success = reddit_result.success
                reddit_data = (
                    reddit_result.data if isinstance(reddit_result.data, dict) else {}
                )
                reddit_error = reddit_result.error
            reddit_posts = reddit_data.get("posts", [])
            if not isinstance(reddit_posts, list):
                reddit_posts = []
            reddit_code = str(reddit_data.get("code", ""))

            return {
                "tested_at": datetime.now(UTC).isoformat(),
                "model_used": False,
                "speech_used": False,
                "sources": {
                    "rss": {
                        "success": rss_result.success,
                        "headline_count": len(headlines),
                        "headlines": headlines,
                        "feeds": feed_statuses,
                        "error": rss_result.error,
                    },
                    "newsapi": {
                        "configured": newsapi_code != "not_configured",
                        "success": newsapi_result.success,
                        "article_count": len(articles),
                        "articles": articles,
                        "code": newsapi_code or None,
                        "retryable": bool(newsapi_data.get("retryable", False)),
                        "error": newsapi_result.error,
                    },
                    "reddit": {
                        "configured": reddit_code
                        not in {"not_configured", "capability_unavailable"},
                        "success": reddit_success,
                        "post_count": len(reddit_posts),
                        "posts": reddit_posts,
                        "feed": reddit_data.get("feed"),
                        "subreddits": reddit_data.get("subreddits", []),
                        "code": reddit_code or None,
                        "retryable": bool(reddit_data.get("retryable", False)),
                        "error": reddit_error,
                    },
                },
            }
        if method == "security.events":
            capability = self.orchestrator.registry.get("wazuh")
            if capability is None:
                raise ValueError("Wazuh capability is unavailable")
            result = await capability.invoke(
                "recent_events",
                limit=max(1, min(int(params.get("limit", 100)), 500)),
                minimum_severity=max(
                    0, min(int(params.get("minimum_severity", 0)), 4)
                ),
            )
            return result.to_dict()
        if method == "security.status":
            checked_at = datetime.now(UTC).isoformat()
            wazuh_capability = self.orchestrator.registry.get("wazuh")
            if wazuh_capability is None:
                wazuh_status: dict[str, Any] = {
                    "state": "unavailable",
                    "checked_at": checked_at,
                    "manager": {"state": "unavailable", "error": "Capability unavailable"},
                    "indexer": {"state": "unavailable", "error": "Capability unavailable"},
                }
            else:
                wazuh_result = await wazuh_capability.invoke("connection_status")
                wazuh_status = (
                    wazuh_result.data
                    if wazuh_result.success and isinstance(wazuh_result.data, dict)
                    else {
                        "state": "error",
                        "checked_at": checked_at,
                        "manager": {"state": "error", "error": "Probe failed"},
                        "indexer": {"state": "error", "error": "Probe failed"},
                    }
                )

            honeypot_capability = self.orchestrator.registry.get("honeypot")
            if honeypot_capability is None:
                honeypot_status = {
                    "state": "unavailable",
                    "enabled": False,
                    "sensor_count": 0,
                    "mode": "passive-observation-only",
                    "error": "Capability unavailable",
                }
            else:
                honeypot_result = await honeypot_capability.invoke("status")
                if not honeypot_result.success or not isinstance(
                    honeypot_result.data, dict
                ):
                    honeypot_status = {
                        "state": "error",
                        "enabled": False,
                        "sensor_count": 0,
                        "mode": "passive-observation-only",
                        "error": "Honeypot capability status probe failed",
                    }
                else:
                    honeypot_data = honeypot_result.data
                    sensors = honeypot_data.get("sensors", [])
                    sensor_count = len(sensors) if isinstance(sensors, list) else 0
                    enabled = honeypot_data.get("enabled") is True
                    honeypot_status = {
                        "state": "configured" if enabled else "disabled",
                        "enabled": enabled,
                        "sensor_count": sensor_count,
                        "mode": "passive-observation-only",
                        "error": None,
                    }
            return {
                "checked_at": checked_at,
                "wazuh": wazuh_status,
                "honeypot": honeypot_status,
            }
        if method == "security.sync":
            capability = self.orchestrator.registry.get("wazuh")
            if capability is None:
                raise ValueError("Wazuh capability is unavailable")
            result = await capability.invoke(
                "sync_alerts",
                limit=int(params.get("limit", 200)),
                minimum_level=int(params.get("minimum_level", 3)),
            )
            return result.to_dict()
        if method == "honeypot.events":
            capability = self.orchestrator.registry.get("honeypot")
            if capability is None:
                raise ValueError("Honeypot capability is unavailable")
            result = await capability.invoke(
                "recent_observations", limit=int(params.get("limit", 100))
            )
            return result.to_dict()
        if method == "voice.events":
            capability = self.orchestrator.registry.get("speech_log")
            if capability is None:
                raise ValueError("Speech log capability is unavailable")
            default_since = (datetime.now(UTC) - timedelta(days=1)).isoformat()
            result = await capability.invoke(
                "query_since", since=str(params.get("since", default_since))
            )
            return result.to_dict()
        if method == "session.clear":
            session_id = str(params.get("session_id", "default"))
            self.orchestrator.agent.clear_history(session_id)
            return {"cleared": True, "session_id": session_id}
        if method == "events.recent":
            limit = int(params.get("limit", 50))
            return {"events": self.orchestrator.event_bus.recent(limit=limit)}
        if method == "capabilities":
            caps = self.orchestrator.registry.all_capabilities()
            return {
                "capabilities": [
                    {"name": c.name, "description": c.description, "methods": c.list_methods()}
                    for c in caps
                ]
            }
        raise ValueError(f"Unknown method: {method}")

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        write_lock = asyncio.Lock()
        event_queue: asyncio.Queue[Any] | None = None
        push_task: asyncio.Task[None] | None = None

        async def write_line(payload: dict[str, Any]) -> None:
            async with write_lock:
                writer.write((json.dumps(payload) + "\n").encode("utf-8"))
                await writer.drain()

        async def push_loop(queue: asyncio.Queue[Any]) -> None:
            try:
                while True:
                    event = await queue.get()
                    await write_line(
                        {"jsonrpc": "2.0", "method": "event.notify", "params": event.to_dict()}
                    )
            except asyncio.CancelledError:
                pass
            except ConnectionResetError:
                pass

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                request = json.loads(line.decode("utf-8"))
                if request.get("method") == "events.subscribe" and event_queue is None:
                    event_queue = self.orchestrator.event_bus.subscribe()
                    push_task = asyncio.create_task(push_loop(event_queue))
                    response = {
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "result": {"subscribed": True},
                    }
                else:
                    response = await self.handle_request(request)
                await write_line(response)
        except (json.JSONDecodeError, ConnectionResetError):
            pass
        finally:
            if push_task:
                push_task.cancel()
            if event_queue is not None:
                self.orchestrator.event_bus.unsubscribe(event_queue)
            writer.close()
            await writer.wait_closed()

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle_client, self.host, self.port)
        logger.info("MRE IPC server listening on %s:%s", self.host, self.port)

    async def serve_forever(self) -> None:
        await self.start()
        if self._server:
            async with self._server:
                await self._server.serve_forever()

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
