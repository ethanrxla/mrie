"""Normalized security-domain models.

Raw source text is deliberately kept separate from fields used for routing and
policy decisions because every external event may contain hostile instructions.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import IntEnum
from typing import Any


class Severity(IntEnum):
    INFORMATIONAL = 0
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4


@dataclass(frozen=True, slots=True)
class SecurityEvent:
    """Provider-neutral event retained with source provenance."""

    event_id: str
    occurred_at: str
    observed_at: str
    source: str
    source_event_id: str
    category: str
    severity: Severity
    title: str
    asset: str | None = None
    actor: str | None = None
    rule_id: str | None = None
    tags: tuple[str, ...] = ()
    evidence: dict[str, Any] = field(default_factory=dict)
    raw_sha256: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["severity"] = int(self.severity)
        data["tags"] = list(self.tags)
        return data

    @classmethod
    def now(
        cls,
        *,
        source: str,
        source_event_id: str,
        category: str,
        severity: Severity,
        title: str,
        occurred_at: str | None = None,
        raw: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SecurityEvent:
        observed = datetime.now(UTC).isoformat()
        stable_id = hashlib.sha256(f"{source}\0{source_event_id}".encode()).hexdigest()
        raw_sha256 = None
        if raw is not None:
            encoded = json.dumps(raw, sort_keys=True, default=str).encode("utf-8")
            raw_sha256 = hashlib.sha256(encoded).hexdigest()
        return cls(
            event_id=stable_id,
            occurred_at=occurred_at or observed,
            observed_at=observed,
            source=source,
            source_event_id=source_event_id,
            category=category,
            severity=severity,
            title=title,
            raw_sha256=raw_sha256,
            **kwargs,
        )
