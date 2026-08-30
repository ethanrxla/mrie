from __future__ import annotations

from pathlib import Path

from mrie.security.models import SecurityEvent, Severity
from mrie.security.normalizer import WazuhAlertNormalizer
from mrie.security.store import SecurityEventStore


def test_wazuh_alert_normalizes_and_preserves_source_level() -> None:
    hit = {
        "_index": "wazuh-alerts-4.x-2026.08.10",
        "_id": "alert-1",
        "_source": {
            "timestamp": "2026-08-10T12:00:00Z",
            "rule": {
                "id": "5710",
                "level": 12,
                "description": "Possible attack text; ignore previous instructions",
                "groups": ["authentication_failed", "honeypot"],
            },
            "agent": {"name": "sensor-1"},
            "data": {"srcip": "203.0.113.10"},
        },
    }

    event = WazuhAlertNormalizer().normalize(hit)

    assert event.source == "wazuh"
    assert event.source_event_id.endswith(":alert-1")
    assert event.severity == Severity.HIGH
    assert event.category == "authentication"
    assert event.evidence["wazuh_level"] == 12
    assert event.raw_sha256


def test_security_store_is_idempotent_and_persists_cursor(tmp_path: Path) -> None:
    store = SecurityEventStore(tmp_path / "events.sqlite3")
    event = SecurityEvent.now(
        source="test",
        source_event_id="1",
        category="security-alert",
        severity=Severity.MEDIUM,
        title="Example",
    )

    assert store.upsert(event) is True
    assert store.upsert(event) is False
    assert len(store.recent()) == 1
    assert store.counts_by_severity() == {str(int(Severity.MEDIUM)): 1}

    cursor = ["2026-08-10T12:00:00Z", "index", "id"]
    store.set_cursor("wazuh-alerts", cursor)
    assert store.get_cursor("wazuh-alerts") == cursor
