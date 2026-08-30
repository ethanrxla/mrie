from __future__ import annotations

import sqlite3
from pathlib import Path

from mrie.scheduler.briefing_store import BriefingStore


def _result(timestamp: str, summary: str) -> dict[str, object]:
    return {
        "timestamp": timestamp,
        "dry_run": False,
        "successful": True,
        "summary": summary,
        "model_error": None,
        "delivery": {
            "success": True,
            "data": {
                "delivery_status": "played",
                "utterance_id": "utterance-123",
                "rendered": True,
                "queued": False,
                "played": True,
                "audio_path": "C:/private/speech.mp3",
                "audio_sha256": "a" * 64,
            },
        },
        "window_start": "2026-08-12T05:00:00+00:00",
        "window_end": timestamp,
        "next_run": "2026-08-13T05:00:00-04:00",
        "collected": {
            "sources": {
                "news": {
                    "success": True,
                    "data": {
                        "headlines": [
                            {
                                "title": "Verified headline",
                                "url": "https://example.test/report?edition=morning#fragment",
                                "published": "2026-08-12T10:00:00Z",
                                "source": "Example Wire",
                                "body": "private raw article body",
                            },
                            {
                                "title": "Insecure URL is excluded",
                                "url": "http://example.test/insecure",
                            },
                        ]
                    },
                    "error": None,
                },
                "security_events": {
                    "success": True,
                    "data": {
                        "events": [
                            {
                                "event_id": "evt-123",
                                "source_event_id": "wazuh-alerts:abc",
                                "occurred_at": "2026-08-12T11:00:00Z",
                                "severity": 3,
                                "rule_id": "5710",
                                "source": "wazuh",
                                "actor": "must-not-leak",
                                "evidence": {"raw": "must-not-leak"},
                            }
                        ]
                    },
                    "error": None,
                },
                "youtube": {
                    "success": False,
                    "data": None,
                    "error": "OAuth token=very-secret is not configured",
                },
            }
        },
    }


def test_briefing_store_is_durable_bounded_and_omits_raw_feeds(tmp_path: Path) -> None:
    path = tmp_path / "briefings.sqlite3"
    store = BriefingStore(path, max_records=2)
    store.append(_result("2026-08-12T05:00:00+00:00", "First"))
    store.append(_result("2026-08-12T13:00:00+00:00", "Second"))
    latest = store.append(_result("2026-08-12T21:00:00+00:00", "Third"))

    reopened = BriefingStore(path, max_records=2)
    records = reopened.list(limit=20)

    assert reopened.count() == 2
    assert [record["summary"] for record in records] == ["Third", "Second"]
    assert latest["windowStart"] == "2026-08-12T05:00:00+00:00"
    assert latest["windowEnd"] == "2026-08-12T21:00:00+00:00"
    assert latest["delivery"] == {
        "status": "played",
        "utteranceId": "utterance-123",
        "rendered": True,
        "queued": False,
        "played": True,
        "reason": None,
    }
    assert latest["sources"]["news"]["evidence"] == [
        {
            "kind": "content",
            "title": "Verified headline",
            "url": "https://example.test/report",
            "published": "2026-08-12T10:00:00Z",
            "source": "Example Wire",
        }
    ]
    assert latest["sources"]["security_events"]["evidence"] == [
        {
            "kind": "security",
            "eventId": "evt-123",
            "sourceEventId": "wazuh-alerts:abc",
            "timestamp": "2026-08-12T11:00:00+00:00",
            "severity": 3,
            "ruleId": "5710",
            "source": "wazuh",
        }
    ]
    assert latest["sources"]["youtube"]["error"] == (
        "OAuth token=[REDACTED] is not configured"
    )
    assert "private raw article body" not in str(records)
    assert "must-not-leak" not in str(records)
    assert "very-secret" not in str(records)
    assert "private/speech" not in str(records)
    assert "a" * 64 not in str(records)

    with sqlite3.connect(path) as connection:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(briefings)").fetchall()
        }
    assert "collected" not in columns
    assert {
        "window_start",
        "window_end",
        "scheduled_slot",
        "successful",
        "delivery_json",
    } <= columns


def test_scheduled_slot_is_idempotent(tmp_path: Path) -> None:
    store = BriefingStore(tmp_path / "briefings.sqlite3")
    slot = "2026-08-12T13:00:00-04:00"
    first = _result("2026-08-12T17:00:05+00:00", "First delivery")
    first["scheduled_slot"] = slot
    duplicate = _result("2026-08-12T17:00:10+00:00", "Duplicate delivery")
    duplicate["scheduled_slot"] = slot

    assert store.claim_scheduled_slot(slot) is True
    first_record = store.append(first)
    store.complete_scheduled_slot(slot, first_record["id"])
    duplicate_record = store.append(duplicate)

    assert duplicate_record["id"] == first_record["id"]
    assert store.count() == 1
    assert store.is_slot_completed(slot) is True
    assert store.claim_scheduled_slot(slot) is False


