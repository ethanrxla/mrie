"""SQLite/WAL persistence for normalized events and ingestion cursors."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from mrie.security.models import SecurityEvent


class SecurityEventStore:
    """Small durable store; Wazuh remains the authoritative raw event index."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS security_events (
                    event_id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    source TEXT NOT NULL,
                    source_event_id TEXT NOT NULL,
                    category TEXT NOT NULL,
                    severity INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    asset TEXT,
                    actor TEXT,
                    rule_id TEXT,
                    tags_json TEXT NOT NULL,
                    evidence_json TEXT NOT NULL,
                    raw_sha256 TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_security_events_time
                    ON security_events(occurred_at DESC);
                CREATE INDEX IF NOT EXISTS idx_security_events_severity
                    ON security_events(severity DESC, occurred_at DESC);
                CREATE TABLE IF NOT EXISTS ingestion_cursors (
                    source TEXT PRIMARY KEY,
                    cursor_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def upsert(self, event: SecurityEvent) -> bool:
        """Persist one event and return ``True`` only when it was new."""
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO security_events (
                    event_id, occurred_at, observed_at, source, source_event_id,
                    category, severity, title, asset, actor, rule_id, tags_json,
                    evidence_json, raw_sha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.occurred_at,
                    event.observed_at,
                    event.source,
                    event.source_event_id,
                    event.category,
                    int(event.severity),
                    event.title,
                    event.asset,
                    event.actor,
                    event.rule_id,
                    json.dumps(event.tags),
                    json.dumps(event.evidence, default=str),
                    event.raw_sha256,
                ),
            )
            return cursor.rowcount == 1

    def recent(self, limit: int = 100, minimum_severity: int = 0) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit), 1000))
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM security_events
                WHERE severity >= ?
                ORDER BY occurred_at DESC, event_id DESC
                LIMIT ?
                """,
                (int(minimum_severity), bounded_limit),
            ).fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json"))
            item["evidence"] = json.loads(item.pop("evidence_json"))
            events.append(item)
        return events

    def counts_by_severity(self) -> dict[str, int]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT severity, COUNT(*) AS count FROM security_events GROUP BY severity"
            ).fetchall()
        return {str(row["severity"]): int(row["count"]) for row in rows}

    def get_cursor(self, source: str) -> list[Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT cursor_json FROM ingestion_cursors WHERE source = ?", (source,)
            ).fetchone()
        return json.loads(row["cursor_json"]) if row else None

    def set_cursor(self, source: str, cursor: list[Any]) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO ingestion_cursors(source, cursor_json, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(source) DO UPDATE SET
                    cursor_json = excluded.cursor_json,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (source, json.dumps(cursor)),
            )
