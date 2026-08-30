"""Durable, privacy-minimized storage for completed MRE briefings."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

MAX_EVIDENCE_PER_SOURCE = 20
MAX_TITLE_CHARS = 500
MAX_SOURCE_CHARS = 300
MAX_ID_CHARS = 500
MAX_TIMESTAMP_CHARS = 100

_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|token|secret|password)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_AUTHORIZATION_ASSIGNMENT = re.compile(
    r"(?i)\b(authorization)(\s*[:=]\s*)([^,;]+)"
)
_BEARER_TOKEN = re.compile(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]+")
_URL_IN_TEXT = re.compile(r"https?://[^\s<>\"']+")
_HIGH_ENTROPY_TOKEN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_+/=.-]{32,}(?![A-Za-z0-9])")
_STABLE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,499}$")
_DELIVERY_STATUSES = {
    "pending",
    "not_requested",
    "unavailable",
    "render_failed",
    "queued",
    "played",
    "play_failed",
    "delivery_failed",
    "unknown",
}
_DELIVERY_TERMINAL_FAILURES = {
    "unavailable",
    "render_failed",
    "play_failed",
    "delivery_failed",
    "unknown",
}


def _item_count(data: Any) -> int:
    """Return a useful result count without retaining the underlying source data."""
    if isinstance(data, list):
        return len(data)
    if not isinstance(data, dict):
        return 0

    for key in ("count", "inserted", "fetched", "synced", "new_events", "total"):
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return max(0, value)
    for value in data.values():
        if isinstance(value, list):
            return len(value)
    return 0


def _bounded_text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    normalized = " ".join(str(value).split()).strip()
    return normalized[:limit] if normalized else None


def _safe_https_url(value: Any) -> str | None:
    """Return a bounded, credential-free HTTPS citation URL."""
    text = _bounded_text(value, 4096)
    if not text:
        return None
    try:
        parsed = urlsplit(text)
    except ValueError:
        return None
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    try:
        port = f":{parsed.port}" if parsed.port is not None else ""
    except ValueError:
        return None
    host = parsed.hostname.lower()
    netloc = f"{host}{port}"
    # Queries are omitted: canonical evidence does not need tracking parameters,
    # signed URLs, access tokens, or other secret-bearing query values.
    return urlunsplit(("https", netloc, parsed.path, "", ""))[:2048]


def _safe_error(value: Any) -> str | None:
    """Keep an actionable diagnostic while removing common secret-bearing forms."""
    text = _bounded_text(value, 2000)
    if not text:
        return None
    text = _SECRET_ASSIGNMENT.sub(r"\1\2[REDACTED]", text)
    text = _AUTHORIZATION_ASSIGNMENT.sub(r"\1\2[REDACTED]", text)
    text = _BEARER_TOKEN.sub(r"\1 [REDACTED]", text)

    def strip_url_query(match: re.Match[str]) -> str:
        raw = match.group(0)
        try:
            parsed = urlsplit(raw)
        except ValueError:
            return "[REDACTED_URL]"
        if not parsed.hostname or parsed.username or parsed.password:
            return "[REDACTED_URL]"
        try:
            port = f":{parsed.port}" if parsed.port is not None else ""
        except ValueError:
            return "[REDACTED_URL]"
        return urlunsplit((parsed.scheme, f"{parsed.hostname.lower()}{port}", parsed.path, "", ""))

    text = _URL_IN_TEXT.sub(strip_url_query, text)
    return _HIGH_ENTROPY_TOKEN.sub("[REDACTED]", text)[:500]


def _stable_identifier(value: Any, max_chars: int = MAX_ID_CHARS) -> str | None:
    text = _bounded_text(value, max_chars)
    if not text:
        return None
    if _STABLE_IDENTIFIER.fullmatch(text):
        return text
    return f"sha256:{sha256(text.encode('utf-8')).hexdigest()}"


def _safe_timestamp(value: Any) -> str | None:
    text = _bounded_text(value, MAX_TIMESTAMP_CHARS)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


def _content_evidence(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    candidates: list[Any] = []
    for key in ("headlines", "articles", "videos", "posts", "results"):
        value = data.get(key)
        if isinstance(value, list):
            candidates.extend(value)

    evidence: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        title = _safe_error(candidate.get("title"))
        title = title[:MAX_TITLE_CHARS] if title else None
        url = _safe_https_url(candidate.get("url") or candidate.get("link"))
        if not title or not url or url in seen_urls:
            continue
        raw_source = candidate.get("source") or candidate.get("channel")
        if isinstance(raw_source, dict):
            raw_source = raw_source.get("name") or raw_source.get("id")
        source_text = _safe_error(raw_source)
        published = _safe_error(
            candidate.get("published")
            or candidate.get("published_at")
            or candidate.get("publishedAt")
        )
        evidence.append(
            {
                "kind": "content",
                "title": title,
                "url": url,
                "published": published[:MAX_TIMESTAMP_CHARS] if published else None,
                "source": source_text[:MAX_SOURCE_CHARS] if source_text else None,
            }
        )
        seen_urls.add(url)
        if len(evidence) >= MAX_EVIDENCE_PER_SOURCE:
            break
    return evidence


def _security_evidence(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        return []
    evidence: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for event in data["events"]:
        if not isinstance(event, dict):
            continue
        event_id = _stable_identifier(event.get("event_id"))
        source_event_id = _stable_identifier(event.get("source_event_id"))
        stable_id = event_id or source_event_id
        if not stable_id or stable_id in seen_ids:
            continue
        try:
            severity = max(0, min(int(event.get("severity", 0)), 100))
        except (TypeError, ValueError):
            severity = 0
        evidence.append(
            {
                "kind": "security",
                "eventId": event_id,
                "sourceEventId": source_event_id,
                "timestamp": _safe_timestamp(
                    event.get("occurred_at")
                    or event.get("observed_at")
                    or event.get("timestamp")
                ),
                "severity": severity,
                "ruleId": _stable_identifier(event.get("rule_id")),
                "source": _stable_identifier(event.get("source"), MAX_SOURCE_CHARS),
            }
        )
        seen_ids.add(stable_id)
        if len(evidence) >= MAX_EVIDENCE_PER_SOURCE:
            break
    return evidence


def _safe_source_evidence(name: str, data: Any) -> list[dict[str, Any]]:
    if name in {"security_events", "honeypot"}:
        return _security_evidence(data)
    if name in {"news", "youtube", "instagram", "reddit", "web"}:
        return _content_evidence(data)
    return []


def _sanitize_stored_evidence(items: Any) -> list[dict[str, Any]]:
    """Reapply the public whitelist when reading potentially old/local DB rows."""
    if not isinstance(items, list):
        return []
    sanitized: list[dict[str, Any]] = []
    for item in items[:MAX_EVIDENCE_PER_SOURCE]:
        if not isinstance(item, dict):
            continue
        if item.get("kind") == "content":
            sanitized.extend(_content_evidence({"results": [item]}))
        elif item.get("kind") == "security":
            mapped = {
                "event_id": item.get("eventId"),
                "source_event_id": item.get("sourceEventId"),
                "occurred_at": item.get("timestamp"),
                "severity": item.get("severity"),
                "rule_id": item.get("ruleId"),
                "source": item.get("source"),
            }
            sanitized.extend(_security_evidence({"events": [mapped]}))
        if len(sanitized) >= MAX_EVIDENCE_PER_SOURCE:
            break
    return sanitized[:MAX_EVIDENCE_PER_SOURCE]


def public_delivery(value: Any) -> dict[str, Any]:
    """Whitelist a voice outcome without retaining audio paths, hashes, or provider data."""
    outer = value if isinstance(value, dict) else {}
    inner = outer.get("data") if isinstance(outer.get("data"), dict) else outer
    raw_status = _bounded_text(
        inner.get("delivery_status") or inner.get("status"), 50
    )
    status = raw_status if raw_status in _DELIVERY_STATUSES else "unknown"
    utterance_id = _stable_identifier(
        inner.get("utterance_id") or inner.get("utteranceId")
    )
    reason = _safe_error(inner.get("reason") or outer.get("error"))
    return {
        "status": status,
        "utteranceId": utterance_id,
        "rendered": bool(inner.get("rendered", False)),
        "queued": bool(inner.get("queued", False)),
        "played": bool(inner.get("played", False)),
        "reason": reason,
    }


def public_briefing_record(result: dict[str, Any], record_id: str | None = None) -> dict[str, Any]:
    """Reduce a full run result to the safe contract exposed to dashboard clients."""
    collected = result.get("collected")
    raw_sources = collected.get("sources", {}) if isinstance(collected, dict) else {}
    sources: dict[str, dict[str, Any]] = {}
    if isinstance(raw_sources, dict):
        for name, raw_result in raw_sources.items():
            source_result = raw_result if isinstance(raw_result, dict) else {}
            error = source_result.get("error")
            sources[str(name)] = {
                "success": bool(source_result.get("success", False)),
                "count": _item_count(source_result.get("data")),
                "error": _safe_error(error),
                "evidence": _safe_source_evidence(str(name), source_result.get("data")),
            }

    dry_run = bool(result.get("dry_run", False))
    model_error = _safe_error(result.get("model_error"))

    return {
        "id": record_id or str(result.get("id") or uuid4()),
        "timestamp": str(result.get("timestamp", "")),
        "dryRun": dry_run,
        "successful": bool(result.get("successful", not dry_run and not model_error)),
        "summary": str(result.get("summary", "")),
        "modelError": model_error[:200] if model_error else None,
        "windowStart": str(result["window_start"]) if result.get("window_start") else None,
        "windowEnd": str(result["window_end"]) if result.get("window_end") else None,
        "scheduledSlot": (
            str(result["scheduled_slot"]) if result.get("scheduled_slot") else None
        ),
        "delivery": public_delivery(result.get("delivery")),
        "nextRun": str(result["next_run"]) if result.get("next_run") else None,
        "sources": sources,
    }


class BriefingStore:
    """SQLite/WAL store containing summaries and source health, never raw feeds."""

    def __init__(self, path: Path, max_records: int = 1000) -> None:
        self.path = path
        self.max_records = max(1, int(max_records))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS briefings (
                    id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    dry_run INTEGER NOT NULL,
                    summary TEXT NOT NULL,
                    model_error TEXT,
                    successful INTEGER NOT NULL DEFAULT 0,
                    window_start TEXT,
                    window_end TEXT,
                    scheduled_slot TEXT,
                    delivery_json TEXT NOT NULL DEFAULT '{}',
                    next_run TEXT,
                    sources_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_briefings_timestamp
                    ON briefings(timestamp DESC, id DESC);
                CREATE TABLE IF NOT EXISTS briefing_slots (
                    scheduled_slot TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    claimed_at TEXT NOT NULL,
                    completed_at TEXT,
                    briefing_id TEXT
                );
                CREATE TABLE IF NOT EXISTS briefing_delivery_jobs (
                    briefing_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    claimed_at TEXT,
                    completed_at TEXT,
                    last_error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_briefing_delivery_jobs_status
                    ON briefing_delivery_jobs(status, created_at);
                CREATE TABLE IF NOT EXISTS briefing_delivery_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    briefing_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    delivery_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_briefing_delivery_events_briefing
                    ON briefing_delivery_events(briefing_id, sequence);
                """
            )

            # In-place, additive migration for archives created before window and
            # provenance support. SQLite does not support IF NOT EXISTS on columns.
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(briefings)").fetchall()
            }
            migrations = {
                "successful": "INTEGER NOT NULL DEFAULT 0",
                "window_start": "TEXT",
                "window_end": "TEXT",
                "scheduled_slot": "TEXT",
                "delivery_json": "TEXT NOT NULL DEFAULT '{}'",
            }
            for column, declaration in migrations.items():
                if column not in columns:
                    connection.execute(
                        f"ALTER TABLE briefings ADD COLUMN {column} {declaration}"
                    )
            if "successful" not in columns:
                connection.execute(
                    """
                    UPDATE briefings
                    SET successful = CASE
                        WHEN dry_run = 0 AND model_error IS NULL THEN 1
                        ELSE 0
                    END
                    """
                )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_scheduled_slot
                ON briefings(scheduled_slot)
                WHERE scheduled_slot IS NOT NULL
                """
            )

    def append(self, result: dict[str, Any]) -> dict[str, Any]:
        record = public_briefing_record(result)
        enqueue_delivery = (
            not record["dryRun"] and record["delivery"]["status"] == "pending"
        )
        if enqueue_delivery:
            record["delivery"] = public_delivery(
                {
                    "status": "queued",
                    "queued": True,
                    "reason": "delivery_queued",
                }
            )
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO briefings (
                    id, timestamp, dry_run, summary, model_error, successful,
                    window_start, window_end, scheduled_slot, delivery_json,
                    next_run, sources_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["timestamp"],
                    int(record["dryRun"]),
                    record["summary"],
                    record["modelError"],
                    int(record["successful"]),
                    record["windowStart"],
                    record["windowEnd"],
                    record["scheduledSlot"],
                    json.dumps(record["delivery"], separators=(",", ":")),
                    record["nextRun"],
                    json.dumps(record["sources"], separators=(",", ":")),
                ),
            )
            if cursor.rowcount == 0:
                if record["scheduledSlot"]:
                    row = connection.execute(
                        "SELECT * FROM briefings WHERE scheduled_slot = ?",
                        (record["scheduledSlot"],),
                    ).fetchone()
                else:
                    row = connection.execute(
                        "SELECT * FROM briefings WHERE id = ?", (record["id"],)
                    ).fetchone()
                if row is None:
                    raise sqlite3.IntegrityError("Briefing insert was ignored without a match")
                record = self._row_to_record(row)
                enqueue_delivery = False
            if enqueue_delivery:
                now_iso = datetime.now(UTC).isoformat()
                connection.execute(
                    """
                    INSERT INTO briefing_delivery_jobs (
                        briefing_id, status, attempt_count, claimed_at,
                        completed_at, last_error, created_at, updated_at
                    ) VALUES (?, 'queued', 0, NULL, NULL, NULL, ?, ?)
                    """,
                    (record["id"], now_iso, now_iso),
                )
                self._append_delivery_event(
                    connection,
                    record["id"],
                    record["delivery"],
                    created_at=now_iso,
                )
            connection.execute(
                """
                DELETE FROM briefings
                WHERE id NOT IN (
                    SELECT id FROM briefings
                    ORDER BY timestamp DESC, id DESC
                    LIMIT ?
                )
                  AND id NOT IN (
                    SELECT briefing_id
                    FROM briefing_delivery_jobs
                    WHERE status IN ('queued', 'running')
                  )
                """,
                (self.max_records,),
            )
            connection.execute(
                """
                DELETE FROM briefing_slots
                WHERE status = 'completed'
                  AND briefing_id IS NOT NULL
                  AND briefing_id NOT IN (SELECT id FROM briefings)
                """
            )
            connection.execute(
                """
                DELETE FROM briefing_delivery_jobs
                WHERE briefing_id NOT IN (SELECT id FROM briefings)
                """
            )
            connection.execute(
                """
                DELETE FROM briefing_delivery_events
                WHERE briefing_id NOT IN (SELECT id FROM briefings)
                """
            )
        return record

    def update_delivery(self, record_id: str, delivery: Any) -> dict[str, Any]:
        """Persist one sanitized transition after the report itself is durable."""
        public = public_delivery(delivery)
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                (json.dumps(public, separators=(",", ":")), record_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"Unknown briefing: {record_id}")
        return public

    @staticmethod
    def _append_delivery_event(
        connection: sqlite3.Connection,
        briefing_id: str,
        delivery: Any,
        *,
        created_at: str | None = None,
    ) -> dict[str, Any]:
        public = public_delivery(delivery)
        connection.execute(
            """
            INSERT INTO briefing_delivery_events (
                briefing_id, status, delivery_json, created_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                briefing_id,
                public["status"],
                json.dumps(public, separators=(",", ":")),
                created_at or datetime.now(UTC).isoformat(),
            ),
        )
        return public

    def recover_delivery_jobs(self, *, shutdown_clean: bool = False) -> dict[str, int]:
        """Recover queued work and quarantine ambiguous in-flight playback.

        A daemon crash after playback began cannot prove whether audio was heard.
        Such jobs are failed without replay. Legacy ``pending`` briefings are safe
        to enqueue because they predate a delivery claim.
        """
        recovered = 0
        interrupted = 0
        now_iso = datetime.now(UTC).isoformat()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            running = connection.execute(
                """
                SELECT briefing_id
                FROM briefing_delivery_jobs
                WHERE status = 'running'
                """
            ).fetchall()
            for row in running:
                briefing_id = str(row["briefing_id"])
                reason = (
                    "delivery_cancelled_unknown"
                    if shutdown_clean
                    else "delivery_interrupted_unknown"
                )
                delivery = public_delivery(
                    {
                        "status": "delivery_failed",
                        "reason": reason,
                    }
                )
                connection.execute(
                    "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                    (json.dumps(delivery, separators=(",", ":")), briefing_id),
                )
                connection.execute(
                    """
                    UPDATE briefing_delivery_jobs
                    SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ?
                    WHERE briefing_id = ?
                    """,
                    (now_iso, delivery["reason"], now_iso, briefing_id),
                )
                self._append_delivery_event(
                    connection,
                    briefing_id,
                    delivery,
                    created_at=now_iso,
                )
                interrupted += 1

            rows = connection.execute(
                """
                SELECT id, delivery_json, timestamp
                FROM briefings
                WHERE dry_run = 0
                ORDER BY timestamp, id
                """
            ).fetchall()
            for row in rows:
                briefing_id = str(row["id"])
                delivery = public_delivery(json.loads(row["delivery_json"] or "{}"))
                job = connection.execute(
                    "SELECT status FROM briefing_delivery_jobs WHERE briefing_id = ?",
                    (briefing_id,),
                ).fetchone()
                if delivery["status"] != "pending" or job is not None:
                    continue
                queued = public_delivery(
                    {
                        "status": "queued",
                        "queued": True,
                        "reason": "delivery_recovered_after_restart",
                    }
                )
                connection.execute(
                    "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                    (json.dumps(queued, separators=(",", ":")), briefing_id),
                )
                connection.execute(
                    """
                    INSERT INTO briefing_delivery_jobs (
                        briefing_id, status, attempt_count, claimed_at,
                        completed_at, last_error, created_at, updated_at
                    ) VALUES (?, 'queued', 0, NULL, NULL, NULL, ?, ?)
                    """,
                    (briefing_id, str(row["timestamp"]), now_iso),
                )
                self._append_delivery_event(
                    connection,
                    briefing_id,
                    queued,
                    created_at=now_iso,
                )
                recovered += 1
        return {"recovered": recovered, "interrupted": interrupted}

    def mark_queued_deliveries_unavailable(self, reason: str) -> int:
        """Terminalize queued speech when the service runs without a worker."""
        safe_reason = _safe_error(reason) or "delivery_worker_unavailable"
        now_iso = datetime.now(UTC).isoformat()
        updated = 0
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT briefing_id
                FROM briefing_delivery_jobs
                WHERE status = 'queued'
                """
            ).fetchall()
            for row in rows:
                briefing_id = str(row["briefing_id"])
                delivery = public_delivery(
                    {"status": "unavailable", "reason": safe_reason}
                )
                connection.execute(
                    "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                    (json.dumps(delivery, separators=(",", ":")), briefing_id),
                )
                connection.execute(
                    """
                    UPDATE briefing_delivery_jobs
                    SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ?
                    WHERE briefing_id = ?
                    """,
                    (now_iso, safe_reason, now_iso, briefing_id),
                )
                self._append_delivery_event(
                    connection,
                    briefing_id,
                    delivery,
                    created_at=now_iso,
                )
                updated += 1
        return updated

    def interrupt_running_deliveries(self, reason: str) -> int:
        """Conservatively terminalize claimed jobs during graceful shutdown."""
        safe_reason = _safe_error(reason) or "delivery_cancelled_unknown"
        now_iso = datetime.now(UTC).isoformat()
        updated = 0
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT briefing_id
                FROM briefing_delivery_jobs
                WHERE status = 'running'
                """
            ).fetchall()
            for row in rows:
                briefing_id = str(row["briefing_id"])
                delivery = public_delivery(
                    {"status": "delivery_failed", "reason": safe_reason}
                )
                connection.execute(
                    "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                    (json.dumps(delivery, separators=(",", ":")), briefing_id),
                )
                connection.execute(
                    """
                    UPDATE briefing_delivery_jobs
                    SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ?
                    WHERE briefing_id = ?
                    """,
                    (now_iso, safe_reason, now_iso, briefing_id),
                )
                self._append_delivery_event(
                    connection,
                    briefing_id,
                    delivery,
                    created_at=now_iso,
                )
                updated += 1
        return updated

    def claim_next_delivery(self) -> dict[str, Any] | None:
        """Atomically claim the oldest queued briefing for one delivery attempt."""
        now_iso = datetime.now(UTC).isoformat()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT jobs.briefing_id, jobs.attempt_count, briefings.summary
                FROM briefing_delivery_jobs AS jobs
                JOIN briefings ON briefings.id = jobs.briefing_id
                WHERE jobs.status = 'queued'
                ORDER BY jobs.created_at, jobs.briefing_id
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            briefing_id = str(row["briefing_id"])
            delivery = public_delivery(
                {"status": "pending", "reason": "delivery_in_progress"}
            )
            connection.execute(
                """
                UPDATE briefing_delivery_jobs
                SET status = 'running', attempt_count = attempt_count + 1,
                    claimed_at = ?, completed_at = NULL, last_error = NULL,
                    updated_at = ?
                WHERE briefing_id = ? AND status = 'queued'
                """,
                (now_iso, now_iso, briefing_id),
            )
            connection.execute(
                "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                (json.dumps(delivery, separators=(",", ":")), briefing_id),
            )
            self._append_delivery_event(
                connection,
                briefing_id,
                delivery,
                created_at=now_iso,
            )
        return {
            "briefing_id": briefing_id,
            "summary": str(row["summary"]),
            "attempt": int(row["attempt_count"]) + 1,
        }

    def complete_delivery_job(self, briefing_id: str, outcome: Any) -> dict[str, Any]:
        """Persist the final sanitized delivery result and terminal job state."""
        delivery = public_delivery(outcome)
        failed = delivery["status"] in _DELIVERY_TERMINAL_FAILURES
        job_status = "failed" if failed else "completed"
        now_iso = datetime.now(UTC).isoformat()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status FROM briefing_delivery_jobs WHERE briefing_id = ?",
                (briefing_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"Unknown briefing delivery job: {briefing_id}")
            if row["status"] != "running":
                raise RuntimeError(f"Briefing delivery job is not running: {briefing_id}")
            connection.execute(
                "UPDATE briefings SET delivery_json = ? WHERE id = ?",
                (json.dumps(delivery, separators=(",", ":")), briefing_id),
            )
            connection.execute(
                """
                UPDATE briefing_delivery_jobs
                SET status = ?, completed_at = ?, last_error = ?, updated_at = ?
                WHERE briefing_id = ?
                """,
                (
                    job_status,
                    now_iso,
                    delivery["reason"] if failed else None,
                    now_iso,
                    briefing_id,
                ),
            )
            self._append_delivery_event(
                connection,
                briefing_id,
                delivery,
                created_at=now_iso,
            )
        return delivery

    def delivery_queue_status(self) -> dict[str, int]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM briefing_delivery_jobs
                GROUP BY status
                """
            ).fetchall()
        counts = {"queued": 0, "running": 0, "completed": 0, "failed": 0}
        for row in rows:
            if row["status"] in counts:
                counts[str(row["status"])] = int(row["count"])
        return counts

    def delivery_events(self, briefing_id: str) -> list[dict[str, Any]]:
        """Return sanitized delivery audit events for diagnostics/tests."""
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT status, delivery_json, created_at
                FROM briefing_delivery_events
                WHERE briefing_id = ?
                ORDER BY sequence
                """,
                (briefing_id,),
            ).fetchall()
        return [
            {
                "status": str(row["status"]),
                "delivery": public_delivery(json.loads(row["delivery_json"])),
                "created_at": str(row["created_at"]),
            }
            for row in rows
        ]

    def list(self, limit: int = 20) -> list[dict[str, Any]]:
        bounded = max(1, min(int(limit), 100))
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM briefings
                ORDER BY timestamp DESC, id DESC
                LIMIT ?
                """,
                (bounded,),
            ).fetchall()
        return [self._row_to_record(row) for row in rows]

    def latest_successful_non_dry(self) -> dict[str, Any] | None:
        """Return the newest completed model-backed briefing window anchor."""
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM briefings
                WHERE dry_run = 0 AND successful = 1
                ORDER BY timestamp DESC, id DESC
                LIMIT 1
                """
            ).fetchone()
        return self._row_to_record(row) if row else None

    def get_by_scheduled_slot(self, scheduled_slot: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM briefings WHERE scheduled_slot = ?", (scheduled_slot,)
            ).fetchone()
        return self._row_to_record(row) if row else None

    def is_slot_completed(self, scheduled_slot: str) -> bool:
        """Treat an archived slot as complete even if a crash preceded slot bookkeeping."""
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT 1 FROM briefing_slots
                WHERE scheduled_slot = ? AND status = 'completed'
                UNION ALL
                SELECT 1 FROM briefings WHERE scheduled_slot = ?
                LIMIT 1
                """,
                (scheduled_slot, scheduled_slot),
            ).fetchone()
        return row is not None

    def claim_scheduled_slot(self, scheduled_slot: str, lease_seconds: int = 900) -> bool:
        """Atomically claim one logical cron slot, reclaiming only an expired lease."""
        now = datetime.now(UTC)
        stale_before = now - timedelta(seconds=max(60, int(lease_seconds)))
        now_iso = now.isoformat()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute(
                "SELECT 1 FROM briefings WHERE scheduled_slot = ?", (scheduled_slot,)
            ).fetchone():
                return False
            row = connection.execute(
                "SELECT status, claimed_at FROM briefing_slots WHERE scheduled_slot = ?",
                (scheduled_slot,),
            ).fetchone()
            if row and row["status"] == "completed":
                return False
            if row and row["status"] == "running":
                try:
                    claimed_at = datetime.fromisoformat(str(row["claimed_at"]))
                    if claimed_at.tzinfo is None:
                        claimed_at = claimed_at.replace(tzinfo=UTC)
                except ValueError:
                    claimed_at = datetime.min.replace(tzinfo=UTC)
                if claimed_at >= stale_before:
                    return False
            connection.execute(
                """
                INSERT INTO briefing_slots (
                    scheduled_slot, status, attempt_count, claimed_at,
                    completed_at, briefing_id
                ) VALUES (?, 'running', 1, ?, NULL, NULL)
                ON CONFLICT(scheduled_slot) DO UPDATE SET
                    status = 'running',
                    attempt_count = briefing_slots.attempt_count + 1,
                    claimed_at = excluded.claimed_at,
                    completed_at = NULL,
                    briefing_id = NULL
                """,
                (scheduled_slot, now_iso),
            )
        return True

    def complete_scheduled_slot(self, scheduled_slot: str, briefing_id: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO briefing_slots (
                    scheduled_slot, status, attempt_count, claimed_at,
                    completed_at, briefing_id
                ) VALUES (?, 'completed', 1, ?, ?, ?)
                ON CONFLICT(scheduled_slot) DO UPDATE SET
                    status = 'completed',
                    completed_at = excluded.completed_at,
                    briefing_id = excluded.briefing_id
                """,
                (
                    scheduled_slot,
                    datetime.now(UTC).isoformat(),
                    datetime.now(UTC).isoformat(),
                    briefing_id,
                ),
            )

    def fail_scheduled_slot(self, scheduled_slot: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE briefing_slots
                SET status = 'failed'
                WHERE scheduled_slot = ? AND status = 'running'
                """,
                (scheduled_slot,),
            )

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
        keys = set(row.keys())
        raw_sources = json.loads(row["sources_json"])
        sources: dict[str, dict[str, Any]] = {}
        if isinstance(raw_sources, dict):
            for name, value in raw_sources.items():
                status = value if isinstance(value, dict) else {}
                sources[str(name)] = {
                    "success": bool(status.get("success", False)),
                    "count": max(0, int(status.get("count", 0))),
                    "error": _safe_error(status.get("error")),
                    "evidence": _sanitize_stored_evidence(status.get("evidence")),
                }
        return {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "dryRun": bool(row["dry_run"]),
            "successful": bool(row["successful"]) if "successful" in keys else False,
            "summary": row["summary"],
            "modelError": row["model_error"],
            "windowStart": row["window_start"] if "window_start" in keys else None,
            "windowEnd": row["window_end"] if "window_end" in keys else None,
            "scheduledSlot": row["scheduled_slot"] if "scheduled_slot" in keys else None,
            "delivery": public_delivery(
                json.loads(row["delivery_json"])
                if "delivery_json" in keys and row["delivery_json"]
                else {}
            ),
            "nextRun": row["next_run"],
            "sources": sources,
        }

    def count(self) -> int:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM briefings").fetchone()
        return int(row["count"]) if row else 0
