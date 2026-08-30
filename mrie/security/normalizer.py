"""Deterministic normalization for security telemetry."""

from __future__ import annotations

from typing import Any

from mrie.security.models import SecurityEvent, Severity


class WazuhAlertNormalizer:
    """Map Wazuh index hits into the stable MRE event schema."""

    def normalize(self, hit: dict[str, Any]) -> SecurityEvent:
        source = hit.get("_source") or {}
        rule = source.get("rule") or {}
        agent = source.get("agent") or {}
        data = source.get("data") or {}
        level = self._as_int(rule.get("level"))
        source_id = str(hit.get("_id") or source.get("id") or "unknown")
        index = str(hit.get("_index") or "wazuh-alerts")
        groups = rule.get("groups") or []
        if isinstance(groups, str):
            groups = [groups]

        return SecurityEvent.now(
            source="wazuh",
            source_event_id=f"{index}:{source_id}",
            category=self._category(groups),
            severity=self._severity(level),
            title=str(rule.get("description") or "Wazuh security alert")[:500],
            occurred_at=str(source.get("@timestamp") or source.get("timestamp") or ""),
            asset=self._first(agent.get("name"), agent.get("ip"), source.get("location")),
            actor=self._first(
                data.get("srcip"),
                data.get("src_ip"),
                source.get("srcip"),
            ),
            rule_id=str(rule.get("id")) if rule.get("id") is not None else None,
            tags=tuple(str(group) for group in groups[:25]),
            evidence={
                "wazuh_level": level,
                "index": index,
                "decoder": (source.get("decoder") or {}).get("name"),
                "location": source.get("location"),
            },
            raw=hit,
        )

    def _severity(self, level: int) -> Severity:
        if level >= 13:
            return Severity.CRITICAL
        if level >= 10:
            return Severity.HIGH
        if level >= 7:
            return Severity.MEDIUM
        if level >= 4:
            return Severity.LOW
        return Severity.INFORMATIONAL

    def _category(self, groups: list[Any]) -> str:
        lowered = {str(group).lower() for group in groups}
        for category in (
            "authentication",
            "malware",
            "vulnerability",
            "network",
            "web",
            "honeypot",
        ):
            if any(category in group for group in lowered):
                return category
        return "security-alert"

    @staticmethod
    def _as_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _first(*values: Any) -> str | None:
        return next((str(value) for value in values if value not in (None, "")), None)
