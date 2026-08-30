"""Read-only Wazuh server/indexer integration for the sentinel plane."""

from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from mrie.core.capability_base import Capability, CapabilityResult, EthicsVerdict, ToolDefinition
from mrie.security.normalizer import WazuhAlertNormalizer
from mrie.security.store import SecurityEventStore

SAFE_INDEX_PATTERN = re.compile(r"^[A-Za-z0-9*_.-]+$")


class WazuhCapability(Capability):
    """Query Wazuh using least-privilege read-only service credentials."""

    name = "wazuh"
    description = "Read Wazuh health, endpoint inventory, and normalized alerts"

    def __init__(self, config: dict[str, Any], store: SecurityEventStore) -> None:
        self.config = config
        self.store = store
        self.normalizer = WazuhAlertNormalizer()
        self.server = config.get("server_api", {})
        self.indexer = config.get("indexer", {})
        self.timeout = float(config.get("timeout_seconds", 20))
        self._jwt: str | None = None

    def get_tools(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="manager_status",
                description="Read Wazuh manager process status",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="list_agents",
                description="List enrolled Wazuh endpoint agents",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 100}},
                },
            ),
            ToolDefinition(
                name="sync_alerts",
                description="Pull one bounded page of new Wazuh alerts into the local event cache",
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 200},
                        "minimum_level": {"type": "integer", "default": 3},
                    },
                },
            ),
            ToolDefinition(
                name="recent_events",
                description="Read normalized events from the local cache",
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 50},
                        "minimum_severity": {"type": "integer", "default": 0},
                    },
                },
            ),
            ToolDefinition(
                name="connection_status",
                description="Probe read-only Wazuh manager and indexer connectivity",
                parameters={"type": "object", "properties": {}},
            ),
        ]

    def ethics_check(self, method: str, **kwargs: Any) -> EthicsVerdict:
        if method.startswith(("active_response", "delete", "update", "write")):
            return EthicsVerdict.DENY
        return EthicsVerdict.ALLOW

    async def invoke(self, method: str, **kwargs: Any) -> CapabilityResult:
        handlers = {
            "manager_status": self.manager_status,
            "list_agents": self.list_agents,
            "sync_alerts": self.sync_alerts,
            "recent_events": self.recent_events,
            "connection_status": self.connection_status,
        }
        handler = handlers.get(method)
        if handler is None:
            return CapabilityResult(success=False, error=f"Unknown method: {method}")
        try:
            return await handler(**kwargs)
        except (httpx.HTTPError, ValueError, OSError) as exc:
            return CapabilityResult(success=False, error=str(exc))

    async def manager_status(self) -> CapabilityResult:
        data = await self._manager_request("GET", "/manager/status")
        return CapabilityResult(success=True, data=data)

    async def list_agents(self, limit: int = 100) -> CapabilityResult:
        bounded = max(1, min(int(limit), 500))
        data = await self._manager_request("GET", "/agents", params={"limit": bounded})
        return CapabilityResult(success=True, data=data)

    async def sync_alerts(
        self,
        limit: int = 200,
        minimum_level: int = 3,
    ) -> CapabilityResult:
        bounded = max(1, min(int(limit), 1000))
        cursor = self.store.get_cursor("wazuh-alerts")
        query: dict[str, Any] = {
            "size": bounded,
            "query": {"range": {"rule.level": {"gte": int(minimum_level)}}},
            "sort": [{"timestamp": "asc"}, {"_index": "asc"}, {"_id": "asc"}],
        }
        if cursor:
            query["search_after"] = cursor

        result = await self._indexer_search(query)
        hits = (result.get("hits") or {}).get("hits") or []
        inserted = 0
        for hit in hits:
            if self.store.upsert(self.normalizer.normalize(hit)):
                inserted += 1
        if hits and hits[-1].get("sort"):
            self.store.set_cursor("wazuh-alerts", list(hits[-1]["sort"]))
        return CapabilityResult(
            success=True,
            data={
                "fetched": len(hits),
                "inserted": inserted,
                "deduplicated": len(hits) - inserted,
                "cursor": hits[-1].get("sort") if hits else cursor,
            },
        )

    async def recent_events(
        self,
        limit: int = 50,
        minimum_severity: int = 0,
    ) -> CapabilityResult:
        events = self.store.recent(limit=limit, minimum_severity=minimum_severity)
        return CapabilityResult(
            success=True,
            data={"events": events, "counts_by_severity": self.store.counts_by_severity()},
        )

    async def connection_status(self) -> CapabilityResult:
        """Probe both Wazuh services without ingesting or changing remote state."""

        async def probe_manager() -> dict[str, str | None]:
            if not str(self.server.get("base_url", "")).strip():
                return {
                    "state": "unconfigured",
                    "error": "Wazuh manager API is not configured",
                }
            try:
                await self._manager_request("GET", "/manager/status")
                return {"state": "connected", "error": None}
            except (httpx.HTTPError, ValueError, OSError) as exc:
                return {"state": "error", "error": self._probe_error(exc)}

        async def probe_indexer() -> dict[str, str | None]:
            if not str(self.indexer.get("base_url", "")).strip():
                return {
                    "state": "unconfigured",
                    "error": "Wazuh indexer is not configured",
                }
            try:
                await self._indexer_search(
                    {
                        "size": 0,
                        "track_total_hits": False,
                        "query": {"match_all": {}},
                    }
                )
                return {"state": "connected", "error": None}
            except (httpx.HTTPError, ValueError, OSError) as exc:
                return {"state": "error", "error": self._probe_error(exc)}

        manager, indexer = await asyncio.gather(probe_manager(), probe_indexer())
        states = [manager["state"], indexer["state"]]
        configured = sum(state != "unconfigured" for state in states)
        connected = sum(state == "connected" for state in states)
        if configured == 0:
            overall = "unconfigured"
        elif connected == 2:
            overall = "connected"
        elif connected:
            overall = "partial"
        else:
            overall = "error"
        return CapabilityResult(
            success=True,
            data={
                "state": overall,
                "checked_at": datetime.now(UTC).isoformat(),
                "manager": manager,
                "indexer": indexer,
            },
        )

    async def _manager_request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        base_url = str(self.server.get("base_url", "")).rstrip("/")
        if not base_url:
            raise ValueError("Wazuh server_api.base_url is not configured")
        if self._jwt is None:
            self._jwt = await self._authenticate_manager(base_url)
        async with httpx.AsyncClient(
            timeout=self.timeout, verify=self._verify(self.server)
        ) as client:
            response = await client.request(
                method,
                f"{base_url}{path}",
                params=params,
                headers={"Authorization": f"Bearer {self._jwt}"},
            )
            if response.status_code == 401:
                self._jwt = await self._authenticate_manager(base_url)
                response = await client.request(
                    method,
                    f"{base_url}{path}",
                    params=params,
                    headers={"Authorization": f"Bearer {self._jwt}"},
                )
            response.raise_for_status()
            return response.json()

    async def _authenticate_manager(self, base_url: str) -> str:
        username, password = self._credentials(self.server, "WAZUH_API")
        async with httpx.AsyncClient(
            timeout=self.timeout, verify=self._verify(self.server)
        ) as client:
            response = await client.get(
                f"{base_url}/security/user/authenticate",
                params={"raw": "true"},
                auth=httpx.BasicAuth(username, password),
            )
            response.raise_for_status()
        token = response.text.strip().strip('"')
        if response.headers.get("content-type", "").startswith("application/json"):
            parsed = response.json()
            if isinstance(parsed, dict):
                token = str(parsed.get("token") or (parsed.get("data") or {}).get("token") or token)
        if not token:
            raise ValueError("Wazuh server API returned an empty authentication token")
        return token

    async def _indexer_search(self, query: dict[str, Any]) -> dict[str, Any]:
        base_url = str(self.indexer.get("base_url", "")).rstrip("/")
        if not base_url:
            raise ValueError("Wazuh indexer.base_url is not configured")
        pattern = str(self.indexer.get("index_pattern", "wazuh-alerts-4.x-*"))
        if not SAFE_INDEX_PATTERN.fullmatch(pattern):
            raise ValueError("Unsafe Wazuh index pattern")
        username, password = self._credentials(self.indexer, "WAZUH_INDEXER")
        async with httpx.AsyncClient(
            timeout=self.timeout, verify=self._verify(self.indexer)
        ) as client:
            response = await client.post(
                f"{base_url}/{pattern}/_search",
                auth=httpx.BasicAuth(username, password),
                json=query,
            )
            response.raise_for_status()
            return response.json()

    @staticmethod
    def _credentials(config: dict[str, Any], prefix: str) -> tuple[str, str]:
        username_env = str(config.get("username_env", f"{prefix}_USERNAME"))
        password_env = str(config.get("password_env", f"{prefix}_PASSWORD"))
        username = os.environ.get(username_env)
        password = os.environ.get(password_env)
        if not username or not password:
            raise ValueError(f"Set {username_env} and {password_env}")
        return username, password

    @staticmethod
    def _verify(config: dict[str, Any]) -> bool | str:
        ca_bundle = config.get("ca_bundle")
        if ca_bundle:
            return str(Path(str(ca_bundle)).expanduser())
        if config.get("verify_tls", True) is False:
            raise ValueError("TLS verification cannot be disabled; configure a CA bundle")
        return True

    @staticmethod
    def _probe_error(error: Exception) -> str:
        if isinstance(error, httpx.TimeoutException):
            return "Wazuh connectivity probe timed out"
        if isinstance(error, httpx.ConnectError):
            return "Wazuh service could not be reached"
        if isinstance(error, httpx.HTTPStatusError):
            return f"Wazuh service returned HTTP {error.response.status_code}"
        if isinstance(error, ValueError):
            message = str(error)
            if message.startswith("Set "):
                return "Wazuh service credentials are not configured"
            if "TLS verification" in message or "CA bundle" in message:
                return "Wazuh TLS verification is not configured correctly"
            if "index pattern" in message:
                return "Wazuh index pattern is invalid"
        return "Wazuh connectivity probe failed"