def test_additive_migration_preserves_old_archive(tmp_path: Path) -> None:
    path = tmp_path / "briefings.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE briefings (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                dry_run INTEGER NOT NULL,
                summary TEXT NOT NULL,
                model_error TEXT,
                next_run TEXT,
                sources_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO briefings (
                id, timestamp, dry_run, summary, model_error, next_run, sources_json
            ) VALUES (
                'legacy', '2026-08-12T05:00:00+00:00', 0, 'Legacy', NULL,
                NULL, '{"news":{"success":true,"count":1,"error":null}}'
            );
            """
        )

    store = BriefingStore(path)
    record = store.list(limit=1)[0]

    assert record["id"] == "legacy"
    assert record["successful"] is True
    assert record["windowStart"] is None
    assert record["delivery"]["status"] == "unknown"
    assert record["sources"]["news"]["evidence"] == []


def test_pending_delivery_is_atomically_queued_and_sanitized(tmp_path: Path) -> None:
    store = BriefingStore(tmp_path / "briefings.sqlite3")
    result = _result("2026-08-12T21:00:00+00:00", "Queued briefing")
    result["delivery"] = {
        "status": "pending",
        "audio_path": "C:/must-not-leak.mp3",
        "audio_sha256": "b" * 64,
    }

    record = store.append(result)

    assert record["delivery"] == {
        "status": "queued",
        "utteranceId": None,
        "rendered": False,
        "queued": True,
        "played": False,
        "reason": "delivery_queued",
    }
    assert store.delivery_queue_status()["queued"] == 1
    assert "must-not-leak" not in str(record)
    assert "b" * 64 not in str(record)
    assert [event["status"] for event in store.delivery_events(record["id"])] == [
        "queued"
    ]


def test_delivery_job_transitions_are_durable_and_public_only(tmp_path: Path) -> None:
    store = BriefingStore(tmp_path / "briefings.sqlite3")
    result = _result("2026-08-12T21:00:00+00:00", "Deliver me")
    result["delivery"] = {"status": "pending"}
    record = store.append(result)

    job = store.claim_next_delivery()
    assert job == {
        "briefing_id": record["id"],
        "summary": "Deliver me",
        "attempt": 1,
    }
    assert store.list(1)[0]["delivery"]["status"] == "pending"

    delivery = store.complete_delivery_job(
        record["id"],
        {
            "success": True,
            "data": {
                "delivery_status": "played",
                "utterance_id": "utterance-safe",
                "rendered": True,
                "queued": False,
                "played": True,
                "audio_path": "C:/private/audio.mp3",
                "audio_sha256": "c" * 64,
            },
        },
    )

    assert delivery["status"] == "played"
    assert delivery["played"] is True
    reopened = BriefingStore(store.path)
    saved = reopened.list(1)[0]
    assert saved["delivery"] == delivery
    assert "private/audio" not in str(saved)
    assert "c" * 64 not in str(saved)
    assert reopened.delivery_queue_status()["completed"] == 1
    assert [event["status"] for event in reopened.delivery_events(record["id"])] == [
        "queued",
        "pending",
        "played",
    ]


def test_restart_recovers_unclaimed_pending_but_never_replays_running(
    tmp_path: Path,
) -> None:
    path = tmp_path / "briefings.sqlite3"
    store = BriefingStore(path)
    pending = _result("2026-08-12T13:00:00+00:00", "Legacy pending")
    pending["delivery"] = {"status": "not_requested"}
    pending_record = store.append(pending)
    # Simulate a legacy pending row that predates durable delivery jobs.
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE briefings SET delivery_json = ? WHERE id = ?",
            ('{"status":"pending"}', pending_record["id"]),
        )

    running = _result("2026-08-12T21:00:00+00:00", "Ambiguous running")
    running["delivery"] = {"status": "pending"}
    running_record = store.append(running)
    assert store.claim_next_delivery() is not None

    recovered = BriefingStore(path)
    result = recovered.recover_delivery_jobs()

    assert result == {"recovered": 1, "interrupted": 1}
    records = {record["id"]: record for record in recovered.list(10)}
    assert records[pending_record["id"]]["delivery"]["status"] == "queued"
    assert records[running_record["id"]]["delivery"]["status"] == "delivery_failed"
    assert records[running_record["id"]]["delivery"]["reason"] == (
        "delivery_interrupted_unknown"
    )
    assert recovered.claim_next_delivery()["briefing_id"] == pending_record["id"]


def test_unstarted_delivery_queue_is_terminalized_without_private_fields(
    tmp_path: Path,
) -> None:
    store = BriefingStore(tmp_path / "briefings.sqlite3")
    result = _result("2026-08-12T21:00:00+00:00", "No daemon worker")
    result["delivery"] = {"status": "pending"}
    record = store.append(result)

    assert store.mark_queued_deliveries_unavailable("delivery_worker_not_running") == 1
    saved = store.list(1)[0]

    assert saved["id"] == record["id"]
    assert saved["delivery"] == {
        "status": "unavailable",
        "utteranceId": None,
        "rendered": False,
        "queued": False,
        "played": False,
        "reason": "delivery_worker_not_running",
    }
    assert store.delivery_queue_status()["failed"] == 1


def test_graceful_shutdown_terminalizes_running_delivery_without_replay(
    tmp_path: Path,
) -> None:
    store = BriefingStore(tmp_path / "briefings.sqlite3")
    result = _result("2026-08-12T21:00:00+00:00", "Interrupted delivery")
    result["delivery"] = {"status": "pending"}
    record = store.append(result)
    assert store.claim_next_delivery() is not None

    assert store.interrupt_running_deliveries("delivery_cancelled_unknown") == 1
    saved = store.list(1)[0]

    assert saved["id"] == record["id"]
    assert saved["delivery"]["status"] == "delivery_failed"
    assert saved["delivery"]["reason"] == "delivery_cancelled_unknown"
    assert store.claim_next_delivery() is None
